import { describe, expect, test } from 'bun:test';
import type { Config } from '../src/config';
import { Bridge, type PublishClient } from '../src/bridge';
import { StackportClient } from '../src/stackport';
import { SECTIONS } from '../src/protocol';

describe('native Bun WebSocket transport', () => {
  test('uses an Authorization header without Origin, receives hello/snapshot and publishes retained sections', async () => {
    let authorized = false;
    let receivedOrigin = false;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, instance) {
        authorized = req.headers.get('authorization') === 'Bearer spk_' + 'x'.repeat(40);
        receivedOrigin = req.headers.has('origin');
        if (!authorized || receivedOrigin) return new Response('unauthorized', { status: 401 });
        if (instance.upgrade(req)) return;
        return new Response('upgrade failed', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({
            type: 'hello', v: 1, instance: 'sp-test', scope: 'all', sections: SECTIONS,
          }));
          ws.send(JSON.stringify({
            type: 'snapshot', v: 1, seq: 1, at: new Date().toISOString(),
            data: {
              host: null,
              projects: [{ id: 12, name: 'Demo', state: 'ready' }],
              actions: [], alerts: [],
            },
          }));
        },
        message() { throw new Error('The bridge must not send application frames'); },
      },
    });
    const published = new Map<string, string>();
    const publisher: PublishClient = {
      connected: true,
      publish(topic, payload, _opts, callback) {
        published.set(topic, payload);
        queueMicrotask(() => callback(null));
      },
    };
    const bridge = new Bridge({ topicBase: 'stackport/sp-test' }, publisher);
    bridge.onMqttConnect();
    const source = new StackportClient({
      instance: 'sp-test',
      wsUrl: 'ws://127.0.0.1:' + server.port + '/status/ws',
      statusToken: 'spk_' + 'x'.repeat(40),
      staleAfterMs: 90000,
      silenceTimeoutMs: 90000,
      reconnectMinMs: 100,
      reconnectMaxMs: 1000,
    } as Config, bridge);
    try {
      source.start();
      for (let i = 0; i < 60 && !published.has('stackport/sp-test/state/projects'); i++) {
        await Bun.sleep(40);
      }
      expect(authorized).toBe(true);
      expect(receivedOrigin).toBe(false);
      expect(JSON.parse(published.get('stackport/sp-test/state/projects')!)).toEqual([
        { id: 12, name: 'Demo', state: 'ready' },
      ]);
      for (const section of SECTIONS) expect(published.has('stackport/sp-test/state/' + section)).toBe(true);
      for (let i = 0; i < 20; i++) {
        if (JSON.parse(published.get('stackport/sp-test/status') ?? '{}').state === 'online') break;
        await Bun.sleep(20);
      }
      expect(JSON.parse(published.get('stackport/sp-test/status')!).state).toBe('online');
    } finally {
      source.stop();
      bridge.stop();
      server.stop(true);
    }
  }, 10000);
});
