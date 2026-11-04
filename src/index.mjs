// planetar-ais entry point. Drives an AIS source → planetar-broker.
//
// Three published topics:
//   chat.<serverId>.vessel-<MMSI> — per-vessel chat channel, per area (rate-limited summaries
//                              + anomaly callouts). One Slack channel per boat.
//   vessel.ais.fleet         — control plane: vessel appeared/updated/lost
//                              events. UI listens here to spawn channel entries.
//   vessel.ais.position      — raw position stream for any downstream consumer
//                              (map view, detector, fusion engine).
//
// Source is selected via AIS_SOURCE=mock|aisstream|nmea (default: mock). nmea
// listens for !AIVDM sentences from our own receiver (e.g. AIS-catcher
// `-u 127.0.0.1 10110`) on NMEA_UDP_HOST:NMEA_UDP_PORT (default 127.0.0.1:10110).
// AIS_RECORD_DIR, when set, also appends every position to a daily JSONL file.

import { BrokerPublisher } from './publisher.mjs';
import { MockAisSource } from './source-mock.mjs';
import { AisStreamSource } from './source-aisstream.mjs';
import { NmeaUdpSource } from './source-nmea.mjs';
import { getAreas } from './areas.mjs';
import { createRouter } from './router.mjs';
import { PositionRecorder } from './recorder.mjs';

const SOURCE = (process.env.AIS_SOURCE ?? 'mock').toLowerCase();
const BROKER_HOST = process.env.BROKER_HOST ?? '127.0.0.1';
const BROKER_PUB_PORT = Number(process.env.BROKER_PUB_PORT ?? 12001);
const CHAT_SUMMARY_MS = Number(process.env.CHAT_SUMMARY_MS ?? 30_000);
const LOST_AFTER_MS = Number(process.env.LOST_AFTER_MS ?? 5 * 60_000);
const recorder = process.env.AIS_RECORD_DIR ? new PositionRecorder(process.env.AIS_RECORD_DIR) : null;

// Operating areas — OP=victoria (default) | OP=hormuz | OP=orca, or a comma
// list (OP=victoria,orca) served from ONE source connection: aisstream
// subscribes to every box at once and each position is published once
// (router.mjs). The mock fleet comes from the first area.
const areas = getAreas(process.env.OP);
const area = areas[0];
const bboxes = areas.map((a) => a.bbox);

const publisher = new BrokerPublisher({ host: BROKER_HOST, port: BROKER_PUB_PORT });
publisher.start();

const source = SOURCE === 'aisstream'
  ? new AisStreamSource({ apiKey: process.env.AISSTREAM_API_KEY, bboxes })
  : SOURCE === 'nmea'
  ? new NmeaUdpSource({ host: process.env.NMEA_UDP_HOST ?? '127.0.0.1',
      port: Number(process.env.NMEA_UDP_PORT ?? 10110), bboxes })
  : new MockAisSource({
      tickMs: Number(process.env.MOCK_TICK_MS ?? 3000),
      bbox: area.bbox,
      center: area.center,
      anchorage: area.anchorage,
      spread: area.spread,
      seedVessels: area.fleet,
    });

console.log(`[planetar-ais] op=${areas.map((a) => a.name).join(',')} servers=${areas.map((a) => a.serverId).join(',')} source=${SOURCE} broker=${BROKER_HOST}:${BROKER_PUB_PORT}${recorder ? ` record=${recorder.dir}` : ''}`);

const router = createRouter({
  areas, recorder,
  publish: (m) => publisher.publish(m),
  chatSummaryMs: CHAT_SUMMARY_MS,
  lostAfterMs: LOST_AFTER_MS,
});
source.onUpdate = (u) => router.onUpdate(u);
source.start();

// Vessels with no fix inside an area for LOST_AFTER_MS → 'lost' there.
setInterval(() => router.sweep(), 30_000);

process.on('SIGINT', () => {
  console.log('[planetar-ais] shutting down');
  try { source.stop?.(); } catch { /* ignore */ }
  process.exit(0);
});
