import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getArea } from '../src/areas.mjs';
import { insideBBox } from '../src/victoria.mjs';

test('orca area covers Race Rocks, Haro Strait and Friday Harbor', () => {
  const { bbox, serverId } = getArea('orca');
  assert.equal(serverId, 'orca');
  for (const [lat, lon] of [[48.298, -123.531], [48.55, -123.2], [48.535, -123.013]]) {
    assert.equal(insideBBox(lat, lon, bbox), true, `${lat},${lon}`);
  }
});

test('orca area mock fleet is empty', () => {
  assert.deepEqual(getArea('orca').fleet, []);
});

// One connection, several boxes: sources accept `bboxes` and keep a fix
// inside any of them.
import { AisStreamSource } from '../src/source-aisstream.mjs';

test('aisstream subscribes to every box on one connection and keeps fixes in any of them', () => {
  const boxes = [{ sw: [48.2, -123.7], ne: [48.65, -123.05] }, { sw: [10, 10], ne: [11, 11] }];
  const src = new AisStreamSource({ apiKey: 'k', bboxes: boxes });
  const sent = [];
  src.ws = { send: (s) => sent.push(JSON.parse(s)) };
  src._onOpen();
  assert.deepEqual(sent[0].BoundingBoxes, boxes.map((b) => [b.sw, b.ne]));
  const out = [];
  src.onUpdate = (u) => out.push(u);
  const pr = (Latitude, Longitude) => ({ MessageType: 'PositionReport', MetaData: { MMSI: 1 + out.length },
    Message: { PositionReport: { Latitude, Longitude, Sog: 1, Cog: 1, TrueHeading: 1 } } });
  src._handle(pr(10.5, 10.5));
  src._handle(pr(48.4, -123.4));
  src._handle(pr(0, 0));
  assert.equal(out.length, 2);
});
