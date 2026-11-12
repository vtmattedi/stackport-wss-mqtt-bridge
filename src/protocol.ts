export const SECTIONS = ['host', 'projects', 'actions', 'alerts'] as const;
export type Section = (typeof SECTIONS)[number];
export type Snapshot = { host: Record<string, unknown> | null; projects: Record<string, unknown>[]; actions: Record<string, unknown>[]; alerts: Record<string, unknown>[] };
export type WireEvent =
  | { type: 'hello' }
  | { type: 'snapshot'; at: string; data: Snapshot }
  | { type: 'update'; at: string; section: Section; data: Snapshot[Section] }
  | { type: 'heartbeat'; at: string; dataAgeS: number | null };

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_NODES = 60000;
const MAX_DEPTH = 16;
const MAX_ITEMS = 5000;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fail(): never { throw new Error('bad_protocol'); }
function checkDepth(input: unknown): void {
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail();
    if (Array.isArray(value)) {
      if (value.length > MAX_ITEMS) fail();
      for (const member of value) stack.push({ value: member, depth: depth + 1 });
    } else if (object(value)) {
      for (const member of Object.values(value)) stack.push({ value: member, depth: depth + 1 });
    }
  }
}
function validSection(section: Section, data: unknown): boolean {
  if (section === 'host') return data === null || object(data);
  if (!Array.isArray(data) || data.length > MAX_ITEMS || !data.every(object)) return false;
  if (section === 'projects') return data.every(row => Number.isSafeInteger(row.id) && (row.id as number) > 0 && typeof row.name === 'string' && typeof row.state === 'string');
  if (section === 'actions') return data.every(row => (typeof row.id === 'string' || Number.isSafeInteger(row.id)) && (row.projectId === null || Number.isSafeInteger(row.projectId)));
  return data.every(row => typeof row.id === 'string' && typeof row.code === 'string');
}
function validSnapshot(data: unknown): data is Snapshot {
  if (!object(data)) return false;
  return SECTIONS.every(section => Object.hasOwn(data, section) && validSection(section, data[section]));
}
function validAt(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}
/**
 * Stackport's seq is per-WebSocket connection; a new connection always needs
 * its own hello + full snapshot. Never merge partial sections as patches.
 */
export class StatusProtocol {
  private stage: 'hello' | 'snapshot' | 'live' = 'hello';
  private seq = 0;
  constructor(private readonly instance: string) {}

  accept(raw: string): WireEvent {
    if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) fail();
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return fail(); }
    checkDepth(parsed);
    if (!object(parsed) || parsed.v !== 1 || typeof parsed.type !== 'string') fail();
    if (this.stage === 'hello') {
      const sections = parsed.sections;
      if (parsed.type !== 'hello' || parsed.instance !== this.instance || parsed.scope !== 'all' ||
          !Array.isArray(sections) || sections.length !== SECTIONS.length ||
          !SECTIONS.every(section => sections.includes(section))) fail();
      this.stage = 'snapshot';
      return { type: 'hello' };
    }
    if (!Number.isSafeInteger(parsed.seq) || (parsed.seq as number) !== this.seq + 1 || !validAt(parsed.at)) fail();
    if (this.stage === 'snapshot') {
      if (parsed.type !== 'snapshot' || !validSnapshot(parsed.data)) fail();
      this.seq = parsed.seq as number;
      this.stage = 'live';
      return { type: 'snapshot', at: parsed.at as string, data: parsed.data };
    }
    if (parsed.type === 'update') {
      if (!SECTIONS.includes(parsed.section as Section) || !validSection(parsed.section as Section, parsed.data)) fail();
      this.seq = parsed.seq as number;
      return { type: 'update', at: parsed.at as string, section: parsed.section as Section, data: parsed.data as Snapshot[Section] };
    }
    if (parsed.type === 'heartbeat') {
      if (!(parsed.dataAgeS === null || (typeof parsed.dataAgeS === 'number' && Number.isFinite(parsed.dataAgeS) && parsed.dataAgeS >= 0))) fail();
      this.seq = parsed.seq as number;
      return { type: 'heartbeat', at: parsed.at as string, dataAgeS: parsed.dataAgeS as number | null };
    }
    return fail();
  }
}
