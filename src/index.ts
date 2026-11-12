import mqtt from 'mqtt';
import type { PublishClient } from './bridge';
import { Bridge } from './bridge';
import { loadConfig } from './config';
import { log } from './log';
import { StackportClient } from './stackport';

const config = loadConfig();
const willTopic = config.topicBase + '/bridge/availability';
const mqttClient = mqtt.connect(config.mqttUrl, {
  username: config.mqttUsername,
  password: config.mqttPassword,
  clientId: config.mqttClientId,
  protocolVersion: 4,
  clean: true,
  keepalive: config.keepalive,
  reconnectPeriod: config.mqttReconnectMs,
  connectTimeout: 15_000,
  resubscribe: false,
  queueQoSZero: false,
  ca: config.mqttCa,
  servername: config.mqttServername,
  rejectUnauthorized: true,
  will: { topic: willTopic, payload: '{"state":"offline"}', qos: 1, retain: true },
});
const publisher: PublishClient = {
  get connected() { return mqttClient.connected; },
  publish(topic, payload, opts, callback) {
    mqttClient.publish(topic, payload, opts, error => callback(error ?? null));
  },
};
const bridge = new Bridge(config, publisher);
const source = new StackportClient(config, bridge);
mqttClient.on('connect', () => bridge.onMqttConnect());
mqttClient.on('close', () => bridge.onMqttDisconnect());
mqttClient.on('offline', () => bridge.onMqttDisconnect());
mqttClient.on('error', () => log('mqtt.error'));
source.start();
log('bridge.started', { instance: config.instance });

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('bridge.stopping');
  source.stop();
  bridge.stop();
  if (mqttClient.connected) {
    // Graceful exits do not trigger MQTT Will; explicitly retain offline.
    await Promise.race([
      new Promise<void>(resolve => mqttClient.publish(willTopic, '{"state":"offline"}',
        { qos: 1, retain: true }, () => resolve())),
      new Promise<void>(resolve => setTimeout(resolve, 2000)),
    ]);
  }
  mqttClient.end(true);
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
