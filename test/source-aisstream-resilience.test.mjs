// source-aisstream-resilience.test.mjs — reconnect behaviour ported from the
// edit made directly on www0 on 2026-06-24 after aisstream left the feed in
// a silent half-open socket for ~2 days: exponential backoff with jitter,
// an inactivity watchdog, and surfacing aisstream's in-band error messages.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { AisStreamSource } from '../src/source-aisstream.mjs';

const OPEN = 1; // ws.WebSocket.OPEN

function fakeSocket() {
  return { readyState: OPEN, sent: [], terminated: false,
    send(s) { this.sent.push(s); }, terminate() { this.terminated = true; }, close() {} };
}

function quiet(t) {
  const log = mock.method(console, 'log', () => {});
  t.after(() => log.mock.restore());
  return log;
}

test('reconnect delay doubles from 5 s with up to 1 s jitter and caps at 60 s', (t) => {
  quiet(t);
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const src = new AisStreamSource({ apiKey: 't' });
  const delays = [];
  for (let i = 0; i < 6; i++) {
    delays.push(src._scheduleReconnect());
    clearTimeout(src.reconnectTimer); src.reconnectTimer = null; // don't fire _connect
  }
  const bases = [5000, 10000, 20000, 40000, 60000, 60000];
  delays.forEach((d, i) => assert.ok(d >= bases[i] && d < bases[i] + 1000, `attempt ${i}: ${d}`));
});

test('a successful open resets the backoff and starts the inactivity clock', (t) => {
  quiet(t);
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const src = new AisStreamSource({ apiKey: 't' });
  for (let i = 0; i < 4; i++) { src._scheduleReconnect(); clearTimeout(src.reconnectTimer); src.reconnectTimer = null; }
  assert.equal(src.reconnectMs, 60000);
  const ws = fakeSocket();
  src.ws = ws;
  src._onOpen();
  assert.equal(src.reconnectMs, 5000);
  assert.ok(src.lastMsgAt > 0);
  assert.equal(ws.sent.length, 1, 'subscription sent on open');
  assert.equal(JSON.parse(ws.sent[0]).APIKey, 't');
});

test('watchdog terminates a socket that has been silent longer than 90 s', (t) => {
  const log = quiet(t);
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => { src.stop(); mock.timers.reset(); });
  const src = new AisStreamSource({ apiKey: 't' });
  const ws = fakeSocket();
  src.ws = ws;
  src.lastMsgAt = Date.now() - 100_000;
  src._startWatchdog();
  mock.timers.tick(30_000);
  assert.equal(ws.terminated, true);
  assert.ok(log.mock.calls.some((c) => /forcing reconnect/.test(String(c.arguments[0]))));
});

test('watchdog leaves a socket alone while data is flowing', (t) => {
  quiet(t);
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => { src.stop(); mock.timers.reset(); });
  const src = new AisStreamSource({ apiKey: 't' });
  const ws = fakeSocket();
  src.ws = ws;
  src.lastMsgAt = Date.now() - 10_000;
  src._startWatchdog();
  mock.timers.tick(30_000);
  assert.equal(ws.terminated, false);
});

test('in-band aisstream error messages are logged and never reach _handle', (t) => {
  const log = quiet(t);
  const src = new AisStreamSource({ apiKey: 't' });
  const handled = mock.method(src, '_handle');
  src._onMessage(Buffer.from(JSON.stringify({ error: 'Api Key Is Not Valid' })));
  assert.equal(handled.mock.callCount(), 0);
  assert.ok(log.mock.calls.some((c) => /server: Api Key Is Not Valid/.test(String(c.arguments[0]))));
});

test('a normal message reaches _handle and feeds the inactivity clock', (t) => {
  quiet(t);
  const src = new AisStreamSource({ apiKey: 't' });
  const msg = { MessageType: 'PositionReport', MetaData: { MMSI: 316016131 },
    Message: { PositionReport: { Latitude: 48.42, Longitude: -123.37, Sog: 1, Cog: 10 } } };
  src._onMessage(Buffer.from(JSON.stringify(msg)));
  assert.ok(src.vesselState.has(316016131));
  assert.ok(src.lastMsgAt > 0);
});

test('a close event schedules a reconnect', (t) => {
  quiet(t);
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const src = new AisStreamSource({ apiKey: 't' });
  src._onClose(1006);
  assert.ok(src.reconnectTimer, 'reconnect timer armed');
  clearTimeout(src.reconnectTimer); src.reconnectTimer = null;
});
