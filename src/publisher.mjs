// TCP producer link to planetar-broker on 12001. Auto-reconnects.

import net from 'node:net';
import { v7 as uuidv7 } from 'uuid';
import { encodeEnvelope, frameTCP } from './zmesg.mjs';

const SOURCE = 'planetar-ais';

export class BrokerPublisher {
  constructor({ host = '127.0.0.1', port = 12001 } = {}) {
    this.host = host;
    this.port = port;
    this.sock = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.onStateChange = () => {};
  }

  start() { this._connect(); }

  isOpen() { return this.connected && this.sock && this.sock.writable; }

  _connect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const sock = net.connect({ host: this.host, port: this.port });
    sock.setNoDelay(true);
    this.sock = sock;

    sock.once('connect', () => {
      this.connected = true;
      console.log(`[publisher] connected to broker ${this.host}:${this.port}`);
      this.onStateChange('open');
    });
    sock.once('close', () => {
      const was = this.connected;
      this.connected = false;
      this.sock = null;
      if (was) {
        console.log('[publisher] disconnected; retrying in 2s');
        this.onStateChange('closed');
      }
      this._scheduleReconnect();
    });
    sock.once('error', (e) => {
      if (this.connected) console.log(`[publisher] error: ${e.message}`);
      try { sock.destroy(); } catch { /* ignore */ }
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, 2000);
  }

  publish({ topic, schemaName, schemaVersion = 1, payload, correlationId = '', causationId = '' }) {
    if (!this.isOpen()) return false;
    const now = String(BigInt(Date.now()) * 1_000_000n);
    try {
      const buf = encodeEnvelope({
        id: uuidv7(),
        topic,
        source: SOURCE,
        schemaName,
        schemaVersion,
        correlationId,
        causationId,
        createdAtNs: now,
        storedAtNs: now,
        publishedAtNs: now,
        payload,
      });
      this.sock.write(frameTCP(buf));
      return true;
    } catch (e) {
      console.log(`[publisher] encode failed: ${e.message}`);
      return false;
    }
  }
}
