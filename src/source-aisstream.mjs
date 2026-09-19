// Real AIS source — aisstream.io WebSocket. Requires AISSTREAM_API_KEY.
// Docs: https://aisstream.io/documentation
//
// Subscribes to the operating area's BBox and converts incoming
// PositionReport / ShipStaticData messages into the same {event, vessel}
// shape the mock source emits, so the rest of the pipeline doesn't know
// the difference.

import WebSocket from 'ws';
import { VICTORIA_BBOX, insideBBox } from './victoria.mjs';

const URL = 'wss://stream.aisstream.io/v0/stream';

// AIS "not available" sentinels (ITU-R M.1371) → null, so a placement client
// never rotates a hull by 511° or dead-reckons a -128 rate of turn.
const hdgOrNull = (h) => (typeof h === 'number' && h >= 0 && h < 360 ? h : null);   // 511 = n/a
const rotOrNull = (r) => (typeof r === 'number' && r !== -128 ? r : null);           // -128 = n/a; ±127 = >10°/min, no sensor
const navOrNull = (n) => (typeof n === 'number' && n >= 0 && n <= 14 ? n : null);   // 15 = not defined
const posOrNull = (x) => (typeof x === 'number' && x > 0 ? x : null);                // 0 = n/a (draught, IMO)

// Static fields that ride along on every later position snapshot.
const STATIC_KEYS = ['dimA', 'dimB', 'dimC', 'dimD', 'beam', 'draught', 'shipTypeCode', 'imo'];
function carryStatic(existing) {
  const out = {};
  for (const k of STATIC_KEYS) out[k] = existing?.[k] ?? null;
  return out;
}

export class AisStreamSource {
  constructor({ apiKey, bbox = VICTORIA_BBOX } = {}) {
    if (!apiKey) throw new Error('AISSTREAM_API_KEY is required for source=aisstream');
    this.apiKey = apiKey;
    this.bbox = bbox;
    this.ws = null;
    this.vesselState = new Map(); // mmsi -> last vessel snapshot we built
    this.onUpdate = () => {};
    this.reconnectTimer = null;
  }

  start() { this._connect(); }

  stop() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) try { this.ws.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  _connect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    console.log('[aisstream] connecting');
    const ws = new WebSocket(URL);
    this.ws = ws;
    ws.on('open', () => {
      console.log('[aisstream] open; subscribing to area BBox');
      ws.send(JSON.stringify({
        APIKey: this.apiKey,
        BoundingBoxes: [[this.bbox.sw, this.bbox.ne]],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData', 'StandardClassBPositionReport'],
      }));
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      this._handle(msg);
    });
    ws.on('close', () => {
      console.log('[aisstream] closed; retrying in 5s');
      this._scheduleReconnect();
    });
    ws.on('error', (e) => {
      console.log(`[aisstream] error: ${e.message}`);
      try { ws.close(); } catch { /* ignore */ }
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._connect(); }, 5000);
  }

  _handle(msg) {
    const meta = msg?.MetaData;
    if (!meta) return;
    const mmsi = meta.MMSI ?? meta.MMSI_String ?? null;
    if (!mmsi) return;

    const type = msg.MessageType;
    let existing = this.vesselState.get(mmsi);
    const firstSeen = !existing;

    if (type === 'PositionReport' || type === 'StandardClassBPositionReport') {
      const pr = msg.Message?.PositionReport ?? msg.Message?.StandardClassBPositionReport;
      if (!pr) return;
      const lat = pr.Latitude;
      const lon = pr.Longitude;
      if (typeof lat !== 'number' || typeof lon !== 'number') return;
      if (!insideBBox(lat, lon, this.bbox)) return; // belt + suspenders; aisstream filtered already

      const classB = type === 'StandardClassBPositionReport';
      const trueHeading = hdgOrNull(pr.TrueHeading);
      const snap = {
        mmsi,
        name: existing?.name ?? meta.ShipName?.trim() ?? `MMSI ${mmsi}`,
        type: existing?.type ?? 'unknown',
        flag: existing?.flag ?? null,
        length: existing?.length ?? null,
        callsign: existing?.callsign ?? null,
        ...carryStatic(existing),
        lat,
        lon,
        sog: pr.Sog ?? 0,                        // knots; 102.3 = n/a passes through (legacy)
        cog: pr.Cog ?? 0,                        // degrees true; 360 = n/a passes through (legacy)
        heading: trueHeading ?? pr.Cog ?? 0,     // legacy: HDG, else COG — always a number
        trueHeading,                             // hull heading, degrees true, or null
        rot: classB ? null : rotOrNull(pr.RateOfTurn),            // raw AIS ROT (-127..127) or null
        navStatus: classB ? null : navOrNull(pr.NavigationalStatus), // 0..14 or null
        aisClass: classB ? 'B' : 'A',
        destination: existing?.destination ?? null,
        lastSeenNs: String(BigInt(Date.now()) * 1_000_000n),
        firstSeenNs: existing?.firstSeenNs ?? String(BigInt(Date.now()) * 1_000_000n),
        inBBox: true,
      };
      this.vesselState.set(mmsi, snap);
      this.onUpdate({ event: firstSeen ? 'appeared' : 'update', kind: 'position', vessel: snap });
      return;
    }

    if (type === 'ShipStaticData') {
      const sd = msg.Message?.ShipStaticData;
      if (!sd) return;
      const dim = dims(sd);
      const next = {
        ...(existing ?? {
          mmsi, lat: 0, lon: 0, sog: 0, cog: 0, heading: 0, inBBox: false,
          trueHeading: null, rot: null, navStatus: null, aisClass: null,
        }),
        name: (sd.Name ?? meta.ShipName ?? `MMSI ${mmsi}`).trim(),
        type: shipTypeName(sd.Type) ?? existing?.type ?? 'unknown',
        shipTypeCode: sd.Type ?? existing?.shipTypeCode ?? null,
        callsign: sd.CallSign?.trim() ?? existing?.callsign ?? null,
        destination: sd.Destination?.trim() ?? existing?.destination ?? null,
        length: dimsLength(sd) ?? existing?.length ?? null,
        ...(dim ?? { dimA: existing?.dimA ?? null, dimB: existing?.dimB ?? null,
                     dimC: existing?.dimC ?? null, dimD: existing?.dimD ?? null,
                     beam: existing?.beam ?? null }),
        draught: posOrNull(sd.MaximumStaticDraught) ?? existing?.draught ?? null,
        imo: posOrNull(sd.ImoNumber) ?? existing?.imo ?? null,
        firstSeenNs: existing?.firstSeenNs ?? String(BigInt(Date.now()) * 1_000_000n),
      };
      this.vesselState.set(mmsi, next);
      if (firstSeen) this.onUpdate({ event: 'appeared', vessel: next });
      else this.onUpdate({ event: 'static-update', vessel: next });
    }
  }
}

// A/B/C/D are metres from the AIS antenna to bow/stern/port/starboard. All
// four zero means "not available" — anything else is a real reference frame
// (A = 0 is legitimate: antenna at the bow).
function dims(sd) {
  const d = sd?.Dimension;
  if (!d) return null;
  const [A, B, C, D] = [d.A ?? 0, d.B ?? 0, d.C ?? 0, d.D ?? 0];
  if (A + B + C + D === 0) return null;
  return { dimA: A, dimB: B, dimC: C, dimD: D, beam: C + D > 0 ? C + D : null };
}

function dimsLength(sd) {
  const dim = sd?.Dimension;
  if (!dim) return null;
  const total = (dim.A ?? 0) + (dim.B ?? 0);
  return total > 0 ? total : null;
}

// AIS ship type codes (ITU-R M.1371) → coarse label.
function shipTypeName(code) {
  if (code == null) return null;
  if (code >= 20 && code <= 29) return 'wing-in-ground';
  if (code === 30) return 'fishing';
  if (code === 31 || code === 32) return 'tug';
  if (code === 33) return 'dredger';
  if (code === 34) return 'dive';
  if (code === 35) return 'military';
  if (code === 36) return 'sailing';
  if (code === 37) return 'pleasure';
  if (code >= 40 && code <= 49) return 'high-speed';
  if (code === 50) return 'pilot';
  if (code === 51) return 'sar';
  if (code === 52) return 'tug';
  if (code >= 60 && code <= 69) return 'passenger';
  if (code >= 70 && code <= 79) return 'cargo';
  if (code >= 80 && code <= 89) return 'tanker';
  return 'other';
}
