// source-mock.test.mjs — the synthetic fleet emits the same extended field
// set as the real decoder, so clients built against bb's mock feed see the
// production shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAisSource } from '../src/source-mock.mjs';

test('mock snapshots carry trueHeading, rot, navStatus, aisClass, dims, beam, draught, shipTypeCode, imo', () => {
  const src = new MockAisSource();
  const snaps = [...src.vessels.values()].map((v) => src._snapshot(v));
  assert.ok(snaps.length > 0);
  for (const s of snaps) {
    assert.ok(Number.isFinite(s.trueHeading) && s.trueHeading >= 0 && s.trueHeading < 360, `trueHeading ${s.trueHeading}`);
    assert.equal(s.rot, 0);
    assert.ok([0, 1].includes(s.navStatus), `navStatus ${s.navStatus}`);
    assert.equal(s.aisClass, 'A');
    assert.equal(s.dimA + s.dimB, s.length, 'A+B must equal length');
    assert.equal(s.dimC + s.dimD, s.beam, 'C+D must equal beam');
    assert.ok(s.beam > 0 && s.beam < s.length);
    assert.ok(s.draught > 0);
    assert.ok(Number.isInteger(s.shipTypeCode) && s.shipTypeCode >= 20 && s.shipTypeCode <= 99, `shipTypeCode ${s.shipTypeCode}`);
    assert.equal(s.imo, null);
  }
});
