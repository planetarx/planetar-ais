// Binary zmesg envelope codec — kept in sync with ../planetar-ui/bridge/zmesg.mjs.
// On-wire (TCP): [4-byte BE length][envelope bytes].
// Envelope: 66-byte fixed LE header + variable fields + payload. See zmesg.h.

import { Buffer } from 'node:buffer';

export const ZMESG_MAGIC = 0x5a4d5347; // "ZMSG" read LE
export const ZMESG_FIXED_HDR = 66;
export const ZMESG_VERSION = 1;

function uuidToBytes(id) {
  const hex = String(id).replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`bad uuid: ${id}`);
  return Buffer.from(hex, 'hex');
}

function toBuf(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v == null) return Buffer.alloc(0);
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  return Buffer.from(JSON.stringify(v), 'utf8');
}

export function encodeEnvelope(env) {
  const topicBuf = toBuf(env.topic);
  const sourceBuf = toBuf(env.source);
  const schemaBuf = toBuf(env.schemaName);
  const corrBuf = toBuf(env.correlationId ?? '');
  const causBuf = toBuf(env.causationId ?? '');
  const payloadBuf = toBuf(env.payload);

  if (topicBuf.length > 256) throw new Error('topic exceeds 256 bytes');

  const headerLen =
    ZMESG_FIXED_HDR + topicBuf.length + sourceBuf.length + schemaBuf.length + corrBuf.length + causBuf.length;
  const total = headerLen + payloadBuf.length;

  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(ZMESG_MAGIC, 0);
  buf.writeUInt8(ZMESG_VERSION, 4);
  buf.writeUInt8(env.flags ?? 0, 5);
  buf.writeUInt16LE(headerLen, 6);
  uuidToBytes(env.id).copy(buf, 8);
  buf.writeBigUInt64LE(BigInt(env.createdAtNs), 24);
  buf.writeBigUInt64LE(BigInt(env.storedAtNs ?? env.createdAtNs), 32);
  buf.writeBigUInt64LE(BigInt(env.publishedAtNs ?? env.createdAtNs), 40);
  buf.writeUInt16LE(topicBuf.length, 48);
  buf.writeUInt16LE(sourceBuf.length, 50);
  buf.writeUInt16LE(schemaBuf.length, 52);
  buf.writeUInt16LE(corrBuf.length, 54);
  buf.writeUInt16LE(causBuf.length, 56);
  buf.writeUInt32LE(env.schemaVersion ?? 1, 58);
  buf.writeUInt32LE(payloadBuf.length, 62);

  let o = ZMESG_FIXED_HDR;
  topicBuf.copy(buf, o); o += topicBuf.length;
  sourceBuf.copy(buf, o); o += sourceBuf.length;
  schemaBuf.copy(buf, o); o += schemaBuf.length;
  corrBuf.copy(buf, o); o += corrBuf.length;
  causBuf.copy(buf, o); o += causBuf.length;
  payloadBuf.copy(buf, o);
  return buf;
}

export function frameTCP(envelopeBuf) {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(envelopeBuf.length, 0);
  return Buffer.concat([len, envelopeBuf]);
}
