import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

/**
 * Lightweight in-app logger for field debugging.
 * - Ring buffer (last ~1500 lines) flushed to a file every few seconds
 * - Captures GLOBAL JS errors and console.error/warn automatically
 * - Previous session's tail is kept, so crash logs survive restarts
 * - Export via the system share sheet from Settings
 */

const LOG_FILE = FileSystem.documentDirectory + 'mediacleaner.log';
const MAX_LINES = 1500;
const PREV_KEEP = 60 * 1024; // keep at most this much of older sessions
// expo-file-system has no append, so every flush REWRITES the whole file:
// prevLog + the entire ring buffer, i.e. a ~180 KB string built and written
// each time. At 1.5s that ran continuously through any busy session. 4s
// costs nothing in forensic value — logSync() still writes through
// immediately, which is what the crash-bisect markers rely on.
const FLUSH_INTERVAL_MS = 4000;

let buffer = [];
let prevLog = '';
let dirty = false;
let flushTimer = null;
let installed = false;

const ts = () => new Date().toISOString();

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow().catch(() => {});
  }, FLUSH_INTERVAL_MS);
}

export function log(tag, msg) {
  try {
    const text =
      typeof msg === 'string' ? msg : JSON.stringify(msg)?.slice(0, 500);
    buffer.push(`${ts()} [${tag}] ${text}`);
    if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
    scheduleFlush();
  } catch (e) {
    // logging must never throw
  }
}

export function logError(tag, e) {
  const message = e && e.message ? e.message : String(e);
  const stack = e && e.stack ? `\n${String(e.stack).slice(0, 1200)}` : '';
  log(tag, `ERROR ${message}${stack}`);
}

/**
 * Log AND write to disk before returning. Place these BEFORE dangerous
 * native calls: a native crash kills the process instantly, but the marker
 * is already on disk — the next exported log's last line pinpoints the
 * killing step.
 */
export async function logSync(tag, msg) {
  log(tag, msg);
  dirty = true;
  await flushNow();
}

export async function flushNow() {
  if (!dirty) return;
  dirty = false;
  try {
    const content = `${prevLog}${buffer.join('\n')}\n`;
    await FileSystem.writeAsStringAsync(LOG_FILE, content);
  } catch (e) {
    // best effort
  }
}

/** Returns the log file uri (flushed first). */
export async function getLogFileUri() {
  dirty = true;
  await flushNow();
  return LOG_FILE;
}

export async function clearLog() {
  buffer = [];
  prevLog = '';
  dirty = true;
  await flushNow();
}

/** Install global capture. Call ONCE at app start. */
export function installLogger(appVersion) {
  if (installed) return;
  installed = true;

  // Keep the tail of previous sessions (crash forensics).
  (async () => {
    try {
      const info = await FileSystem.getInfoAsync(LOG_FILE);
      if (info.exists) {
        let old = await FileSystem.readAsStringAsync(LOG_FILE);
        if (old.length > PREV_KEEP) old = old.slice(old.length - PREV_KEEP);
        prevLog = `${old}\n`;
      }
    } catch (e) {
      prevLog = '';
    }
    log(
      'app',
      `==== SESSION START ${Platform.OS} ${Platform.Version} v${appVersion || '?'} ====`
    );
  })();

  // Global fatal JS errors.
  try {
    // eslint-disable-next-line no-undef
    const prev = ErrorUtils.getGlobalHandler && ErrorUtils.getGlobalHandler();
    // eslint-disable-next-line no-undef
    ErrorUtils.setGlobalHandler((e, isFatal) => {
      logError(isFatal ? 'FATAL' : 'error', e);
      dirty = true;
      flushNow().catch(() => {});
      if (prev) prev(e, isFatal);
    });
  } catch (e) {
    // ErrorUtils unavailable
  }

  // Mirror console.error / console.warn into the log.
  const origError = console.error;
  console.error = (...args) => {
    try {
      log('console.error', args.map((a) => String(a)).join(' ').slice(0, 800));
    } catch (e) {
      // ignore
    }
    origError(...args);
  };
  const origWarn = console.warn;
  console.warn = (...args) => {
    try {
      log('console.warn', args.map((a) => String(a)).join(' ').slice(0, 500));
    } catch (e) {
      // ignore
    }
    origWarn(...args);
  };
}
