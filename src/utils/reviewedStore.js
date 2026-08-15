import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { readJSON, withLock } from './safeStore';

/**
 * Persistent per-album "already reviewed" record. A photo counts as
 * reviewed once its GROUP was confirmed (deleted or kept) — it then never
 * re-enters the random cleaning pool, session after session, until every
 * photo of the album has been reviewed once (the round auto-resets).
 */
const KEY = (albumId) => `@mediacleaner/reviewed_${albumId}`;
const CAP = 20000;
// Coalescing window for writes. `addReviewed` fires once per confirmed group
// — every ~5 photos — and the stored list grows to CAP (~400 KB of JSON), so
// writing through on every call meant a full parse AND a full serialise of
// that list several times a minute, on the JS thread, mid-swipe. The memo
// below is authoritative instead and disk catches up in the background.
//
// Worst case (process killed inside the window): up to a few seconds of
// reviewed ids are lost, i.e. one group may re-enter the pool. Losing a
// whole album's history — what an unlocked read-modify-write could do — is
// the failure this store actually has to prevent.
const FLUSH_DEBOUNCE_MS = 5000;

// albumId -> Set<string>. AUTHORITATIVE: every write goes through this
// module, so the memo cannot drift from disk.
const memo = new Map();
// Albums whose read failed or came back corrupt. Never written to: an empty
// set is indistinguishable from "read failed", and writing it back would
// turn one transient error into permanent loss of the album's history.
const unreadable = new Set();
const dirty = new Set();
let flushTimer = null;

/** Load an album's set into the memo. Returns null when it can't be read. */
async function load(albumId) {
  const cached = memo.get(albumId);
  if (cached) return cached;
  const { ok, value } = await readJSON(KEY(albumId));
  if (!ok) {
    unreadable.add(albumId); // NOT memoized — a later call retries the read
    return null;
  }
  unreadable.delete(albumId);
  const set = new Set(Array.isArray(value) ? value : []);
  memo.set(albumId, set);
  return set;
}

async function flushAlbum(albumId) {
  if (!dirty.has(albumId)) return;
  dirty.delete(albumId);
  const set = memo.get(albumId);
  if (!set || unreadable.has(albumId)) return;
  return withLock(KEY(albumId), async () => {
    let list = [...set];
    if (list.length > CAP) {
      // Sets keep insertion order, so this drops the OLDEST entries.
      list = list.slice(list.length - CAP);
      memo.set(albumId, new Set(list)); // keep memory in step with disk
    }
    try {
      await AsyncStorage.setItem(KEY(albumId), JSON.stringify(list));
    } catch (e) {
      dirty.add(albumId); // retry on the next flush rather than lose it
    }
  });
}

/** Write every pending album now. Call before the app can be torn down. */
export async function flushReviewed() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const pending = [...dirty];
  await Promise.all(pending.map((id) => flushAlbum(id).catch(() => {})));
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushReviewed().catch(() => {});
  }, FLUSH_DEBOUNCE_MS);
}

// Backgrounding is the one moment we know the process may not come back.
try {
  AppState.addEventListener('change', (next) => {
    if (next !== 'active') flushReviewed().catch(() => {});
  });
} catch (e) {
  // AppState unavailable — the debounce timer still covers the common case
}

export async function getReviewed(albumId) {
  const set = await load(albumId);
  // A FRESH Set per call: CleaningScreen adds to the set it gets back, and
  // handing out the memo itself would let that mutation rewrite history.
  return new Set(set || []);
}

/**
 * Add ids to the reviewed set.
 *
 * In-memory and immediate; the disk write is coalesced (see
 * FLUSH_DEBOUNCE_MS). An album whose stored state could not be read is left
 * alone entirely rather than overwritten with a set built from nothing.
 */
export async function addReviewed(albumId, ids) {
  const set = await load(albumId);
  if (!set) return null; // unknown prior state — never overwrite it
  ids.forEach((id) => set.add(id));
  dirty.add(albumId);
  scheduleFlush();
  return new Set(set);
}

export async function clearReviewed(albumId) {
  return withLock(KEY(albumId), async () => {
    memo.set(albumId, new Set()); // authoritative: this album is now empty
    unreadable.delete(albumId);
    dirty.delete(albumId);
    try {
      await AsyncStorage.removeItem(KEY(albumId));
    } catch (e) {
      // best effort
    }
  });
}

// One multiGet per 40 albums: the values are large, and pulling all of them
// through at once peaks at exactly the memory we are trying not to spend.
const PRIME_CHUNK = 40;

/**
 * Warm the memo for many albums with ONE storage round trip each chunk.
 *
 * The album picker shows a progress bar per album, and a phone can easily
 * have 150+ albums — asking for them one at a time was 150 `getItem` calls
 * (plus 150 JSON parses) every time the home screen came into focus.
 */
export async function primeReviewed(albumIds) {
  const missing = [];
  const seen = new Set();
  for (const id of albumIds) {
    if (!id || seen.has(id) || memo.has(id)) continue;
    seen.add(id);
    missing.push(id);
  }
  for (let i = 0; i < missing.length; i += PRIME_CHUNK) {
    const part = missing.slice(i, i + PRIME_CHUNK);
    try {
      // eslint-disable-next-line no-await-in-loop
      const pairs = await AsyncStorage.multiGet(part.map(KEY));
      // Index by key rather than trusting the result order.
      const byKey = new Map(pairs);
      for (const albumId of part) {
        const raw = byKey.get(KEY(albumId));
        if (raw === null || raw === undefined) {
          memo.set(albumId, new Set()); // never written = legitimately empty
          continue;
        }
        try {
          const value = JSON.parse(raw);
          memo.set(albumId, new Set(Array.isArray(value) ? value : []));
          unreadable.delete(albumId);
        } catch (e) {
          unreadable.add(albumId); // corrupt — leave it uncached and unwritten
        }
      }
    } catch (e) {
      // Chunk failed: leave those albums uncached. Their progress bars simply
      // don't show this time; nothing is written on top of an unknown state.
    }
  }
}

/** Progress from the memo only — no IO. Pair with primeReviewed(). */
export function getProgressSync(albumId, total) {
  const set = memo.get(albumId);
  const safeTotal = Number(total) || 0;
  const done = set && safeTotal > 0 ? Math.min(set.size, safeTotal) : 0;
  return {
    done,
    total: safeTotal,
    percent: safeTotal > 0 ? Math.min(100, Math.round((done / safeTotal) * 100)) : 0,
  };
}

/** Progress for a single album. Moving/categorizing also adds to reviewed. */
export async function getProgress(albumId, total) {
  await load(albumId);
  return getProgressSync(albumId, total);
}
