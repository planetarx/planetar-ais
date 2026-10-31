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
