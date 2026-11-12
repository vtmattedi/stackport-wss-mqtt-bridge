import { describe, expect, test } from 'bun:test';
import { Bridge, type PublishClient } from '../src/bridge';
import type { Snapshot } from '../src/protocol';

type Message = { topic: string; payload: string; callback: (error?: Error | null) => void };
class FakeMqtt implements PublishClient {
  connected = true;
  sent: Array<{ topic: string; payload: string }> = [];
  queued: Message[] = [];
  retained = new Map<string, string>();
  publish(topic: string, payload: string, _opts: { qos: 1; retain: true }, callback: (error?: Error | null) => void) {
    this.sent.push({ topic, payload });
    this.queued.push({ topic, payload, callback });
  }
  ack(): void {
    const next = this.queued.shift();
    if (!next) throw new Error('nothing pending');
    if (next.payload === '') this.retained.delete(next.topic);
    else this.retained.set(next.topic, next.payload);
    next.callback();
  }
  settle(max = 40): void {
    let count = 0;
    while (this.queued.length) {
      if (++count > max) throw new Error('unbounded publish loop');
      this.ack();
    }
  }
}
const prefix = 'stackport/sp-test';
const time = '2026-11-12T00:00:00.000Z';
const snapshot: Snapshot = {
  host: { cpuPercent: 7 },
  projects: [{ id: 7, name: 'Demo', state: 'ready' }],
  actions: [{ id: 'action-1', projectId: 7 }],
  alerts: [],
};
const frame = { type: 'snapshot' as const, at: time, data: snapshot };
function setup() {
  const mqtt = new FakeMqtt();
  mqtt.retained.set(prefix + '/bridge/availability', '{"state":"online"}');
  mqtt.retained.set(prefix + '/source/availability', '{"state":"online"}');
  const bridge = new Bridge({ topicBase: prefix }, mqtt);
  bridge.onMqttConnect();
  mqtt.settle();
  return { mqtt, bridge };
}
describe('retained MQTT v0 bridge', () => {
  test('publishes full snapshot, stable project IDs, then source online only after PUBACKs', () => {
    const { mqtt, bridge } = setup();
    bridge.onFrame(frame);
    expect(mqtt.queued[0].topic).toBe(prefix + '/status');
    mqtt.settle();
    expect(JSON.parse(mqtt.retained.get(prefix + '/state/projects')!)[0].id).toBe(7);
    expect(mqtt.retained.get(prefix + '/state/alerts')).toBe('[]');
    const state = JSON.parse(mqtt.retained.get(prefix + '/status')!);
    expect(state.state).toBe('online');
    const stateWrites = mqtt.sent.filter(s => s.topic.startsWith(prefix + '/state/'));
    expect(stateWrites).toHaveLength(4);
    expect(mqtt.sent.at(-1)!.topic).toBe(prefix + '/status');
    expect(mqtt.retained.has(prefix + '/bridge/availability')).toBe(false);
    expect(mqtt.retained.has(prefix + '/source/availability')).toBe(false);
  });
  test('legacy availability is cleared before unified status is published', () => {
    const { mqtt } = setup();
    expect(mqtt.sent.slice(0, 2)).toEqual([
      { topic: prefix + '/bridge/availability', payload: '' },
      { topic: prefix + '/source/availability', payload: '' },
    ]);
    expect(mqtt.sent[2].topic).toBe(prefix + '/status');
  });
  test('the status stays connecting until every section receives PUBACK', () => {
    const { mqtt, bridge } = setup();
    bridge.onFrame(frame);
    mqtt.ack(); // connecting status with a pending synchronization
    for (let i = 0; i < 4; i++) mqtt.ack();
    expect(JSON.parse(mqtt.retained.get(prefix + '/status')!).state).toBe('connecting');
    expect(mqtt.queued[0].topic).toBe(prefix + '/status');
    mqtt.ack();
    expect(JSON.parse(mqtt.retained.get(prefix + '/status')!).state).toBe('online');
  });
  test('legacy tombstones are replayed after an MQTT reconnection', () => {
    const { mqtt, bridge } = setup();
    mqtt.retained.set(prefix + '/bridge/availability', 'old');
    mqtt.retained.set(prefix + '/source/availability', 'old');
    mqtt.connected = false;
    bridge.onMqttDisconnect();
    mqtt.connected = true;
    bridge.onMqttConnect();
    mqtt.settle();
    expect(mqtt.retained.has(prefix + '/bridge/availability')).toBe(false);
    expect(mqtt.retained.has(prefix + '/source/availability')).toBe(false);
  });
  test('heartbeat and timestamp-only updates do not republish status', () => {
    const { mqtt, bridge } = setup();
    bridge.onFrame(frame);
    mqtt.settle();
    const count = mqtt.sent.length;
    bridge.onFrame({ type: 'heartbeat', at: '2026-11-12T00:00:30.000Z', dataAgeS: 1 });
    bridge.onFrame({ type: 'update', at: '2026-11-12T00:00:35.000Z', section: 'projects', data: snapshot.projects });
    mqtt.settle();
    expect(mqtt.sent).toHaveLength(count);
  });
  test('stale status retains last-known project state and recovers', () => {
    const { mqtt, bridge } = setup();
    bridge.onFrame(frame);
    mqtt.settle();
    bridge.setSourceStale();
    mqtt.settle();
    expect(JSON.parse(mqtt.retained.get(prefix + '/status')!)).toMatchObject({ state: 'stale', reason: 'stale_data' });
    expect(JSON.parse(mqtt.retained.get(prefix + '/state/projects')!)[0].state).toBe('ready');
    bridge.setSourceHealthy();
    mqtt.settle();
    expect(JSON.parse(mqtt.retained.get(prefix + '/status')!).state).toBe('online');
  });
  test('only changed section republished; empty array removes resolved actions', () => {
    const { mqtt, bridge } = setup();
    bridge.onFrame(frame);
    mqtt.settle();
    const prior = mqtt.sent.length;
    bridge.onFrame({ type: 'update', at: time, section: 'projects', data: snapshot.projects });
    mqtt.settle();
    expect(mqtt.sent.slice(prior).filter(s => s.topic.startsWith(prefix + '/state/'))).toHaveLength(0);
    bridge.onFrame({ type: 'update', at: time, section: 'actions', data: [] });
    mqtt.settle();
    expect(mqtt.retained.get(prefix + '/state/actions')).toBe('[]');
    expect(mqtt.retained.get(prefix + '/state/projects')).toBe(JSON.stringify(snapshot.projects));
  });
  test('disconnected source remains last-known without fake project down', () => {
    const { mqtt, bridge } = setup();
    bridge.onFrame(frame);
    mqtt.settle();
    bridge.setSourceOffline('socket_closed');
    mqtt.settle();
    expect(JSON.parse(mqtt.retained.get(prefix + '/status')!).state).toBe('offline');
    expect(JSON.parse(mqtt.retained.get(prefix + '/state/projects')!)[0].state).toBe('ready');
  });
  test('broker reconnect replays latest sections but not every intermediate update', () => {
    const { mqtt, bridge } = setup();
    bridge.onFrame(frame);
    mqtt.settle();
    mqtt.connected = false;
    bridge.onMqttDisconnect();
    bridge.onFrame({ type: 'update', at: time, section: 'projects', data: [{ id: 7, name: 'Demo', state: 'problem' }] });
    bridge.onFrame({ type: 'update', at: time, section: 'projects', data: [{ id: 7, name: 'Demo', state: 'paused' }] });
    expect(mqtt.queued).toHaveLength(0);
    const before = mqtt.sent.length;
    mqtt.connected = true;
    bridge.onMqttConnect();
    mqtt.settle();
    const changes = mqtt.sent.slice(before).filter(x => x.topic === prefix + '/state/projects');
    expect(changes).toHaveLength(1);
    expect(JSON.parse(changes[0].payload)[0].state).toBe('paused');
  });
  test('coalesces updates while waiting for PUBACK', () => {
    const { mqtt, bridge } = setup();
    bridge.onFrame(frame);
    mqtt.settle();
    const previous = mqtt.sent.length;
    bridge.onFrame({ type: 'update', at: time, section: 'projects', data: [{ id: 7, state: 'problem' }] });
    expect(mqtt.queued).toHaveLength(1);
    bridge.onFrame({ type: 'update', at: time, section: 'projects', data: [{ id: 7, state: 'paused' }] });
    bridge.onFrame({ type: 'update', at: time, section: 'projects', data: [{ id: 7, state: 'ready' }] });
    expect(mqtt.queued).toHaveLength(1);
    mqtt.settle();
    expect(mqtt.queued).toHaveLength(0);
    const changes = mqtt.sent.slice(previous).filter(x => x.topic === prefix + '/state/projects');
    expect(changes).toHaveLength(2);
    expect(JSON.parse(mqtt.retained.get(prefix + '/state/projects')!)[0].state).toBe('ready');
  });
  test('does not acknowledge stale publish callbacks from the prior MQTT connection', () => {
    const { mqtt, bridge } = setup();
    bridge.onFrame(frame);
    const staleCallback = mqtt.queued.shift()!.callback;
    mqtt.connected = false;
    bridge.onMqttDisconnect();
    mqtt.queued.length = 0;
    mqtt.connected = true;
    bridge.onMqttConnect();
    staleCallback();
    mqtt.settle();
    expect(JSON.parse(mqtt.retained.get(prefix + '/status')!).state).toBe('online');
  });
});
