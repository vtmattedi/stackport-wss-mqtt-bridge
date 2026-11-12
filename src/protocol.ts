export const SECTIONS = ['host', 'projects', 'actions', 'alerts'] as const;
export type Section = (typeof SECTIONS)[number];
export type Snapshot = { host: Record<string, unknown> | null; projects: Record<string, unknown>[]; actions: Record<string, unknown>[]; alerts: Record<string, unknown>[] };
export type WireEvent =
  | { type: 'hello' }
  | { type: 'snapshot'; at: string; data: Snapshot }
  | { type: 'update'; at: string; section: Section; data: Snapshot[Section] }
  | { type: 'heartbeat'; at: string; dataAgeS: number | null };

/** Fixed diagnostic codes only. Never include received message fields in errors/logs. */
export type ProtocolFailureCode =
  | 'frame_too_large' | 'malformed_json' | 'frame_too_complex'
  | 'unsupported_version' | 'missing_type'
  | 'hello_expected' | 'hello_instance_mismatch' | 'hello_scope_not_all'
  | 'hello_sections_invalid' | 'snapshot_expected' | 'snapshot_invalid'
  | 'snapshot_missing_section' | 'invalid_host' | 'invalid_projects'
  | 'invalid_actions' | 'invalid_alerts'
  | 'sequence_invalid' | 'timestamp_invalid' | 'update_section_invalid'
  | 'heartbeat_age_invalid' | 'message_type_invalid';

export class ProtocolError extends Error {
  constructor(readonly code: ProtocolFailureCode) {
    super('bad_protocol');
    this.name = 'ProtocolError';
  }
}
function fail(code: ProtocolFailureCode): never { throw new ProtocolError(code); }

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_NODES = 60000;
const MAX_DEPTH = 16;
const MAX_ITEMS = 5000;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function checkDepth(input: unknown): void {
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('frame_too_complex');
    if (Array.isArray(value)) {
      if (value.length > MAX_ITEMS) fail('frame_too_complex');
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
function sectionFailure(section: Section): ProtocolFailureCode {
  switch (section) {
    case 'host': return 'invalid_host';
    case 'projects': return 'invalid_projects';
    case 'actions': return 'invalid_actions';
    case 'alerts': return 'invalid_alerts';
  }
}
function assertSnapshot(data: unknown): asserts data is Snapshot {
  if (!object(data)) fail('snapshot_invalid');
  for (const section of SECTIONS) {
    if (!Object.hasOwn(data, section)) fail('snapshot_missing_section');
    if (!validSection(section, data[section])) fail(sectionFailure(section));
  }
}
function validAt(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}
/**
 * Stackport seq is per WebSocket connection. A reconnection requires a new
 * hello and full snapshot, not an update to the preceding connection state.
 */
export class StatusProtocol {
  private stage: 'hello' | 'snapshot' | 'live' = 'hello';
  private seq = 0;
  constructor(private readonly instance: string) {}

  /** Safe metadata only: suitable for logs without exposing frame content. */
  get phase(): 'hello' | 'snapshot' | 'live' { return this.stage; }

  accept(raw: string): WireEvent {
    if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) fail('frame_too_large');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return fail('malformed_json'); }
    checkDepth(parsed);
    if (!object(parsed)) fail('missing_type');
    if (parsed.v !== 1) fail('unsupported_version');
    if (typeof parsed.type !== 'string') fail('missing_type');

    if (this.stage === 'hello') {
      if (parsed.type !== 'hello') fail('hello_expected');
      if (parsed.instance !== this.instance) fail('hello_instance_mismatch');
      if (parsed.scope !== 'all') fail('hello_scope_not_all');
      const sections = parsed.sections;
      if (!Array.isArray(sections) || sections.length !== SECTIONS.length ||
          !SECTIONS.every(section => sections.includes(section))) fail('hello_sections_invalid');
      this.stage = 'snapshot';
      return { type: 'hello' };
    }

    if (!Number.isSafeInteger(parsed.seq) || (parsed.seq as number) !== this.seq + 1) fail('sequence_invalid');
    if (!validAt(parsed.at)) fail('timestamp_invalid');

    if (this.stage === 'snapshot') {
      if (parsed.type !== 'snapshot') fail('snapshot_expected');
      assertSnapshot(parsed.data);
      this.seq = parsed.seq as number;
      this.stage = 'live';
      return { type: 'snapshot', at: parsed.at as string, data: parsed.data };
    }
    if (parsed.type === 'update') {
      if (!SECTIONS.includes(parsed.section as Section)) fail('update_section_invalid');
      const section = parsed.section as Section;
      if (!validSection(section, parsed.data)) fail(sectionFailure(section));
      this.seq = parsed.seq as number;
      return { type: 'update', at: parsed.at as string, section, data: parsed.data as Snapshot[Section] };
    }
    if (parsed.type === 'heartbeat') {
      if (!(parsed.dataAgeS === null || (typeof parsed.dataAgeS === 'number' &&
          Number.isFinite(parsed.dataAgeS) && parsed.dataAgeS >= 0))) fail('heartbeat_age_invalid');
      this.seq = parsed.seq as number;
      return { type: 'heartbeat', at: parsed.at as string, dataAgeS: parsed.dataAgeS as number | null };
    }
    return fail('message_type_invalid');
  }
}
