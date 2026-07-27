import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Storage primitives that make two recurring failure modes impossible.
 *
 * 1. READ FAILURE vs LEGITIMATELY EMPTY.
 *    Every store here used to `catch (e) { return {} }` — the exact same
 *    value a caller gets for a key that was never written. The caller then
 *    wrote that default back, turning ONE transient read error into
 *    permanent data loss: the recycle-bin index (wiped by purgeExpired on
 *    the very next launch, orphaning every copied file), a whole album's
 *    reviewed set, lifetime stats. `readJSON` reports which of the two
 *    happened so writers can refuse to run on top of an unknown state.
 *
 * 2. LOST UPDATES.
 *    Every store is read-modify-write and most call sites are deliberately
 *    fire-and-forget, so two concurrent updates both read the same base and
 *    the second write erases the first. `withLock` serialises per key.
 *
 * Plus `utf8ByteLength`: Android's AsyncStorage rejects values over ~2 MB
 * and does so SILENTLY, losing the whole entry. `String.length` counts
 * UTF-16 code units, but the payload is stored as UTF-8 — a Chinese
 * filename costs 3 bytes per character, so a length-based guard passes a
 * payload that is actually 2.2 MB. Chinese is this app's primary audience.
 */

/**
 * @returns {Promise<{ok: boolean, value: any}>}
 *  - `{ok: true, value: <parsed>}`   — key present and parsed
 *  - `{ok: true, value: null}`       — key absent (a legitimate empty state)
 *  - `{ok: false, value: null}`      — read or parse FAILED; do not write
 */
export async function readJSON(key) {
  let raw;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch (e) {
    return { ok: false, value: null };
  }
  if (raw === null || raw === undefined) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    // Corrupt payload — treat like a read failure, never like "empty".
    return { ok: false, value: null };
  }
}

/** Byte length the value will actually occupy once stored as UTF-8. */
export function utf8ByteLength(str) {
  if (typeof str !== 'string') return 0;
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4; // surrogate pair — consume the low half too
      i++;
    } else bytes += 3;
  }
  return bytes;
}

// Stay well under Android's ~2 MB per-value ceiling.
export const MAX_VALUE_BYTES = 1500000;

/**
 * Serialise a JSON value. Returns false (without writing) when the payload
 * would exceed the platform ceiling — callers should shed entries and retry
 * rather than let the write be silently dropped.
 */
export async function writeJSON(key, value, { maxBytes = MAX_VALUE_BYTES } = {}) {
  let payload;
  try {
    payload = JSON.stringify(value);
  } catch (e) {
    return false;
  }
  if (utf8ByteLength(payload) > maxBytes) return false;
  try {
    await AsyncStorage.setItem(key, payload);
    return true;
  } catch (e) {
    return false;
  }
}

// One promise chain per key. Tasks are chained even when they reject, so a
// single failure never wedges the queue for that key.
const chains = new Map();

/**
 * Run `fn` with exclusive access to `key`. Concurrent calls for the same key
 * queue up instead of interleaving their read-modify-write.
 */
export function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive but never let an unhandled rejection escape.
  chains.set(
    key,
    next.then(
      () => {},
      () => {}
    )
  );
  return next;
}
