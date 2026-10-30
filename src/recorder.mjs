// Position recorder — appends every vessel.ais.position snapshot to
// <dir>/ais-YYYY-MM-DD.jsonl (UTC date of receipt), so AIS around a satellite
// pass can be matched against SAR detections later. Enabled by AIS_RECORD_DIR.

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class PositionRecorder {
  constructor(dir) {
    this.dir = dir;
    this.day = null;
    this.stream = null;
    mkdirSync(dir, { recursive: true });
  }

  record(vessel) {
    const ms = vessel.lastSeenNs ? Number(BigInt(vessel.lastSeenNs) / 1_000_000n) : Date.now();
    const day = new Date(ms).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.stream?.end();
      this.stream = createWriteStream(join(this.dir, `ais-${day}.jsonl`), { flags: 'a' });
      this.day = day;
    }
    this.stream.write(JSON.stringify(vessel) + '\n');
  }

  close() {
    return new Promise((resolve) => (this.stream ? this.stream.end(resolve) : resolve()));
  }
}
