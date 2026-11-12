/** Intentionally never accept provider payloads, headers or raw errors in logs. */
export function log(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n');
}
