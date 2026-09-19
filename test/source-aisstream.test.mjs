// source-aisstream.test.mjs — the aisstream decoder carries the full AIS
// kinematic + static field set a placement client needs, with AIS
// "not available" sentinels mapped to null instead of leaking through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AisStreamSource } from '../src/source-aisstream.mjs';

const MMSI = 316016131;
const META = { MMSI, ShipName: 'PACIFIC GUARDIAN' };
// Inside the Victoria operating box (Inner Harbour).
const HERE = { Latitude: 48.42, Longitude: -123.37 };

function capture() {
  const src = new AisStreamSource({ apiKey: 'test' });
  const out = [];
  src.onUpdate = (u) => out.push(u);
  return { src, out };
}

const positionReport = (fields) => ({
  MessageType: 'PositionReport',
  MetaData: META,
  Message: { PositionReport: { ...HERE, ...fields } },
});

const classB = (fields) => ({
  MessageType: 'StandardClassBPositionReport',
  MetaData: META,
  Message: { StandardClassBPositionReport: { ...HERE, ...fields } },
});

const staticData = (fields) => ({
  MessageType: 'ShipStaticData',
  MetaData: META,
  Message: { ShipStaticData: { Name: 'PACIFIC GUARDIAN', ...fields } },
});

test('PositionReport: AIS not-available sentinels become null (HDG 511, ROT -128, nav 15)', () => {
  const { src, out } = capture();
  src._handle(positionReport({ Sog: 0.1, Cog: 317.4, TrueHeading: 511, RateOfTurn: -128, NavigationalStatus: 15 }));
  const v = out.at(-1).vessel;
  assert.equal(v.trueHeading, null);
  assert.equal(v.rot, null);
  assert.equal(v.navStatus, null);
  assert.equal(v.aisClass, 'A');
  // Legacy fields keep their old semantics so deployed clients don't break.
  assert.equal(v.heading, 317.4);
  assert.equal(v.cog, 317.4);
  assert.equal(v.sog, 0.1);
});

test('PositionReport: valid HDG, ROT and nav status are carried through', () => {
  const { src, out } = capture();
  src._handle(positionReport({ Sog: 12.3, Cog: 240.0, TrueHeading: 243, RateOfTurn: 12, NavigationalStatus: 0 }));
  const v = out.at(-1).vessel;
  assert.equal(v.trueHeading, 243);
  assert.equal(v.rot, 12);
  assert.equal(v.navStatus, 0);
  assert.equal(v.heading, 243);
});

test('StandardClassBPositionReport: aisClass B, no ROT or nav status', () => {
  const { src, out } = capture();
  src._handle(classB({ Sog: 5.0, Cog: 90.0, TrueHeading: 92 }));
  const v = out.at(-1).vessel;
  assert.equal(v.aisClass, 'B');
  assert.equal(v.trueHeading, 92);
  assert.equal(v.rot, null);
  assert.equal(v.navStatus, null);
});

test('ShipStaticData: dimensions A/B/C/D, beam, draught, ship type code and IMO', () => {
  const { src, out } = capture();
  src._handle(staticData({
    Type: 50, CallSign: 'CFA1', Destination: 'PILOT STN',
    Dimension: { A: 12, B: 7, C: 3, D: 3 }, MaximumStaticDraught: 2.4, ImoNumber: 9123456,
  }));
  const v = out.at(-1).vessel;
  assert.deepEqual([v.dimA, v.dimB, v.dimC, v.dimD], [12, 7, 3, 3]);
  assert.equal(v.length, 19);
  assert.equal(v.beam, 6);
  assert.equal(v.draught, 2.4);
  assert.equal(v.shipTypeCode, 50);
  assert.equal(v.type, 'pilot');
  assert.equal(v.imo, 9123456);
});

test('ShipStaticData: all-zero dimensions, zero draught and zero IMO mean not available', () => {
  const { src, out } = capture();
  src._handle(staticData({ Type: 37, Dimension: { A: 0, B: 0, C: 0, D: 0 }, MaximumStaticDraught: 0, ImoNumber: 0 }));
  const v = out.at(-1).vessel;
  assert.deepEqual([v.dimA, v.dimB, v.dimC, v.dimD, v.beam, v.length], [null, null, null, null, null, null]);
  assert.equal(v.draught, null);
  assert.equal(v.imo, null);
  assert.equal(v.shipTypeCode, 37);
});

test('static fields persist onto later position snapshots', () => {
  const { src, out } = capture();
  src._handle(staticData({ Type: 70, Dimension: { A: 150, B: 50, C: 10, D: 20 }, MaximumStaticDraught: 9.5, ImoNumber: 9000001 }));
  src._handle(positionReport({ Sog: 11, Cog: 100, TrueHeading: 101, RateOfTurn: 0, NavigationalStatus: 0 }));
  const v = out.at(-1).vessel;
  assert.equal(out.at(-1).kind, 'position');
  assert.deepEqual([v.dimA, v.dimB, v.dimC, v.dimD], [150, 50, 10, 20]);
  assert.equal(v.beam, 30);
  assert.equal(v.draught, 9.5);
  assert.equal(v.shipTypeCode, 70);
  assert.equal(v.imo, 9000001);
  assert.equal(v.trueHeading, 101);
});
