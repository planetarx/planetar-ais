// Quick key check — connects to aisstream.io with the Victoria BBox,
// prints the first 3 messages, and exits. Verifies that the key works
// and that vessels are actually being reported for our area before we
// fire up the full publisher.

import WebSocket from 'ws';
import { VICTORIA_BBOX } from '../src/victoria.mjs';

const key = process.env.AISSTREAM_API_KEY;
if (!key) {
  console.error('AISSTREAM_API_KEY not set. Get a free key at https://aisstream.io and:');
  console.error('  export AISSTREAM_API_KEY=...');
  console.error('  node scripts/check-aisstream.mjs');
  process.exit(1);
}

const URL = 'wss://stream.aisstream.io/v0/stream';
console.log(`[check] connecting to ${URL}`);
console.log(`[check] BBox SW=[${VICTORIA_BBOX.sw}] NE=[${VICTORIA_BBOX.ne}]`);

const ws = new WebSocket(URL);
let received = 0;
const start = Date.now();

const timeout = setTimeout(() => {
  if (received === 0) {
    console.error(`[check] no messages in 60s — Victoria is quiet, or the BBox / key is wrong. Try wider area or check key.`);
    process.exit(2);
  }
  console.log(`[check] received ${received} messages in 60s. Key works.`);
  process.exit(0);
}, 60_000);

ws.on('open', () => {
  console.log('[check] connected; subscribing');
  ws.send(JSON.stringify({
    APIKey: key,
    BoundingBoxes: [[VICTORIA_BBOX.sw, VICTORIA_BBOX.ne]],
    FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData'],
  }));
});

ws.on('message', (data) => {
  received += 1;
  if (received <= 3) {
    const txt = data.toString();
    try {
      const m = JSON.parse(txt);
      const mmsi = m?.MetaData?.MMSI;
      const name = (m?.MetaData?.ShipName ?? '').trim();
      const type = m.MessageType;
      console.log(`[check] #${received} type=${type} mmsi=${mmsi} name="${name}"`);
    } catch {
      console.log(`[check] #${received} ${txt.slice(0, 200)}`);
    }
  }
  if (received === 3) {
    clearTimeout(timeout);
    const dt = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[check] OK — 3 messages in ${dt}s. Key works for Victoria BBox.`);
    ws.close();
    setTimeout(() => process.exit(0), 100);
  }
});

ws.on('error', (e) => {
  console.error(`[check] ws error: ${e.message}`);
  process.exit(3);
});

ws.on('close', (code, reason) => {
  if (received === 0) {
    console.error(`[check] closed with no messages. code=${code} reason="${reason}"`);
    process.exit(4);
  }
});
