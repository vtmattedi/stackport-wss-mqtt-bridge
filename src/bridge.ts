import type { Config } from './config';
import { SECTIONS, type Section, type WireEvent } from './protocol';
import { log } from './log';

export type SourceHealth = 'connecting' | 'online' | 'stale' | 'offline';
export type Reason = 'socket_closed' | 'timeout' | 'stale_data' | 'bad_protocol' | 'auth_failed' | null;
export interface PublishClient {
  connected: boolean;
  publish(topic: string, payload: string, opts: { qos: 1; retain: true }, callback: (error?: Error | null) => void): unknown;
}
interface Pending { generation: number; topic: string; payload: string }
const PUB_OPTIONS = { qos: 1, retain: true } as const;

/**
 * Keeps at most four latest sections, and one in-flight QoS1 publish.
 * No MQTT subscription, offline message backlog, or persistent local state.
 * The broker owns retained state; a new source snapshot forces a full replay.
 */
export class Bridge {
  private brokerConnected = false;
  private generation = 0;
  private acknowledged = new Map<string, string>();
  private pending: Pending | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private values = new Map<Section, string>();
  private fresh = false;
  private fullSync = true;
  private state: SourceHealth = 'connecting';
  private reason: Reason = null;
  private observedAt = new Date().toISOString();
  private sourceAt: string | null = null;
  private dataAgeS: number | null = null;

  constructor(private readonly config: Pick<Config, 'topicBase'>, private readonly publisher: PublishClient) {}
  topic(suffix: string): string { return this.config.topicBase + '/' + suffix; }
  getStatus(): SourceHealth { return this.state; }

  onMqttConnect(): void {
    this.brokerConnected = true;
    this.generation++;
    this.acknowledged.clear();
    this.pending = null;
    this.fullSync = true;
    this.cancelRetry();
    log('mqtt.connected');
    this.kick();
  }
  onMqttDisconnect(): void {
    if (!this.brokerConnected) return;
    this.brokerConnected = false;
    this.generation++;
    this.pending = null;
    this.acknowledged.clear();
    this.fullSync = true;
    this.cancelRetry();
    log('mqtt.disconnected');
  }
  setSourceConnecting(): void {
    this.fresh = false;
    this.setHealth('connecting', null);
  }
  setSourceOffline(reason: Reason = 'socket_closed'): void {
    this.fresh = false;
    this.setHealth('offline', reason);
  }
  setSourceStale(): void {
    if (this.state === 'online') this.setHealth('stale', 'stale_data');
  }
  setSourceHealthy(): void {
    if (this.fresh && this.state === 'stale') this.setHealth('online', null);
  }
  private setHealth(health: SourceHealth, reason: Reason): void {
    if (this.state === health && this.reason === reason) return;
    this.state = health;
    this.reason = reason;
    this.observedAt = new Date().toISOString();
    this.kick();
  }

  onFrame(event: WireEvent): void {
    if (event.type === 'hello') return;
    this.sourceAt = event.at;
    if (event.type === 'snapshot') {
      for (const section of SECTIONS) this.values.set(section, JSON.stringify(event.data[section]));
      // New source connection must overwrite all retained sections, including [].
      this.fresh = true;
      this.fullSync = true;
      for (const section of SECTIONS) this.acknowledged.delete(this.topic('state/' + section));
      this.dataAgeS = 0;
      this.setHealth('online', null);
      this.kick();
    } else if (event.type === 'update') {
      if (!this.fresh) return;
      this.values.set(event.section, JSON.stringify(event.data));
      this.kick();
    } else {
      this.dataAgeS = event.dataAgeS;
      this.observedAt = new Date().toISOString();
      this.kick();
    }
  }
  private sourceMessage(state: SourceHealth): string {
    return JSON.stringify({
      state, observedAt: this.observedAt, sourceAt: this.sourceAt,
      dataAgeS: this.dataAgeS, reason: state === 'connecting' ? null : this.reason,
    });
  }
  private allSectionsAcknowledged(): boolean {
    return SECTIONS.every(section => {
      const key = this.topic('state/' + section);
      return this.values.has(section) && this.acknowledged.get(key) === this.values.get(section);
    });
  }

  private next(): { topic: string; payload: string } | null {
    const bridgeTopic = this.topic('bridge/availability');
    const bridgeOnline = '{"state":"online"}';
    if (this.acknowledged.get(bridgeTopic) !== bridgeOnline) {
      return { topic: bridgeTopic, payload: bridgeOnline };
    }
    const sourceTopic = this.topic('source/availability');
    const initialSync = this.fresh && this.fullSync && !this.allSectionsAcknowledged();
    const provisionalState = initialSync && this.state === 'online' ? 'connecting' : this.state;
    const provisionalPayload = this.sourceMessage(provisionalState);

    // Immediately mark missing/stale source as such; don't synthesize project failures.
    if (provisionalState !== 'online' && this.acknowledged.get(sourceTopic) !== provisionalPayload) {
      return { topic: sourceTopic, payload: provisionalPayload };
    }
    if (this.fresh) {
      for (const section of SECTIONS) {
        const topic = this.topic('state/' + section);
        const payload = this.values.get(section);
        if (payload !== undefined && this.acknowledged.get(topic) !== payload) {
          return { topic, payload };
        }
      }
    }
    if (this.fresh && this.allSectionsAcknowledged()) this.fullSync = false;
    const actualPayload = this.sourceMessage(this.state);
    if (this.acknowledged.get(sourceTopic) !== actualPayload) {
      return { topic: sourceTopic, payload: actualPayload };
    }
    return null;
  }
  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
  private kick(): void {
    if (!this.brokerConnected || !this.publisher.connected || this.pending || this.retryTimer) return;
    const next = this.next();
    if (!next) return;
    // MQTT.js only ever sees one queued QoS1 message while connected.
    const generation = this.generation;
    const pending: Pending = { generation, ...next };
    this.pending = pending;
    try {
      this.publisher.publish(next.topic, next.payload, PUB_OPTIONS, error => {
        if (this.generation !== generation || this.pending !== pending) return;
        this.pending = null;
        if (!error) {
          this.acknowledged.set(next.topic, next.payload);
          this.kick();
        } else {
          log('mqtt.publish_failed', { topic: next.topic });
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.kick();
          }, 3000);
        }
      });
    } catch {
      if (this.pending === pending) this.pending = null;
      log('mqtt.publish_failed', { topic: next.topic });
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.kick();
      }, 3000);
    }
  }
  stop(): void {
    this.brokerConnected = false;
    this.generation++;
    this.pending = null;
    this.cancelRetry();
  }
}
