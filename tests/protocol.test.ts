import { describe, expect, test } from 'bun:test';
import { StatusProtocol, SECTIONS } from '../src/protocol';

const hello = { type: 'hello', v: 1, instance: 'sp-test', scope: 'all', sections: SECTIONS };
const snapshot = {
  type: 'snapshot', v: 1, seq: 1, at: '2026-11-12T00:00:00.000Z',
  data: { host: null, projects: [{ id: 7, name: 'Demo', state: 'ready' }], actions: [], alerts: [] },
};
function feed(p: StatusProtocol, data: unknown) { return p.accept(JSON.stringify(data)); }
describe('Stackport read-only WSS protocol', () => {
  test('hello + full snapshot + complete-section update + heartbeat', () => {
    const p = new StatusProtocol('sp-test');
    expect(feed(p, hello)).toEqual({ type: 'hello' });
    expect(feed(p, snapshot)).toMatchObject({ type: 'snapshot', data: { projects: [{ id: 7 }] } });
    expect(feed(p, { type: 'update', v: 1, seq: 2, at: snapshot.at, section: 'projects', data: [] }))
      .toMatchObject({ type: 'update', section: 'projects', data: [] });
    expect(feed(p, { type: 'heartbeat', v: 1, seq: 3, at: snapshot.at, dataAgeS: 4 }))
      .toMatchObject({ type: 'heartbeat', dataAgeS: 4 });
  });
  test('rejects out-of-order seq, invalid instance/scope, pre-snapshot update and unknown sections', () => {
    expect(() => feed(new StatusProtocol('different'), hello)).toThrow('bad_protocol');
    expect(() => feed(new StatusProtocol('sp-test'), { ...hello, scope: 'group' })).toThrow('bad_protocol');
    const p = new StatusProtocol('sp-test');
    feed(p, hello);
    expect(() => feed(p, { type: 'update', v: 1, seq: 1, at: snapshot.at, section: 'host', data: null })).toThrow('bad_protocol');
    const p2 = new StatusProtocol('sp-test');
    feed(p2, hello);
    feed(p2, snapshot);
    expect(() => feed(p2, { type: 'heartbeat', v: 1, seq: 4, at: snapshot.at, dataAgeS: 1 })).toThrow('bad_protocol');
    expect(() => feed(p2, { type: 'update', v: 1, seq: 2, at: snapshot.at, section: 'secrets', data: [] })).toThrow('bad_protocol');
  });
  test('rejects malformed, oversized or deeply nested payloads and unsupported versions', () => {
    const p = new StatusProtocol('sp-test');
    expect(() => p.accept('{')).toThrow('bad_protocol');
    expect(() => p.accept('x'.repeat(1024 * 1024 + 1))).toThrow('bad_protocol');
    expect(() => feed(p, { ...hello, v: 2 })).toThrow('bad_protocol');
    let nested: unknown = null;
    for (let i = 0; i < 22; i++) nested = { value: nested };
    expect(() => feed(p, nested)).toThrow('bad_protocol');
  });
  test('rejects snapshot missing required sections and invalid numeric project IDs', () => {
    const p = new StatusProtocol('sp-test');
    feed(p, hello);
    expect(() => feed(p, { ...snapshot, data: { host: null, projects: [], actions: [] } })).toThrow('bad_protocol');
    expect(() => feed(p, { ...snapshot, data: { ...snapshot.data, projects: [{ id: '7', name: 'Bad', state: 'ready' }] } })).toThrow('bad_protocol');
  });
});
