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

/**
 * One reviewed set per media type, shared by every album. An asset can belong
 * to "All Photos", Camera and QQ at the same time; album-scoped history made
 * those three progress rings disagree after the very same photo was handled.
 * Album progress is now the intersection of this set and that album's ids.
 */
export function scopeFor(mediaType) {
  return mediaType === 'video' ? 'global:video' : 'global:photo';
}

export function albumScopeFor(mediaType, albumId) {
  return `album:${mediaType === 'video' ? 'video' : 'photo'}:${albumId}`;
}

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
const LEGACY_MIGRATED_KEY = '@mediacleaner/reviewed_global_migrated_v1';
let migrationPromise = null;
const activeRoundScopes = new Map();
const membershipByType = new Map([
  ['photo', new Map()],
  ['video', new Map()],
]);
const MAX_MEMBERSHIP_ASSETS = 30000;

function roundScopeFor(mediaType, albumId, range) {
  const type = mediaType === 'video' ? 'video' : 'photo';
  const rangeKey = range
    ? `${Number(range.start) || 0}-${Number(range.end) || 0}`
    : 'all-time';
  return `round:${type}:${albumId || 'all'}:${rangeKey}`;
}

/** Select the independent review round consumed by the cleaning screen. */
export function activateRound(mediaType, albumId, range = null) {
  const type = mediaType === 'video' ? 'video' : 'photo';
  const scope = roundScopeFor(type, albumId, range);
  activeRoundScopes.set(type, scope);
  return scope;
}

/**
 * Remember membership observed while an album is open. iOS Asset objects do
 * not expose albumId, so this lets later decisions from "All" still update
 * every real collection the app has already resolved in this process.
 */
export function rememberAlbumMembership(mediaType, albumId, assets) {
  if (!albumId || albumId === 'all') return;
  const type = mediaType === 'video' ? 'video' : 'photo';
  const index = membershipByType.get(type);
  for (const asset of assets || []) {
    const id = asset?.id || asset;
    if (!id) continue;
    let albums = index.get(id);
    if (!albums) {
      albums = new Set();
      index.set(id, albums);
    }
    albums.add(albumId);
  }
  while (index.size > MAX_MEMBERSHIP_ASSETS) {
    index.delete(index.keys().next().value);
  }
}

/** Merge a native asset-id -> collection-id map into the shared index. */
export function rememberMembershipMap(mediaType, membership) {
  const type = mediaType === 'video' ? 'video' : 'photo';
  const index = membershipByType.get(type);
  for (const [assetId, albumIds] of Object.entries(membership || {})) {
    if (!assetId || !Array.isArray(albumIds)) continue;
    let albums = index.get(assetId);
    if (!albums) {
      albums = new Set();
      index.set(assetId, albums);
    }
    for (const albumId of albumIds) if (albumId) albums.add(albumId);
  }
  while (index.size > MAX_MEMBERSHIP_ASSETS) {
    index.delete(index.keys().next().value);
  }
}

async function migrateLegacyPhotoHistory() {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    try {
      if (await AsyncStorage.getItem(LEGACY_MIGRATED_KEY)) return [];
      const prefix = '@mediacleaner/reviewed_';
      const keys = (await AsyncStorage.getAllKeys()).filter((key) => {
        if (!key.startsWith(prefix) || key === LEGACY_MIGRATED_KEY) return false;
        const suffix = key.slice(prefix.length);
        return (
          !suffix.startsWith('global:') &&
          !suffix.startsWith('album:') &&
          !suffix.startsWith('round:') &&
          !suffix.startsWith('v:')
        );
      });
      const merged = new Set();
      for (let i = 0; i < keys.length; i += PRIME_CHUNK) {
        // eslint-disable-next-line no-await-in-loop
        const pairs = await AsyncStorage.multiGet(keys.slice(i, i + PRIME_CHUNK));
        for (const [, raw] of pairs) {
          try {
            const ids = raw ? JSON.parse(raw) : [];
            if (Array.isArray(ids)) ids.forEach((id) => merged.add(id));
          } catch (e) {
            // Keep migrating the readable albums.
          }
        }
      }
      const ids = [...merged].slice(-CAP);
      // The marker is written only after the destination succeeds. A failed
      // destination write must be retried on the next launch.
      await AsyncStorage.setItem(KEY(scopeFor('photo')), JSON.stringify(ids));
      await AsyncStorage.setItem(LEGACY_MIGRATED_KEY, '1');
      return ids;
    } catch (e) {
      return [];
    } finally {
      migrationPromise = null;
    }
  })();
  return migrationPromise;
}

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
  let list = Array.isArray(value) ? value : [];
  if (albumId === scopeFor('photo') && list.length === 0) {
    list = await migrateLegacyPhotoHistory();
  }
  const set = new Set(list);
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
  const active =
    albumId === scopeFor('video')
      ? activeRoundScopes.get('video')
      : albumId === scopeFor('photo')
        ? activeRoundScopes.get('photo')
        : null;
  const set = await load(active || albumId);
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

/**
 * Record the global decision plus source-album membership. Membership is only
 * an index for progress after deletion; the global set remains the authority.
 */
export async function addReviewedAssets(mediaType, currentAlbumId, assets) {
  const list = (assets || []).filter((a) => a && a.id);
  if (list.length === 0) return;
  const type = mediaType === 'video' ? 'video' : 'photo';
  const active = activeRoundScopes.get(type);
  await addReviewed(scopeFor(mediaType), list.map((a) => a.id));
  const byAlbum = new Map();
  const add = (albumId, id) => {
    if (!albumId) return;
    if (!byAlbum.has(albumId)) byAlbum.set(albumId, []);
    byAlbum.get(albumId).push(id);
  };
  for (const asset of list) {
    add('all', asset.id);
    add(currentAlbumId, asset.id);
    add(asset.albumId, asset.id);
    const memberships = membershipByType.get(type).get(asset.id);
    if (memberships) {
      for (const albumId of memberships) add(albumId, asset.id);
    }
  }
  const writes = [...byAlbum].map(([albumId, ids]) =>
      addReviewed(albumScopeFor(mediaType, albumId), ids)
    );
  if (active) writes.push(addReviewed(active, list.map((a) => a.id)));
  await Promise.all(writes);
}

/** Remove only one album's ids when that album starts a new review round. */
export async function removeReviewed(albumId, ids) {
  const set = await load(albumId);
  if (!set) return null;
  ids.forEach((item) => set.delete(typeof item === 'string' ? item : item?.id));
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
          if (albumId === scopeFor('photo')) {
            const migrated = await migrateLegacyPhotoHistory();
            memo.set(albumId, new Set(migrated));
            continue;
          }
          memo.set(albumId, new Set()); // never written = legitimately empty
          continue;
        }
        try {
          const value = JSON.parse(raw);
          let list = Array.isArray(value) ? value : [];
          if (albumId === scopeFor('photo') && list.length === 0) {
            list = await migrateLegacyPhotoHistory();
          }
          memo.set(albumId, new Set(list));
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

/** Exact progress for an album or time scope from its asset ids. */
export function getProgressForIdsSync(albumId, assetIds) {
  const set = memo.get(albumId);
  const ids = Array.isArray(assetIds) ? assetIds : [];
  let done = 0;
  if (set) {
    for (const item of ids) {
      const id = typeof item === 'string' ? item : item?.id;
      if (id && set.has(id)) done += 1;
    }
  }
  const total = ids.length;
  return {
    done,
    total,
    percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
  };
}

/** Album progress includes reviewed items that have since been deleted. */
export function getAlbumProgressSync(mediaType, albumId, assets) {
  const global = memo.get(scopeFor(mediaType)) || new Set();
  const historical = memo.get(albumScopeFor(mediaType, albumId)) || new Set();
  const current = new Set((assets || []).map((a) => a?.id || a).filter(Boolean));
  const done = new Set(historical);
  for (const id of current) if (global.has(id)) done.add(id);
  const total = new Set([...current, ...historical]).size;
  return {
    done: done.size,
    total,
    percent: total > 0 ? Math.min(100, Math.round((done.size / total) * 100)) : 0,
  };
}

/** Start a new round for one album while keeping every overlapping view synced. */
export async function resetAlbumRound(mediaType, albumId, currentAssets) {
  const type = mediaType === 'video' ? 'video' : 'photo';
  const active = activeRoundScopes.get(type);
  if (active) {
    await clearReviewed(active);
    return;
  }
  const globalScope = scopeFor(mediaType);
  if (albumId === 'all') {
    await clearReviewed(globalScope);
    try {
      const prefix = `@mediacleaner/reviewed_album:${mediaType}:`;
      const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(prefix));
      if (keys.length > 0) await AsyncStorage.multiRemove(keys);
      for (const key of [...memo.keys()]) {
        if (key.startsWith(`album:${mediaType}:`)) memo.delete(key);
      }
    } catch (e) {
      // best effort; global history is already reset
    }
    return;
  }
  const albumScope = albumScopeFor(mediaType, albumId);
  const historical = await getReviewed(albumScope);
  await removeReviewed(globalScope, [
    ...(currentAssets || []).map((a) => a?.id || a),
    ...historical,
  ]);
  await clearReviewed(albumScope);
}

export async function getProgressForIds(albumId, assetIds) {
  await load(albumId);
  return getProgressForIdsSync(albumId, assetIds);
}

/** Progress for a single album. Moving/categorizing also adds to reviewed. */
export async function getProgress(albumId, total) {
  await load(albumId);
  return getProgressSync(albumId, total);
}
