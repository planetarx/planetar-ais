// router.test.mjs — one AIS source feeding several operating areas: each
// position goes on the bus once, while chat and fleet events stay per area,
// as they were when each area ran its own planetar-ais process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAreas } from '../src/areas.mjs';
import { createRouter } from '../src/router.mjs';

const NS_PER_MIN = 60_000_000_000n;
const T0 = 1_800_000_000_000_000_000n;

// Inner Harbour: inside both the Victoria and the orca boxes.
const VICTORIA = { lat: 48.42, lon: -123.37 };
// Off Friday Harbor (San Juans): inside the orca box only.
const SAN_JUANS = { lat: 48.53, lon: -123.0 };

function harness(op = 'victoria,orca') {
  const sent = [];
  const recorded = [];
  let nowMs = Number(T0 / 1_000_000n);
  const router = createRouter({
    areas: getAreas(op),
    publish: (m) => sent.push(m),
    recorder: { record: (v) => recorded.push(v) },
    now: () => nowMs,
    chatSummaryMs: 30_000,
    lostAfterMs: 5 * 60_000,
  });
  const vessel = (mmsi, where, min = 0) => ({ mmsi, name: `V${mmsi}`, sog: 5, cog: 90, ...where,
    lastSeenNs: String(T0 + BigInt(min) * NS_PER_MIN) });
  return {
    router, sent, recorded, vessel,
    advance: (min) => { nowMs += min * 60_000; },
    topics: (prefix) => sent.filter((m) => m.topic.startsWith(prefix)),
  };
}

test('getAreas reads a comma list in order and rejects unknown names', () => {
  assert.deepEqual(getAreas('victoria,orca').map((a) => a.serverId), ['pac', 'orca']);
  assert.deepEqual(getAreas(undefined).map((a) => a.serverId), ['pac']);
  assert.throws(() => getAreas('victoria,atlantis'), /atlantis/);
});

test('a position inside both areas is published once, tagged with both', () => {
  const h = harness();
  h.router.onUpdate({ event: 'appeared', kind: 'position', vessel: h.vessel(1, VICTORIA) });
  h.router.onUpdate({ event: 'update', kind: 'position', vessel: h.vessel(1, VICTORIA, 1) });
  const pos = h.topics('vessel.ais.position');
  assert.equal(pos.length, 2);
  assert.equal(pos[0].payload.serverId, 'pac'); // first listed area: the vic map keeps working
  assert.deepEqual(pos[0].payload.areas, ['pac', 'orca']);
  assert.equal(h.recorded.length, 2);
  assert.deepEqual(h.recorded[0].areas, ['pac', 'orca']);
});

test('a position in the orca box only is tagged orca and gets no Victoria chat', () => {
  const h = harness();
  h.router.onUpdate({ event: 'appeared', kind: 'position', vessel: h.vessel(2, SAN_JUANS) });
  const [pos] = h.topics('vessel.ais.position');
  assert.equal(pos.payload.serverId, 'orca');
  assert.deepEqual(pos.payload.areas, ['orca']);
  assert.equal(h.topics('chat.pac.').length, 0);
  assert.ok(h.topics('chat.orca.vessel-2').length > 0);
});

test('chat and fleet events are per area, as with one process per area', () => {
  const h = harness();
  h.router.onUpdate({ event: 'appeared', kind: 'position', vessel: h.vessel(3, VICTORIA) });
  const appeared = h.topics('vessel.ais.fleet').filter((m) => m.payload.event === 'appeared');
  assert.deepEqual(appeared.map((m) => m.payload.serverId).sort(), ['orca', 'pac']);
  assert.deepEqual(appeared.map((m) => m.payload.channelId).sort(), ['orca-v-3', 'pac-v-3']);
  assert.ok(h.topics('chat.pac.vessel-3').length > 0);
  assert.ok(h.topics('chat.orca.vessel-3').length > 0);
});

test('a vessel crossing into the Victoria box appears there then', () => {
  const h = harness();
  h.router.onUpdate({ event: 'appeared', kind: 'position', vessel: h.vessel(4, SAN_JUANS) });
  h.router.onUpdate({ event: 'update', kind: 'position', vessel: h.vessel(4, VICTORIA, 1) });
  const pac = h.topics('vessel.ais.fleet').filter((m) => m.payload.serverId === 'pac');
  assert.equal(pac[0].payload.event, 'appeared');
});

test('a vessel that leaves the Victoria box is lost there but not in orca', () => {
  const h = harness();
  h.router.onUpdate({ event: 'appeared', kind: 'position', vessel: h.vessel(5, VICTORIA) });
  for (let m = 1; m <= 8; m++) {
    h.advance(1);
    h.router.onUpdate({ event: 'update', kind: 'position', vessel: h.vessel(5, SAN_JUANS, m) });
  }
  h.router.sweep();
  const lost = h.topics('vessel.ais.fleet').filter((m) => m.payload.event === 'lost');
  assert.deepEqual(lost.map((m) => m.payload.serverId), ['pac']);
});

test('a single area behaves as before: one serverId, no extra areas', () => {
  const h = harness('victoria');
  h.router.onUpdate({ event: 'appeared', kind: 'position', vessel: h.vessel(6, VICTORIA) });
  const [pos] = h.topics('vessel.ais.position');
  assert.equal(pos.payload.serverId, 'pac');
  assert.deepEqual(pos.payload.areas, ['pac']);
  const fleet = h.topics('vessel.ais.fleet');
  assert.ok(fleet.every((m) => m.payload.serverId === 'pac'));
});

test('a static report before any position lands in the first area', () => {
  const h = harness();
  h.router.onUpdate({ event: 'appeared', kind: 'static', vessel: { mmsi: 7, name: 'X', lat: null, lon: null } });
  assert.equal(h.topics('vessel.ais.position').length, 0);
  const appeared = h.topics('vessel.ais.fleet').filter((m) => m.payload.event === 'appeared');
  assert.deepEqual(appeared.map((m) => m.payload.serverId), ['pac']);
});

test('the first-listed area\'s fleet event goes last, so a store keeping the latest gets the position\'s serverId', () => {
  // planetar-ontology keeps one record per vessel: the last vessel.ais.fleet
  // payload. The vic map seeds from it and filters by serverId.
  const h = harness();
  h.router.onUpdate({ event: 'appeared', kind: 'position', vessel: h.vessel(8, VICTORIA) });
  h.advance(1);
  h.router.onUpdate({ event: 'update', kind: 'position', vessel: h.vessel(8, VICTORIA, 1) });
  h.router.onUpdate({ event: 'static-update', vessel: h.vessel(8, VICTORIA, 1) });
  const fleet = h.topics('vessel.ais.fleet');
  for (const ev of ['appeared', 'update', 'static-update']) {
    const of = fleet.filter((m) => m.payload.event === ev);
    assert.equal(of.at(-1).payload.serverId, 'pac', ev);
  }
});
