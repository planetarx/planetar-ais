// AIS from our own receiver — NMEA 0183 !AIVDM sentences over UDP, as sent by
// AIS-catcher (`-u <host> <port>`), rtl-ais, or a marine AIS receiver's
// network output. Decodes ITU-R M.1371 message types 1/2/3 and 18/19
// (positions, class A and B) and 5/24 (static data, class A and B), and emits
// the same {event, vessel} snapshots as AisStreamSource, so the rest of the
// pipeline doesn't know the difference.
//
// A local receiver hears small class B boats (whale-watch zodiacs) and has no
// aggregator gaps, both of which aisstream lacks around Victoria.

import dgram from 'node:dgram';
import { VICTORIA_BBOX, insideAnyBBox } from './victoria.mjs';
import { hdgOrNull, rotOrNull, navOrNull, posOrNull, utcSecOrNull, shipTypeName } from './source-aisstream.mjs';

const SIXBIT_TEXT = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !"#$%&\'()*+,-./0123456789:;<=>?';
const PART_TTL_MS = 10_000; // drop an unfinished multi-sentence message after this

/** Armoured payload → array of bits (0/1). Trailing `fill` bits are padding. */
function toBits(payload, fill) {
  const bits = [];
  for (const ch of payload) {
    let v = ch.charCodeAt(0) - 48;
    if (v > 40) v -= 8;
    for (let i = 5; i >= 0; i--) bits.push((v >> i) & 1);
  }
  return fill ? bits.slice(0, bits.length - fill) : bits;
}

function reader(bits) {
  const u = (start, len) => {
    let v = 0;
    for (let i = start; i < start + len; i++) v = v * 2 + (bits[i] ?? 0);
    return v;
  };
  const s = (start, len) => {
    const v = u(start, len);
    return v >= 2 ** (len - 1) ? v - 2 ** len : v;
  };
  const text = (start, len) => {
    let out = '';
    for (let i = start; i + 6 <= start + len && i + 6 <= bits.length; i += 6) out += SIXBIT_TEXT[u(i, 6)];
    return out.replace(/@.*$/, '').trim() || null;
  };
  return { u, s, text, length: bits.length };
}

const dimsAt = (r, at) => ({ dimA: r.u(at, 9), dimB: r.u(at + 9, 9), dimC: r.u(at + 18, 6), dimD: r.u(at + 24, 6) });

/**
 * One reassembled message → plain fields, raw AIS values (102.3 / 91 / 181 /
 * 360 / 511 / -128 / 60 are the "not available" sentinels), or null for a
 * type we don't use. `{payload, fill}` comes from NmeaAssembler.push.
 */
export function decodePayload(msg) {
  if (!msg) return null;
  const r = reader(toBits(msg.payload, msg.fill));
  const type = r.u(0, 6);
  const mmsi = r.u(8, 30);
  const deg = (v) => v / 600000;
  if (type >= 1 && type <= 3) {
    if (r.length < 149) return null;
    return { type, mmsi, navStatus: r.u(38, 4), rot: r.s(42, 8), sog: r.u(50, 10) / 10,
      posAccuracy: r.u(60, 1) === 1, lon: deg(r.s(61, 28)), lat: deg(r.s(89, 27)),
      cog: r.u(116, 12) / 10, heading: r.u(128, 9), second: r.u(137, 6) };
  }
  if (type === 18 || type === 19) {
    if (r.length < (type === 18 ? 168 : 312)) return null;
    const m = { type, mmsi, sog: r.u(46, 10) / 10, posAccuracy: r.u(56, 1) === 1,
      lon: deg(r.s(57, 28)), lat: deg(r.s(85, 27)), cog: r.u(112, 12) / 10,
      heading: r.u(124, 9), second: r.u(133, 6) };
    if (type === 19) Object.assign(m, { name: r.text(143, 120), shipType: r.u(263, 8), ...dimsAt(r, 271) });
    return m;
  }
  if (type === 5) {
    if (r.length < 420) return null;
    return { type, mmsi, imo: r.u(40, 30), callsign: r.text(70, 42), name: r.text(112, 120),
      shipType: r.u(232, 8), ...dimsAt(r, 240), draught: r.u(294, 8) / 10, destination: r.text(302, 120) };
  }
  if (type === 24) {
    const part = r.u(38, 2);
    if (part === 0) return { type, mmsi, part, name: r.text(40, 120) };
    if (part === 1) return { type, mmsi, part, shipType: r.u(40, 8), callsign: r.text(90, 42), ...dimsAt(r, 132) };
  }
  return null;
}

/** Feeds NMEA lines; returns {payload, fill} once a whole AIS message is in, else null. */
export class NmeaAssembler {
  constructor(now = Date.now) {
    this.now = now;
    this.parts = new Map(); // `${seqId}:${channel}` → {count, got: [], at}
  }

  push(line) {
    const m = /^!(?:[A-Z]{2})VD[MO],(\d),(\d),(\d?),([^,]*),([^,]*),(\d)\*([0-9A-F]{2})\s*$/i.exec(line.trim());
    if (!m) return null;
    const body = line.trim().slice(1, line.trim().indexOf('*'));
    let cs = 0;
    for (const ch of body) cs ^= ch.charCodeAt(0);
    if (cs !== parseInt(m[7], 16)) return null;
    const [count, num, seq, channel, payload, fill] = [Number(m[1]), Number(m[2]), m[3], m[4], m[5], Number(m[6])];
    if (count === 1) return { payload, fill };
    const key = `${seq}:${channel}`;
    const t = this.now();
    for (const [k, p] of this.parts) if (t - p.at > PART_TTL_MS) this.parts.delete(k);
    if (num === 1) this.parts.set(key, { count, got: [payload], at: t });
    const p = this.parts.get(key);
    if (!p || num !== p.got.length + 1 || p.count !== count) {
      if (num !== 1) this.parts.delete(key);
      return null;
    }
    if (num > 1) p.got.push(payload);
    if (p.got.length < count) return null;
    this.parts.delete(key);
    return { payload: p.got.join(''), fill };
  }
}

const nowNs = () => String(BigInt(Date.now()) * 1_000_000n);
const dimFields = (m) => (m.dimA + m.dimB + m.dimC + m.dimD === 0 ? null : {
  dimA: m.dimA, dimB: m.dimB, dimC: m.dimC, dimD: m.dimD,
  beam: m.dimC + m.dimD > 0 ? m.dimC + m.dimD : null,
});
const lengthOf = (m) => (m.dimA + m.dimB > 0 ? m.dimA + m.dimB : null);

export class NmeaUdpSource {
  constructor({ port = 10110, host = '0.0.0.0', bbox = VICTORIA_BBOX, bboxes = [bbox] } = {}) {
    this.port = port;
    this.host = host;
    this.bboxes = bboxes;
    this.vesselState = new Map(); // mmsi -> last vessel snapshot
    this.assembler = new NmeaAssembler();
    this.onUpdate = () => {};
    this.sock = null;
  }

  /** Binds the UDP socket; resolves to the bound port. */
  start() {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (buf) => {
      for (const line of buf.toString('latin1').split(/\r?\n/)) {
        const m = decodePayload(this.assembler.push(line));
        if (m) this._handle(m);
      }
    });
    this.sock.on('error', (e) => console.log(`[nmea] socket error: ${e.message}`));
    return new Promise((resolve) => this.sock.bind(this.port, this.host, () => {
      const port = this.sock.address().port;
      console.log(`[nmea] listening for !AIVDM on udp ${this.host}:${port}`);
      resolve(port);
    }));
  }

  stop() {
    if (this.sock) try { this.sock.close(); } catch { /* ignore */ }
    this.sock = null;
  }

  _blank(mmsi) {
    return { mmsi, name: `MMSI ${mmsi}`, type: 'unknown', flag: null, length: null, callsign: null,
      dimA: null, dimB: null, dimC: null, dimD: null, beam: null, draught: null, shipTypeCode: null, imo: null,
      lat: 0, lon: 0, sog: 0, cog: 0, heading: 0, trueHeading: null, rot: null, navStatus: null, aisClass: null,
      aisUtcSecond: null, posAccuracy: null, simulated: false, destination: null, firstSeenNs: nowNs(), inBBox: false };
  }

  _static(existing, m) {
    const dim = m.dimA != null ? dimFields(m) : null;
    return {
      ...(m.name ? { name: m.name } : {}),
      ...(m.shipType != null ? { shipTypeCode: m.shipType, type: shipTypeName(m.shipType) ?? existing.type } : {}),
      ...(m.callsign ? { callsign: m.callsign } : {}),
      ...(dim ? { ...dim, length: lengthOf(m) } : {}),
      ...(m.imo != null && posOrNull(m.imo) ? { imo: m.imo } : {}),
      ...(m.draught != null && posOrNull(m.draught) ? { draught: m.draught } : {}),
      ...(m.destination ? { destination: m.destination } : {}),
    };
  }

  _handle(m) {
    const existing = this.vesselState.get(m.mmsi);
    const firstSeen = !existing;
    const base = existing ?? this._blank(m.mmsi);

    if (m.type === 5 || m.type === 24) {
      const next = { ...base, ...this._static(base, m) };
      this.vesselState.set(m.mmsi, next);
      this.onUpdate({ event: firstSeen ? 'appeared' : 'static-update', vessel: next });
      return;
    }

    if (Math.abs(m.lat) > 90 || Math.abs(m.lon) > 180) return; // 91 / 181 = not available
    if (!insideAnyBBox(m.lat, m.lon, this.bboxes)) return;
    const classB = m.type === 18 || m.type === 19;
    const trueHeading = hdgOrNull(m.heading);
    const snap = {
      ...base,
      ...(m.type === 19 ? this._static(base, m) : {}),
      lat: m.lat,
      lon: m.lon,
      sog: m.sog,                                // knots; 102.3 = n/a passes through (as aisstream)
      cog: m.cog,
      heading: trueHeading ?? m.cog,
      trueHeading,
      rot: classB ? null : rotOrNull(m.rot),
      navStatus: classB ? null : navOrNull(m.navStatus),
      aisClass: classB ? 'B' : 'A',
      aisUtcSecond: utcSecOrNull(m.second),
      posAccuracy: m.posAccuracy,
      simulated: false,
      lastSeenNs: nowNs(),
      inBBox: true,
    };
    this.vesselState.set(m.mmsi, snap);
    this.onUpdate({ event: firstSeen ? 'appeared' : 'update', kind: 'position', vessel: snap });
  }
}
