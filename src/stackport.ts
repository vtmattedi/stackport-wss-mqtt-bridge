import type { Config } from './config';
import { StatusProtocol } from './protocol';
import { Bridge } from './bridge';
import { log } from './log';

/** Bun-native raw WSS receive-only Stackport client (not Socket.IO). */
export class StackportClient {
  private socket: WebSocket | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private generation = 0;
  private stopped = false;
  private lastFrameMs = 0;
  private lastDataAgeS: number | null = null;
  private ageReceivedMs = 0;
  private live = false;
  constructor(private readonly config: Config, private readonly bridge: Bridge) {}

  start(): void {
    if (this.stopped) return;
    this.open();
    this.watchdog = setInterval(() => this.checkLiveness(), 5000);
  }
  private open(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    const parser = new StatusProtocol(this.config.instance);
    this.live = false;
    this.lastDataAgeS = null;
    this.lastFrameMs = Date.now();
    this.bridge.setSourceConnecting();

    let ws: WebSocket;
    try {
      // Bun-specific WebSocket constructor option; no Origin or query token.
      ws = new WebSocket(this.config.wsUrl, {
        headers: { Authorization: 'Bearer ' + this.config.statusToken },
      });
    } catch {
      this.fail(generation, 'socket_closed');
      return;
    }
    this.socket = ws;
    ws.addEventListener('open', () => {
      if (generation === this.generation && !this.stopped) log('stackport.connected');
    });
    ws.addEventListener('message', event => {
      if (generation !== this.generation || this.stopped) return;
      try {
        if (typeof event.data !== 'string') throw new Error('bad_protocol');
        const frame = parser.accept(event.data);
        this.lastFrameMs = Date.now();
        if (frame.type === 'snapshot') {
          this.live = true;
          this.attempt = 0;
          this.lastDataAgeS = 0;
          this.ageReceivedMs = Date.now();
        }
        if (frame.type === 'update') {
          this.lastDataAgeS = 0;
          this.ageReceivedMs = Date.now();
        }
        if (frame.type === 'heartbeat') {
          this.lastDataAgeS = frame.dataAgeS;
          this.ageReceivedMs = Date.now();
        }
        this.bridge.onFrame(frame);
        this.checkLiveness();
      } catch {
        this.fail(generation, 'bad_protocol');
      }
    });
    ws.addEventListener('close', () => this.fail(generation, 'socket_closed'));
    ws.addEventListener('error', () => this.fail(generation, 'socket_closed'));
  }
  private checkLiveness(): void {
    if (this.stopped || !this.socket) return;
    const now = Date.now();
    if (now - this.lastFrameMs > this.config.silenceTimeoutMs) {
      this.fail(this.generation, 'timeout');
      return;
    }
    if (!this.live) return;
    const dataAge = this.lastDataAgeS === null
      ? null : this.lastDataAgeS * 1000 + (now - this.ageReceivedMs);
    if (dataAge === null || dataAge > this.config.staleAfterMs) {
      this.bridge.setSourceStale();
    } else {
      this.bridge.setSourceHealthy();
    }
  }
  private fail(generation: number, reason: 'socket_closed' | 'timeout' | 'bad_protocol'): void {
    if (generation !== this.generation || this.stopped) return;
    this.generation++;
    const ws = this.socket;
    this.socket = null;
    this.live = false;
    if (ws) {
      try { ws.close(1000); } catch { /* socket may still be connecting */ }
      // Bun client supports terminate() for broken/unresponsive connections.
      try { (ws as WebSocket & { terminate?: () => void }).terminate?.(); } catch { /* closed */ }
    }
    this.bridge.setSourceOffline(reason);
    const bounded = Math.min(this.config.reconnectMaxMs,
      this.config.reconnectMinMs * 2 ** Math.min(this.attempt++, 16));
    const delay = Math.round(bounded * (0.7 + Math.random() * 0.3));
    log('stackport.reconnecting', { reason, delayMs: delay });
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      this.open();
    }, delay);
  }
  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.watchdog) clearInterval(this.watchdog);
    this.reconnect = null;
    this.watchdog = null;
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      try { ws.close(1000); } catch { /* already closed */ }
      try { (ws as WebSocket & { terminate?: () => void }).terminate?.(); } catch { /* already closed */ }
    }
  }
}
