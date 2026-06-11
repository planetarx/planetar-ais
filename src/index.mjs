// planetar-ais entry point. Drives an AIS source → planetar-broker.
//
// Three published topics:
//   chat.pac.vessel-<MMSI>   — per-vessel chat channel (rate-limited summaries
//                              + anomaly callouts). One Slack channel per boat.
//   vessel.ais.fleet         — control plane: vessel appeared/updated/lost
//                              events. UI listens here to spawn channel entries.
//   vessel.ais.position      — raw position stream for any downstream consumer
//                              (map view, detector, fusion engine).
//
// Source is selected via AIS_SOURCE=mock|aisstream (default: mock).

import { BrokerPublisher } from './publisher.mjs';
import { MockAisSource } from './source-mock.mjs';
import { AisStreamSource } from './source-aisstream.mjs';
import { formatLatLon, nmBetween } from './victoria.mjs';
import { getArea } from './areas.mjs';

const SOURCE = (process.env.AIS_SOURCE ?? 'mock').toLowerCase();
const BROKER_HOST = process.env.BROKER_HOST ?? '127.0.0.1';
const BROKER_PUB_PORT = Number(process.env.BROKER_PUB_PORT ?? 12001);
const CHAT_SUMMARY_MS = Number(process.env.CHAT_SUMMARY_MS ?? 30_000);
const LOST_AFTER_MS = Number(process.env.LOST_AFTER_MS ?? 5 * 60_000);

// Operating area — OP=victoria (default) | OP=hormuz. Selects the bounding
// box, the mock fleet, and the planetar-ui server ("Operation") that this
// service's vessels land in.
const area = getArea(process.env.OP);
const SERVER_ID = area.serverId; // matches planetar-ui servers[].id

const publisher = new BrokerPublisher({ host: BROKER_HOST, port: BROKER_PUB_PORT });
publisher.start();

const source = SOURCE === 'aisstream'
  ? new AisStreamSource({ apiKey: process.env.AISSTREAM_API_KEY, bbox: area.bbox })
  : new MockAisSource({
      tickMs: Number(process.env.MOCK_TICK_MS ?? 3000),
      bbox: area.bbox,
      center: area.center,
      anchorage: area.anchorage,
      spread: area.spread,
      seedVessels: area.fleet,
    });

console.log(`[planetar-ais] op=${area.name} (${area.label}) server=${SERVER_ID} source=${SOURCE} broker=${BROKER_HOST}:${BROKER_PUB_PORT}`);

// Per-vessel rate-limit state for chat summaries.
const lastChatNs = new Map();           // mmsi -> ns of last chat post
const lastPosForLog = new Map();        // mmsi -> {lat,lon} of last logged spot
const known = new Set();                // mmsi we've already announced

function vesselChannelName(mmsi) { return `vessel-${mmsi}`; }
function vesselChatTopic(mmsi)    { return `chat.${SERVER_ID}.vessel-${mmsi}`; }

function chatMessage(text, persona) {
  return { text, author: persona };
}

const AGENT_AIS = { id: 'agent-ais', name: 'ais', role: 'agent' };

function postVesselChat(mmsi, text) {
  publisher.publish({
    topic: vesselChatTopic(mmsi),
    schemaName: 'chat.v1.Message',
    payload: chatMessage(text, AGENT_AIS),
  });
}

function publishFleet(event, vessel) {
  publisher.publish({
    topic: 'vessel.ais.fleet',
    schemaName: 'vessel.ais.Fleet.v1',
    payload: {
      event,                                  // 'appeared' | 'update' | 'static-update' | 'lost' | 'anomaly'
      mmsi: vessel.mmsi,
      channelId: `${SERVER_ID}-v-${vessel.mmsi}`,
      channelName: vesselChannelName(vessel.mmsi),
      serverId: SERVER_ID,
      topic: vesselChatTopic(vessel.mmsi),
      vessel,
    },
  });
}

function publishPosition(vessel) {
  publisher.publish({
    topic: 'vessel.ais.position',
    schemaName: 'vessel.ais.Position.v1',
    // serverId tags the position with its Operation so the UI map can scope
    // to one Operation when several planetar-ais processes share a broker.
    payload: { ...vessel, serverId: SERVER_ID },
  });
}

function announceAppeared(vessel) {
  const txt = `first AIS contact · ${vessel.name ?? 'unknown'} (${vessel.type ?? '—'}, ${vessel.flag ?? '?'}) at ${formatLatLon(vessel.lat, vessel.lon)} · ${vessel.sog.toFixed(1)} kn ${Math.round(vessel.cog)}°`;
  postVesselChat(vessel.mmsi, txt);
  if (vessel.destination) {
    postVesselChat(vessel.mmsi, `bound for ⟦${vessel.destination}⟧`);
  }
  lastChatNs.set(vessel.mmsi, Date.now());
  lastPosForLog.set(vessel.mmsi, { lat: vessel.lat, lon: vessel.lon });
}

function maybeSummary(vessel) {
  const now = Date.now();
  const last = lastChatNs.get(vessel.mmsi) ?? 0;
  if (now - last < CHAT_SUMMARY_MS) return;
  const prev = lastPosForLog.get(vessel.mmsi);
  let suffix = '';
  if (prev) {
    const nm = nmBetween(prev.lat, prev.lon, vessel.lat, vessel.lon);
    suffix = ` · ran ${nm.toFixed(2)} nm since last`;
  }
  postVesselChat(
    vessel.mmsi,
    `position ${formatLatLon(vessel.lat, vessel.lon)} · ${vessel.sog.toFixed(1)} kn ${Math.round(vessel.cog)}°${suffix}`,
  );
  lastChatNs.set(vessel.mmsi, now);
  lastPosForLog.set(vessel.mmsi, { lat: vessel.lat, lon: vessel.lon });
}

source.onUpdate = ({ event, kind, vessel, prevSog }) => {
  if (!vessel?.mmsi) return;

  if (event === 'appeared' || !known.has(vessel.mmsi)) {
    known.add(vessel.mmsi);
    publishFleet('appeared', vessel);
    announceAppeared(vessel);
    return;
  }

  if (event === 'static-update') {
    publishFleet('static-update', vessel);
    postVesselChat(
      vessel.mmsi,
      `static data updated · name=${vessel.name ?? '—'} type=${vessel.type ?? '—'}${vessel.destination ? ` dest=${vessel.destination}` : ''}`,
    );
    return;
  }

  if (event === 'anomaly') {
    publishFleet('anomaly', vessel);
    if (kind === 'ais-gap') {
      postVesselChat(vessel.mmsi, `⚠ AIS gap started · last fix ${formatLatLon(vessel.lat, vessel.lon)} · went dark at ${vessel.sog.toFixed(1)} kn`);
    } else if (kind === 'ais-resurface') {
      postVesselChat(vessel.mmsi, `⚠ AIS resumed at ${formatLatLon(vessel.lat, vessel.lon)} — review for re-id`);
    }
    return;
  }

  // 'update' / position tick
  publishPosition(vessel);
  publishFleet('update', vessel);

  if (kind === 'speed-change' && typeof prevSog === 'number') {
    postVesselChat(
      vessel.mmsi,
      `speed change · ${prevSog.toFixed(1)} → ${vessel.sog.toFixed(1)} kn at ${formatLatLon(vessel.lat, vessel.lon)}`,
    );
    lastChatNs.set(vessel.mmsi, Date.now());
    lastPosForLog.set(vessel.mmsi, { lat: vessel.lat, lon: vessel.lon });
    return;
  }

  maybeSummary(vessel);
};

source.start();

// Sweep for vessels that have stopped reporting → emit 'lost' fleet events.
setInterval(() => {
  const cutoff = BigInt(Date.now() - LOST_AFTER_MS) * 1_000_000n;
  for (const mmsi of known) {
    // For mock source we can introspect; for aisstream we rely on the
    // stream's vesselState. Both expose a `vessels`-ish map by mmsi.
    const v = source.vessels?.get?.(mmsi) ?? source.vesselState?.get?.(mmsi);
    if (!v) continue;
    const lastSeen = BigInt(v.lastSeenNs ?? 0);
    if (lastSeen > 0n && lastSeen < cutoff) {
      publishFleet('lost', v);
      postVesselChat(mmsi, `⚠ no AIS contact for ${Math.round(LOST_AFTER_MS / 60_000)} min — marking lost`);
      known.delete(mmsi);
    }
  }
}, 30_000);

process.on('SIGINT', () => {
  console.log('[planetar-ais] shutting down');
  try { source.stop?.(); } catch { /* ignore */ }
  process.exit(0);
});
