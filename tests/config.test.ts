import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config';

function vars(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SP_INSTANCE: 'sp-1234567890',
    SP_EXPECTED_SCOPE: 'all',
    SP_WS_URL: 'wss://sp.mattediworks.com/status/ws',
    SP_STATUS_TOKEN: 'spk_' + 'a'.repeat(42),
    MQTT_URL: 'mqtts://mqtt.mattediworks.com:8883',
    MQTT_TLS_SERVERNAME: 'mqtt.mattediworks.com',
    MQTT_CA_FILE: './certs/nm-root-ca.crt',
    MQTT_CLIENT_ID: 'stackport-bridge-primary',
    MQTT_USERNAME: 'stackport-bridge',
    MQTT_PASSWORD: 'long-secret-password-for-bridge',
    ...overrides,
  };
}
describe('private environment and TLS validation', () => {
  test('accepts the supplied public NM Root CA and expected encrypted external endpoints', () => {
    const config = loadConfig(vars());
    expect(config.wsUrl).toBe('wss://sp.mattediworks.com/status/ws');
    expect(config.mqttUrl).toBe('mqtts://mqtt.mattediworks.com:8883');
    expect(config.topicBase).toBe('stackport/sp-1234567890');
    expect(config.mqttCa.toString()).toContain('BEGIN CERTIFICATE');
  });
  test('fails closed on missing credentials and unsafe MQTT topic segments', () => {
    expect(() => loadConfig(vars({ SP_STATUS_TOKEN: '' }))).toThrow('SP_STATUS_TOKEN');
    expect(() => loadConfig(vars({ MQTT_PASSWORD: '' }))).toThrow('MQTT_PASSWORD');
    expect(() => loadConfig(vars({ SP_INSTANCE: 'sp/+/#' }))).toThrow('SP_INSTANCE');
    expect(() => loadConfig(vars({ SP_EXPECTED_SCOPE: 'group' }))).toThrow('unscoped');
  });
  test('refuses unencrypted WSS/MQTT and credentials/query in URLs', () => {
    expect(() => loadConfig(vars({ SP_WS_URL: 'ws://sp.mattediworks.com/status/ws' }))).toThrow('WSS');
    expect(() => loadConfig(vars({ SP_WS_URL: 'wss://sp.mattediworks.com/status/ws?token=a' }))).toThrow('WSS');
    expect(() => loadConfig(vars({ MQTT_URL: 'mqtt://mqtt.mattediworks.com:1883' }))).toThrow('MQTTS');
    expect(() => loadConfig(vars({ MQTT_TLS_SERVERNAME: 'evil.example.test' }))).toThrow('servername');
    expect(() => loadConfig(vars({ MQTT_CA_FILE: '/tmp/missing-ca.crt' }))).toThrow();
  });
});
