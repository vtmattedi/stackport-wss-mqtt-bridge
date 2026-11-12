import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { resolve } from 'node:path';

export interface Config {
  instance: string;
  wsUrl: string;
  statusToken: string;
  mqttUrl: string;
  mqttUsername: string;
  mqttPassword: string;
  mqttClientId: string;
  mqttCa: Buffer;
  mqttServername: string;
  topicBase: string;
  staleAfterMs: number;
  silenceTimeoutMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  mqttReconnectMs: number;
  keepalive: number;
}
function required(env: Record<string, string | undefined>, key: string): string {
  const result = env[key]?.trim();
  if (!result) throw new Error('Missing required setting: ' + key);
  return result;
}
function numberSetting(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  if (!env[name]) return fallback;
  const n = Number(env[name]);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('Invalid numeric setting: ' + name);
  return n;
}
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const instance = required(env, 'SP_INSTANCE');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(instance)) throw new Error('Invalid SP_INSTANCE topic segment');
  if ((env.SP_EXPECTED_SCOPE ?? 'all') !== 'all') throw new Error('V0 supports unscoped status tokens only');
  const wsUrl = required(env, 'SP_WS_URL');
  const ws = new URL(wsUrl);
  if (ws.protocol !== 'wss:' || ws.pathname !== '/status/ws' || ws.search || ws.hash || ws.username || ws.password) {
    throw new Error('SP_WS_URL must be an authenticated WSS /status/ws endpoint without URL credentials or query');
  }
  const statusToken = required(env, 'SP_STATUS_TOKEN');
  if (!/^spk_[A-Za-z0-9_-]{16,128}$/.test(statusToken)) throw new Error('Invalid Stackport status token format');

  const mqttUrl = required(env, 'MQTT_URL');
  const mqtt = new URL(mqttUrl);
  if (mqtt.protocol !== 'mqtts:' || (mqtt.port && mqtt.port !== '8883') ||
      mqtt.pathname !== '/' || mqtt.search || mqtt.hash || mqtt.username || mqtt.password) {
    throw new Error('MQTT_URL must be an MQTTS endpoint without embedded credentials');
  }
  const mqttServername = required(env, 'MQTT_TLS_SERVERNAME');
  if (mqttServername !== mqtt.hostname) throw new Error('MQTT servername must match external MQTT hostname');
  const caPath = resolve(required(env, 'MQTT_CA_FILE'));
  const mqttCa = readFileSync(caPath);
  const cert = new X509Certificate(mqttCa);
  if (!cert.ca) throw new Error('MQTT root certificate is not a CA');
  if (Date.parse(cert.validTo) <= Date.now() || Date.parse(cert.validFrom) > Date.now()) {
    throw new Error('MQTT root certificate is not currently valid');
  }
  const mqttClientId = required(env, 'MQTT_CLIENT_ID');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(mqttClientId)) throw new Error('Unsafe MQTT_CLIENT_ID');
  const reconnectMinMs = numberSetting(env, 'WS_RECONNECT_MIN_MS', 1000, 100, 60000);
  const reconnectMaxMs = numberSetting(env, 'WS_RECONNECT_MAX_MS', 30000, 1000, 300000);
  if (reconnectMaxMs < reconnectMinMs) throw new Error('WS reconnect max must be >= min');
  return {
    instance, wsUrl, statusToken, mqttUrl,
    mqttUsername: required(env, 'MQTT_USERNAME'),
    mqttPassword: required(env, 'MQTT_PASSWORD'),
    mqttClientId, mqttCa, mqttServername, topicBase: 'stackport/' + instance,
    staleAfterMs: numberSetting(env, 'SOURCE_STALE_AFTER_SECONDS', 90, 30, 3600) * 1000,
    silenceTimeoutMs: numberSetting(env, 'WS_SILENCE_TIMEOUT_SECONDS', 90, 45, 3600) * 1000,
    reconnectMinMs, reconnectMaxMs,
    mqttReconnectMs: numberSetting(env, 'MQTT_RECONNECT_MS', 3000, 1000, 60000),
    keepalive: numberSetting(env, 'MQTT_KEEPALIVE_SECONDS', 30, 10, 120),
  };
}
