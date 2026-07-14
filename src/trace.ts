/** Opt-in diagnostic tracing, persisted so it survives reloads. */
const STORAGE_KEY = 'caldav-sync.trace';

let enabled = false;
try {
  enabled = typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1';
} catch {
  /* ignore */
}

export function setTraceEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
  console.log(`[CalDAV Sync] Trace ${on ? 'ENABLED' : 'disabled'}`);
}

export function isTraceEnabled(): boolean {
  return enabled;
}

export function trace(...args: unknown[]): void {
  if (enabled) console.log('[CalDAV Sync ▸]', ...args);
}
