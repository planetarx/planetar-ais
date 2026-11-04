// One AIS source → the bus, for one or more operating areas.
//
// Each position goes on vessel.ais.position ONCE, tagged with
//   serverId — the first listed area that holds it (the planetar-ui map scopes
//              by this, so OP=victoria,orca keeps Victoria boats on `pac`)
//   areas    — every listed area that holds it
// Chat channels (chat.<serverId>.vessel-<MMSI>) and vessel.ais.fleet events
// stay per area, exactly as when each area ran its own planetar-ais process:
// a vessel "appears" in an area when it is first seen inside it, and is
// "lost" there after lostAfterMs without a fix inside it.

import { formatLatLon, insideBBox, nmBetween } from './victoria.mjs';

const AGENT_AIS = { id: 'agent-ais', name: 'ais', role: 'agent' };

export function createRouter({ areas, publish, recorder = null, now = Date.now,
  chatSummaryMs = 30_000, lostAfterMs = 5 * 60_000 }) {
  // Per area: mmsi → state. `lastInNs` is the last fix inside that area.
  const perArea = new Map(areas.map((a) => [a.serverId, new Map()]));
  const lastVessel = new Map(); // mmsi → latest snapshot (for 'lost')

  const hasFix = (v) => Number.isFinite(v.lat) && Number.isFinite(v.lon);
  const chatTopic = (area, mmsi) => `chat.${area.serverId}.vessel-${mmsi}`;

  /** Areas this update belongs to. No fix (or a fix in none of them): where
   *  the vessel is already known, else the first area — the single-area
   *  behaviour before the router. */
  function areasFor(v) {
    if (hasFix(v)) {
      const inside = areas.filter((a) => insideBBox(v.lat, v.lon, a.bbox));
      if (inside.length) return inside;
    }
    const known = areas.filter((a) => perArea.get(a.serverId).has(v.mmsi));
    return known.length ? known : [areas[0]];
  }

  function chat(area, mmsi, text) {
    publish({ topic: chatTopic(area, mmsi), schemaName: 'chat.v1.Message',
      payload: { text, author: AGENT_AIS } });
  }

  function fleet(area, event, vessel) {
    publish({
      topic: 'vessel.ais.fleet',
      schemaName: 'vessel.ais.Fleet.v1',
      payload: {
        event, // 'appeared' | 'update' | 'static-update' | 'lost' | 'anomaly'
        mmsi: vessel.mmsi,
        channelId: `${area.serverId}-v-${vessel.mmsi}`,
        channelName: `vessel-${vessel.mmsi}`,
        serverId: area.serverId,
        topic: chatTopic(area, vessel.mmsi),
        vessel,
      },
    });
  }

  function position(vessel, inAreas) {
    const ids = inAreas.map((a) => a.serverId);
    const payload = { ...vessel, serverId: ids[0], areas: ids };
    recorder?.record(payload);
    publish({ topic: 'vessel.ais.position', schemaName: 'vessel.ais.Position.v1', payload });
  }

  function announce(area, st, vessel) {
    chat(area, vessel.mmsi, `first AIS contact · ${vessel.name ?? 'unknown'} (${vessel.type ?? '—'}, ${vessel.flag ?? '?'}) at ${formatLatLon(vessel.lat, vessel.lon)} · ${(vessel.sog ?? 0).toFixed(1)} kn ${Math.round(vessel.cog ?? 0)}°`);
    if (vessel.destination) chat(area, vessel.mmsi, `bound for ⟦${vessel.destination}⟧`);
    st.lastChatMs = now();
    st.lastLog = { lat: vessel.lat, lon: vessel.lon };
  }

  function summary(area, st, vessel) {
    if (now() - st.lastChatMs < chatSummaryMs) return;
    let suffix = '';
    if (st.lastLog && hasFix(st.lastLog)) {
      suffix = ` · ran ${nmBetween(st.lastLog.lat, st.lastLog.lon, vessel.lat, vessel.lon).toFixed(2)} nm since last`;
    }
    chat(area, vessel.mmsi, `position ${formatLatLon(vessel.lat, vessel.lon)} · ${vessel.sog.toFixed(1)} kn ${Math.round(vessel.cog)}°${suffix}`);
    st.lastChatMs = now();
    st.lastLog = { lat: vessel.lat, lon: vessel.lon };
  }

  function onUpdate({ event, kind, vessel, prevSog }) {
    if (!vessel?.mmsi) return;
    lastVessel.set(vessel.mmsi, vessel);
    const inAreas = areasFor(vessel);
    const positional = event !== 'static-update' && event !== 'anomaly'
      && (event !== 'appeared' || kind === 'position');
    if (positional) position(vessel, inAreas);
    const seenNs = BigInt(vessel.lastSeenNs ?? BigInt(now()) * 1_000_000n);

    for (const area of inAreas) {
      const states = perArea.get(area.serverId);
      let st = states.get(vessel.mmsi);
      if (!st || event === 'appeared') {
        st = { lastChatMs: 0, lastLog: null, lastInNs: seenNs };
        states.set(vessel.mmsi, st);
        fleet(area, 'appeared', vessel);
        announce(area, st, vessel);
        continue;
      }
      if (positional) st.lastInNs = seenNs;

      if (event === 'static-update') {
        fleet(area, 'static-update', vessel);
        chat(area, vessel.mmsi, `static data updated · name=${vessel.name ?? '—'} type=${vessel.type ?? '—'}${vessel.destination ? ` dest=${vessel.destination}` : ''}`);
        continue;
      }
      if (event === 'anomaly') {
        fleet(area, 'anomaly', vessel);
        if (kind === 'ais-gap') {
          chat(area, vessel.mmsi, `⚠ AIS gap started · last fix ${formatLatLon(vessel.lat, vessel.lon)} · went dark at ${vessel.sog.toFixed(1)} kn`);
        } else if (kind === 'ais-resurface') {
          chat(area, vessel.mmsi, `⚠ AIS resumed at ${formatLatLon(vessel.lat, vessel.lon)} — review for re-id`);
        }
        continue;
      }
      fleet(area, 'update', vessel);
      if (kind === 'speed-change' && typeof prevSog === 'number') {
        chat(area, vessel.mmsi, `speed change · ${prevSog.toFixed(1)} → ${vessel.sog.toFixed(1)} kn at ${formatLatLon(vessel.lat, vessel.lon)}`);
        st.lastChatMs = now();
        st.lastLog = { lat: vessel.lat, lon: vessel.lon };
        continue;
      }
      summary(area, st, vessel);
    }
  }

  /** Mark vessels lost in an area after lostAfterMs without a fix inside it. */
  function sweep() {
    const cutoff = BigInt(now() - lostAfterMs) * 1_000_000n;
    for (const area of areas) {
      const states = perArea.get(area.serverId);
      for (const [mmsi, st] of states) {
        if (st.lastInNs > 0n && st.lastInNs < cutoff) {
          fleet(area, 'lost', lastVessel.get(mmsi) ?? { mmsi });
          chat(area, mmsi, `⚠ no AIS contact for ${Math.round(lostAfterMs / 60_000)} min — marking lost`);
          states.delete(mmsi);
        }
      }
    }
  }

  return { onUpdate, sweep };
}
