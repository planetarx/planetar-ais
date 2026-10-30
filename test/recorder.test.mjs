import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PositionRecorder } from '../src/recorder.mjs';

const ns = (iso) => String(BigInt(Date.parse(iso)) * 1_000_000n);

test('appends one JSON line per position to a file named by its UTC receive date', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ais-rec-'));
  const rec = new PositionRecorder(dir);
  rec.record({ mmsi: 1, lat: 48.4, lon: -123.4, lastSeenNs: ns('2026-11-01T23:59:59Z') });
  rec.record({ mmsi: 2, lat: 48.5, lon: -123.5, lastSeenNs: ns('2026-11-02T00:00:01Z') });
  rec.record({ mmsi: 3, lat: 48.6, lon: -123.6, lastSeenNs: ns('2026-11-02T02:01:15Z') });
  await rec.close();

  assert.deepEqual(readdirSync(dir).sort(), ['ais-2026-11-01.jsonl', 'ais-2026-11-02.jsonl']);
  const day2 = readFileSync(join(dir, 'ais-2026-11-02.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(day2.map((p) => p.mmsi), [2, 3]);
  assert.equal(day2[1].lat, 48.6);
});
