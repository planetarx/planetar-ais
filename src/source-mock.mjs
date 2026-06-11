// Synthetic AIS source. Spawns a seed fleet inside an operating area's
// bounding box, advances each vessel along a plausible bearing, and fires
// emit() on each tick. Good for demos without an external feed.
//
// The source is area-agnostic: pass { bbox, center, seedVessels, ... } from
// areas.mjs. With no args it falls back to the Victoria fleet so older
// callers keep working.
//
// Seed vessels may carry two demo flags:
//   anchored  — vessel barely moves; rides at low speed near the area's
//               anchorage point. This is what builds "the blockage".
//   darkProne — vessel drops AIS far more often than normal traffic — the
//               shadow-fleet behaviour the dark-vessel demo hunts for.

import { insideBBox } from './victoria.mjs';
import { AREAS, VICTORIA_FLEET } from './areas.mjs';

function randAround(center, spread = 0.18) {
  return {
    lat: center.lat + (Math.random() - 0.5) * spread,
    lon: center.lon + (Math.random() - 0.5) * spread,
  };
}

// Typical speeds (knots) per vessel class.
const SPEED_RANGE = {
  cargo:     [10, 18],
  tanker:    [10, 16],
  bulk:      [ 9, 14],
  container: [14, 23],
  ferry:     [14, 22],
  fishing:   [ 2, 10],
  pleasure:  [ 4, 12],
  sailing:   [ 3,  8],
  pilot:     [ 6, 14],
  tug:       [ 5, 12],
  patrol:    [ 8, 32],
  military:  [10, 26],
  default:   [ 5, 12],
};

function pickInitialSpeed(type) {
  const [lo, hi] = SPEED_RANGE[type] ?? SPEED_RANGE.default;
  return lo + Math.random() * (hi - lo);
}

function destinationsFor(type) {
  switch (type) {
    case 'ferry':   return ['SWARTZ BAY', 'TSAWWASSEN', 'PORT ANGELES', 'VICTORIA'];
    case 'cargo':   return ['VANCOUVER', 'SEATTLE', 'PRINCE RUPERT', 'TACOMA'];
    case 'tanker':  return ['CHERRY POINT', 'BURNABY', 'ANACORTES'];
    case 'fishing': return ['NANAIMO', 'SOOKE', 'STEVESTON'];
    case 'pleasure':
    case 'sailing': return ['SIDNEY', 'OAK BAY', 'BEDWELL HARBOUR', 'GENOA BAY'];
    case 'pilot':   return ['PILOT STATION'];
    case 'tug':     return ['NANAIMO', 'POINT ROBERTS'];
    default:        return ['UNKNOWN'];
  }
}

export class MockAisSource {
  constructor({
    tickMs = 3000,
    bbox = AREAS.victoria.bbox,
    center = AREAS.victoria.center,
    seedVessels = VICTORIA_FLEET,
    anchorage = null,
    spread = 0.18,
  } = {}) {
    this.tickMs = tickMs;
    this.bbox = bbox;
    this.center = center;
    this.anchorage = anchorage ?? center;
    this.spread = spread;
    this.vessels = new Map();
    this.timer = null;
    this.onUpdate = () => {};
    for (const seed of seedVessels) this._spawn(seed);
  }

  // Reflect a position back inside this area's bounding box.
  _clampBBox(lat, lon) {
    let nlat = lat, nlon = lon, reflect = false;
    const b = this.bbox;
    if (nlat < b.sw[0]) { nlat = b.sw[0] + (b.sw[0] - nlat); reflect = true; }
    if (nlat > b.ne[0]) { nlat = b.ne[0] - (nlat - b.ne[0]); reflect = true; }
    if (nlon < b.sw[1]) { nlon = b.sw[1] + (b.sw[1] - nlon); reflect = true; }
    if (nlon > b.ne[1]) { nlon = b.ne[1] - (nlon - b.ne[1]); reflect = true; }
    return { lat: nlat, lon: nlon, reflected: reflect };
  }

  _spawn(seed) {
    const anchored = !!seed.anchored;
    // Anchored vessels cluster tightly at the anchorage — that knot of
    // stalled ships is the blockage. Everything else fans out from center.
    const start = anchored
      ? randAround(this.anchorage, 0.10)
      : randAround(this.center, this.spread);
    const v = {
      ...seed,
      anchored,
      darkProne: !!seed.darkProne,
      lat: start.lat,
      lon: start.lon,
      sog: anchored ? Math.random() * 0.8 : (seed.sog ?? pickInitialSpeed(seed.type)),
      cog: Math.random() * 360,               // degrees true
      heading: Math.random() * 360,
      destination: seed.destination ?? destinationsFor(seed.type)[0],
      lastSeenNs: BigInt(Date.now()) * 1_000_000n,
      firstSeenNs: BigInt(Date.now()) * 1_000_000n,
      dark: false,                            // when true, skip emit for N ticks (AIS gap)
      darkTicksLeft: 0,
      anomaly: null,
    };
    this.vessels.set(seed.mmsi, v);
  }

  start() {
    if (this.timer) return;
    // Stagger initial emits so the UI populates over a few seconds.
    let i = 0;
    for (const v of this.vessels.values()) {
      setTimeout(() => this._fireFirstSeen(v), 200 + (i++) * 350);
    }
    this.timer = setInterval(() => this._tick(), this.tickMs);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  _fireFirstSeen(v) {
    this.onUpdate({ event: 'appeared', vessel: this._snapshot(v) });
  }

  _tick() {
    for (const v of this.vessels.values()) this._advance(v);
  }

  _advance(v) {
    // Occasionally drop into "dark" mode to simulate an AIS gap. Shadow-fleet
    // (darkProne) vessels go dark far more readily than honest traffic.
    const darkChance = v.darkProne ? 0.04 : 0.005;
    if (!v.dark && Math.random() < darkChance) {
      v.dark = true;
      v.darkTicksLeft = 10 + Math.floor(Math.random() * 20);
      v.anomaly = 'ais-gap-start';
      this.onUpdate({ event: 'anomaly', kind: 'ais-gap', vessel: this._snapshot(v) });
      return;
    }
    if (v.dark) {
      v.darkTicksLeft -= 1;
      if (v.darkTicksLeft <= 0) {
        v.dark = false;
        v.anomaly = 'ais-gap-end';
        // Resurface with possibly shifted position to make it suspicious.
        v.lat += (Math.random() - 0.5) * 0.02;
        v.lon += (Math.random() - 0.5) * 0.04;
        v.lastSeenNs = BigInt(Date.now()) * 1_000_000n;
        this.onUpdate({ event: 'anomaly', kind: 'ais-resurface', vessel: this._snapshot(v) });
      }
      return; // no position emit while dark
    }

    // Drift the course a little, then advance by tickMs at v.sog knots.
    v.cog = (v.cog + (Math.random() - 0.5) * 8 + 360) % 360;
    v.heading = (v.cog + (Math.random() - 0.5) * 4 + 360) % 360;

    // Random small speed perturbation; rarer big change to drive a chat msg.
    const oldSog = v.sog;
    if (v.anchored) {
      // Anchored vessels only fidget — they swing on the hook, never steam.
      v.sog = Math.max(0, Math.min(1.2, v.sog + (Math.random() - 0.5) * 0.3));
    } else if (Math.random() < 0.015) {
      const [lo, hi] = SPEED_RANGE[v.type] ?? SPEED_RANGE.default;
      v.sog = Math.max(0, lo + Math.random() * (hi - lo));
    } else {
      v.sog = Math.max(0, v.sog + (Math.random() - 0.5) * 0.5);
    }

    // Convert knots → degrees per second (~1 nm = 1/60 deg lat).
    const dtSec = this.tickMs / 1000;
    const distNm = v.sog * (dtSec / 3600);
    const rad = (v.cog * Math.PI) / 180;
    const dLat = (distNm / 60) * Math.cos(rad);
    const dLon = (distNm / 60) * Math.sin(rad) / Math.cos((v.lat * Math.PI) / 180);
    const clamped = this._clampBBox(v.lat + dLat, v.lon + dLon);
    if (clamped.reflected) {
      v.cog = (v.cog + 180) % 360; // reflect off the box edge
      v.heading = v.cog;
    }
    v.lat = clamped.lat;
    v.lon = clamped.lon;
    v.lastSeenNs = BigInt(Date.now()) * 1_000_000n;

    let kind = 'position';
    if (Math.abs(v.sog - oldSog) > 4) {
      v.anomaly = 'speed-change';
      kind = 'speed-change';
    } else {
      v.anomaly = null;
    }

    this.onUpdate({ event: 'update', kind, vessel: this._snapshot(v), prevSog: oldSog });
  }

  _snapshot(v) {
    return {
      mmsi: v.mmsi,
      name: v.name,
      type: v.type,
      flag: v.flag,
      length: v.length,
      callsign: v.callsign,
      lat: v.lat,
      lon: v.lon,
      sog: Number(v.sog.toFixed(2)),
      cog: Number(v.cog.toFixed(1)),
      heading: Number(v.heading.toFixed(1)),
      destination: v.destination,
      lastSeenNs: v.lastSeenNs.toString(),
      firstSeenNs: v.firstSeenNs.toString(),
      inBBox: insideBBox(v.lat, v.lon, this.bbox),
    };
  }
}
