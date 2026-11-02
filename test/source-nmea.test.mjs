// AIS from our own receiver: AIS-catcher (or any decoder) → NMEA 0183 !AIVDM over UDP.
// Reference sentences were encoded and round-tripped with pyais 2.x (an independent
// implementation): test/fixtures/pyais-vectors.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import dgram from 'node:dgram';

import { decodePayload, NmeaAssembler, NmeaUdpSource } from '../src/source-nmea.mjs';

const VECTORS = JSON.parse(readFileSync(new URL('./fixtures/pyais-vectors.json', import.meta.url), 'utf8'));
const vec = (type, extra = () => true) => VECTORS.find((v) => v.fields.msg_type === type && extra(v.fields));
const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const BBOX = { sw: [48.10, -123.80], ne: [48.85, -122.75] };

/** Re-checksum a sentence with a different talker/formatter, e.g. AIVDO → AIVDM. */
function asVdm(s) {
  const body = s.slice(1, s.indexOf('*')).replace('AIVDO', 'AIVDM');
  let cs = 0;
  for (const ch of body) cs ^= ch.charCodeAt(0);
  return `!${body}*${cs.toString(16).toUpperCase().padStart(2, '0')}`;
}

function assemble(sentences) {
  const a = new NmeaAssembler();
  let out = null;
  for (const s of sentences) out = a.push(s) ?? out;
  return out;
}

test('class A position report (type 1) decodes like pyais', () => {
  const v = vec(1);
  const m = decodePayload(assemble(v.sentences.map(asVdm)));
  assert.equal(m.type, 1);
  assert.equal(m.mmsi, v.fields.mmsi);
  close(m.lat, v.fields.lat); close(m.lon, v.fields.lon);
  assert.equal(m.sog, v.fields.speed);
  assert.equal(m.cog, v.fields.course);
  assert.equal(m.heading, v.fields.heading);
  assert.equal(m.navStatus, v.fields.status);
  assert.equal(m.rot, 0);
  assert.equal(m.second, v.fields.second);
  assert.equal(m.posAccuracy, true);
});

test('"not available" values decode to their raw sentinels (type 3)', () => {
  const v = vec(3);
  const m = decodePayload(assemble(v.sentences));
  assert.equal(m.mmsi, v.fields.mmsi);
  assert.equal(m.sog, 102.3); assert.equal(m.lat, 91); assert.equal(m.lon, 181);
  assert.equal(m.cog, 360); assert.equal(m.heading, 511); assert.equal(m.rot, -128); assert.equal(m.second, 60);
});

test('class B position report (type 18) decodes like pyais', () => {
  const v = vec(18);
  const m = decodePayload(assemble(v.sentences));
  assert.equal(m.type, 18); assert.equal(m.mmsi, v.fields.mmsi);
  close(m.lat, v.fields.lat); close(m.lon, v.fields.lon);
  assert.equal(m.sog, 18.6); assert.equal(m.cog, 95); assert.equal(m.heading, 511); assert.equal(m.second, 7);
});

test('class B extended report (type 19) carries position and name', () => {
  const v = vec(19);
  const m = decodePayload(assemble(v.sentences));
  assert.equal(m.mmsi, v.fields.mmsi); assert.equal(m.name, 'FAST ONE'); assert.equal(m.shipType, 37);
  close(m.lat, v.fields.lat); assert.equal(m.sog, 29.3);
  assert.deepEqual([m.dimA, m.dimB, m.dimC, m.dimD], [3, 5, 1, 1]);
});

test('static and voyage data (type 5) reassembles from two sentences', () => {
  const v = vec(5);
  assert.equal(v.sentences.length, 2);
  const m = decodePayload(assemble(v.sentences));
  assert.equal(m.mmsi, 316039686); assert.equal(m.name, 'SALISH SEA ECLIPSE'); assert.equal(m.callsign, 'CFA1234');
  assert.equal(m.shipType, 60); assert.equal(m.imo, 9876543); assert.equal(m.destination, 'VICTORIA');
  assert.deepEqual([m.dimA, m.dimB, m.dimC, m.dimD], [5, 18, 3, 4]);
  close(m.draught, 2.1);
});

test('class B static data (type 24) parts A and B', () => {
  const a = decodePayload(assemble(vec(24, (f) => f.partno === 0).sentences));
  assert.equal(a.part, 0); assert.equal(a.name, 'SEA LION');
  const b = decodePayload(assemble(vec(24, (f) => f.partno === 1).sentences));
  assert.equal(b.part, 1); assert.equal(b.shipType, 37); assert.equal(b.callsign, 'WDA1234');
  assert.deepEqual([b.dimA, b.dimB, b.dimC, b.dimD], [4, 6, 1, 2]);
});

test('a bad checksum, a lone second part, and junk are dropped', () => {
  const a = new NmeaAssembler();
  const good = vec(1).sentences[0];
  assert.equal(a.push(good.replace(/\*..$/, '*00')), null);
  assert.equal(a.push(vec(5).sentences[1]), null);
  assert.equal(a.push('hello'), null);
  assert.equal(a.push('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47'), null);
});

test('NmeaUdpSource emits aisstream-shaped snapshots and merges class B static parts', async () => {
  const src = new NmeaUdpSource({ port: 0, host: '127.0.0.1', bbox: BBOX });
  const events = [];
  src.onUpdate = (e) => events.push(e);
  const port = await src.start();
  const sock = dgram.createSocket('udp4');
  const send = (lines) => new Promise((r) => sock.send(`${lines.join('\r\n')}\r\n`, port, '127.0.0.1', r));
  await send(vec(24, (f) => f.partno === 0).sentences);
  await send(vec(24, (f) => f.partno === 1).sentences);
  await send(vec(18).sentences);
  await send(vec(3).sentences); // lat 91 / lon 181: no position, ignored
  await new Promise((r) => setTimeout(r, 100));
  sock.close();
  src.stop();
  const pos = events.filter((e) => e.kind === 'position');
  assert.equal(pos.length, 1);
  const v = pos[0].vessel;
  assert.equal(v.mmsi, 338191000); assert.equal(v.name, 'SEA LION'); assert.equal(v.type, 'pleasure');
  assert.equal(v.aisClass, 'B'); assert.equal(v.sog, 18.6); assert.equal(v.trueHeading, null);
  assert.equal(v.rot, null); assert.equal(v.navStatus, null); assert.equal(v.length, 10); assert.equal(v.beam, 3);
  assert.equal(v.simulated, false); assert.equal(v.inBBox, true);
  assert.match(v.lastSeenNs, /^\d{19}$/);
});

test('NmeaUdpSource drops positions outside the area box', async () => {
  const src = new NmeaUdpSource({ port: 0, host: '127.0.0.1', bbox: { sw: [10, 10], ne: [11, 11] } });
  const events = [];
  src.onUpdate = (e) => events.push(e);
  const port = await src.start();
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.send(vec(1).sentences[0], port, '127.0.0.1', r));
  await new Promise((r) => setTimeout(r, 100));
  sock.close();
  src.stop();
  assert.deepEqual(events.filter((e) => e.kind === 'position'), []);
});
