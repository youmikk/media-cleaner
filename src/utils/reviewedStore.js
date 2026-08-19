import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { withLock } from './safeStore';

/**
 * Persistent per-album "already reviewed" record. A photo counts as
 * reviewed once its GROUP was confirmed (deleted or kept) — it then never
 * re-enters the random cleaning pool, session after session, until every
 * photo of the album has been reviewed. The category stays complete until
 * genuinely new asset ids appear.
 */
const KEY = (albumId) => `@mediacleaner/reviewed_${albumId}`;
const SHARD_PREFIX = '@mediacleaner/reviewed_shard_v2_';
const SHARD_KEY = (albumId, generation, index) =>
  `${SHARD_PREFIX}${encodeURIComponent(albumId)}_${generation}_${index}`;

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

// Per-value entry cap. Larger histories are split into multiple values so
// Android never receives an oversized AsyncStorage payload, while the full
// reviewed ledger remains available for libraries well beyond 20k assets.
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
// Deletions from a reviewed set invalidate append-only shard reuse.
const rewriteRequired = new Set();
const inFlightFlushes = new Map();
const mutationPins = new Map();
let flushTimer = null;
const LEGACY_MIGRATED_KEY = '@mediacleaner/reviewed_global_migrated_v1';
let migrationPromise = null;
const membershipByType = new Map([
  ['photo', new Map()],
  ['video', new Map()],
]);
const MAX_MEMBERSHIP_ASSETS = 30000;

function pinMutation(scope) {
  mutationPins.set(scope, (mutationPins.get(scope) || 0) + 1);
}

function unpinMutation(scope) {
  const next = (mutationPins.get(scope) || 0) - 1;
  if (next > 0) mutationPins.set(scope, next);
  else mutationPins.delete(scope);
}

async function decodeStoredValue(albumId, raw) {
  if (raw === null || raw === undefined) return { ok: true, list: [] };
  let value;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { ok: false, list: [] };
  }
  if (Array.isArray(value)) return { ok: true, list: value };
  if (!value || value.version !== 2 || !Array.isArray(value.shards)) {
    return { ok: false, list: [] };
  }
  const list = [];
  try {
    for (let i = 0; i < value.shards.length; i += PRIME_CHUNK) {
      // eslint-disable-next-line no-await-in-loop
      const pairs = await AsyncStorage.multiGet(
        value.shards.slice(i, i + PRIME_CHUNK)
      );
      const byKey = new Map(pairs);
      for (const key of value.shards.slice(i, i + PRIME_CHUNK)) {
        const shardRaw = byKey.get(key);
        if (!shardRaw) return { ok: false, list: [] };
        const shard = JSON.parse(shardRaw);
        if (!Array.isArray(shard)) return { ok: false, list: [] };
        list.push(...shard);
      }
    }
    if (Number.isFinite(value.count) && list.length !== value.count) {
      return { ok: false, list: [] };
    }
    return { ok: true, list };
  } catch (e) {
    return { ok: false, list: [] };
  }
}

function storedCount(raw) {
  try {
    const value = raw ? JSON.parse(raw) : null;
    if (Array.isArray(value)) return value.length;
    if (value?.version === 2 && Number.isFinite(value.count)) {
      return value.count;
    }
  } catch (e) {
    // Corrupt counts are omitted instead of being reported as zero.
  }
  return null;
}

async function writeStoredList(albumId, list, { forceRewrite = false } = {}) {
  const oldRaw = await AsyncStorage.getItem(KEY(albumId)).catch(() => null);
  let oldShards = [];
  let oldCount = 0;
  try {
    const oldValue = oldRaw ? JSON.parse(oldRaw) : null;
    if (oldValue?.version === 2 && Array.isArray(oldValue.shards)) {
      oldShards = oldValue.shards;
      oldCount = Number(oldValue.count) || 0;
    }
  } catch (e) {
    // A complete new value below can replace a corrupt old manifest.
  }

  if (list.length <= CAP) {
    await AsyncStorage.setItem(KEY(albumId), JSON.stringify(list));
    if (oldShards.length > 0) AsyncStorage.multiRemove(oldShards).catch(() => {});
    return;
  }

  // Reviewed sets normally only grow. Reuse immutable full shards and write
  // only the old partial tail plus new ids. This turns a 100k-photo update
  // from five large JSON writes into one small suffix write.
  let retainedShards = [];
  let writeFrom = 0;
  if (
    !forceRewrite &&
    oldShards.length > 0 &&
    oldCount > 0 &&
    list.length >= oldCount
  ) {
    if (list.length === oldCount) return;
    const reusableFullShards = Math.floor(oldCount / CAP);
    retainedShards = oldShards.slice(0, reusableFullShards);
    writeFrom = reusableFullShards * CAP;
  }

  const generation = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const chunks = [];
  for (let i = writeFrom; i < list.length; i += CAP) {
    chunks.push(list.slice(i, i + CAP));
  }
  const newShardKeys = chunks.map((_, index) =>
    SHARD_KEY(albumId, generation, index)
  );
  const shardKeys = [...retainedShards, ...newShardKeys];
  try {
    // Write every shard before publishing the manifest. A process kill can
    // leave unreachable new shards, but never a manifest with missing data.
    for (let i = 0; i < chunks.length; i += PRIME_CHUNK) {
      // eslint-disable-next-line no-await-in-loop
      await AsyncStorage.multiSet(
        chunks.slice(i, i + PRIME_CHUNK).map((chunk, offset) => [
          newShardKeys[i + offset],
          JSON.stringify(chunk),
        ])
      );
    }
    await AsyncStorage.setItem(
      KEY(albumId),
      JSON.stringify({ version: 2, count: list.length, shards: shardKeys })
    );
    const stale = oldShards.filter((key) => !shardKeys.includes(key));
    if (stale.length > 0) AsyncStorage.multiRemove(stale).catch(() => {});
  } catch (e) {
    // Retained shards still belong to the previous live manifest.
    AsyncStorage.multiRemove(newShardKeys).catch(() => {});
    throw e;
  }
}

/**
 * Compatibility hook for callers entering a category/time view. Decisions
 * are intentionally global per media type: an asset handled in QQ must not
 * reappear in All Photos, Camera, or a time-scoped view.
 */
export function activateRound(mediaType) {
  return scopeFor(mediaType);
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
          !suffix.startsWith('v:') &&
          !suffix.startsWith('shard_v2_')
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
      const ids = [...merged];
      // The marker is written only after the destination succeeds. A failed
      // destination write must be retried on the next launch.
      await withLock(KEY(scopeFor('photo')), () =>
        writeStoredList(scopeFor('photo'), ids)
      );
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
  let raw;
  try {
    raw = await AsyncStorage.getItem(KEY(albumId));
  } catch (e) {
    unreadable.add(albumId);
    return null;
  }
  const { ok, list: storedList } = await decodeStoredValue(albumId, raw);
  if (!ok) {
    unreadable.add(albumId); // NOT memoized — a later call retries the read
    return null;
  }
  unreadable.delete(albumId);
  let list = storedList;
  if (albumId === scopeFor('photo') && list.length === 0) {
    list = await migrateLegacyPhotoHistory();
  }
  const set = new Set(list);
  memo.set(albumId, set);
  return set;
}

async function flushAlbum(albumId) {
  if (!dirty.has(albumId)) return inFlightFlushes.get(albumId) || true;
  dirty.delete(albumId);
  const set = memo.get(albumId);
  if (!set || unreadable.has(albumId)) return false;
  const task = withLock(KEY(albumId), async () => {
    try {
      await writeStoredList(albumId, [...set], {
        forceRewrite: rewriteRequired.has(albumId),
      });
      // A mutation during the async write marks the album dirty again. Keep
      // the rewrite flag in that case so a concurrent removal is not lost.
      if (!dirty.has(albumId)) rewriteRequired.delete(albumId);
      return true;
    } catch (e) {
      dirty.add(albumId); // retry on the next flush rather than lose it
      return false;
    }
  });
  inFlightFlushes.set(albumId, task);
  task.finally(() => {
    if (inFlightFlushes.get(albumId) === task) {
      inFlightFlushes.delete(albumId);
    }
  });
  return task;
}

/**
 * Write every pending album now. Returns false if any value could not be made
 * durable; the dirty flag stays set so a user action or background event can
 * retry without losing the in-memory decision.
 */
export async function flushReviewed() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // Drain mutations that arrived while an earlier write was in flight. A
  // confirmed cleaning group publishes its session checkpoint only after
  // this returns true, so "not in the window" always means "on disk".
  while (dirty.size > 0 || inFlightFlushes.size > 0) {
    const pending = new Set([...dirty, ...inFlightFlushes.keys()]);
    // Serial writes keep only one large `[...set]` snapshot alive. A single
    // group can touch global/all/current plus several iOS collections; doing
    // those 100k-id copies in parallel caused a sharp memory peak.
    for (const id of pending) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await flushAlbum(id).catch(() => false);
      if (!ok) return false;
    }
  }
  return true;
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
  if (!set) return null;
  // A FRESH Set per call: CleaningScreen adds to the set it gets back, and
  // handing out the memo itself would let that mutation rewrite history.
  return new Set(set);
}

/** Drop a clean, non-global memo entry after a one-off progress query. */
export function releaseReviewed(albumId) {
  if (
    !albumId ||
    albumId.startsWith('global:') ||
    dirty.has(albumId) ||
    inFlightFlushes.has(albumId) ||
    mutationPins.has(albumId) ||
    unreadable.has(albumId)
  ) {
    return;
  }
  memo.delete(albumId);
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
  if (list.length === 0) return true;
  const type = mediaType === 'video' ? 'video' : 'photo';
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
  const targets = [
    ...[...byAlbum].map(([albumId, ids]) => [
      albumScopeFor(mediaType, albumId),
      ids,
    ]),
    // Global is the authority that removes ids from future cleaning pools.
    // Write it last so an earlier album-scope failure cannot publish a
    // half-complete decision that skips the group after restart.
    [scopeFor(mediaType), list.map((asset) => asset.id)],
  ];
  const loaded = [];
  // Validate every destination before mutating any of them. Otherwise a
  // transient read failure in one album scope could leave the global set
  // dirty, report failure, and later commit only half of the decision.
  targets.forEach(([scope]) => pinMutation(scope));
  try {
    for (const [scope, ids] of targets) {
      // eslint-disable-next-line no-await-in-loop
      const set = await load(scope);
      if (!set) return false;
      loaded.push([scope, ids, set]);
    }
    for (const [scope, ids, set] of loaded) {
      ids.forEach((id) => set.add(id));
      dirty.add(scope);
    }
    scheduleFlush();
    return true;
  } finally {
    targets.forEach(([scope]) => unpinMutation(scope));
  }
}

/** Remove only one album's ids when that album starts a new review round. */
export async function removeReviewed(albumId, ids) {
  const set = await load(albumId);
  if (!set) return null;
  ids.forEach((item) => set.delete(typeof item === 'string' ? item : item?.id));
  rewriteRequired.add(albumId);
  dirty.add(albumId);
  scheduleFlush();
  return new Set(set);
}

export async function clearReviewed(albumId) {
  return withLock(KEY(albumId), async () => {
    memo.set(albumId, new Set()); // authoritative: this album is now empty
    unreadable.delete(albumId);
    dirty.delete(albumId);
    rewriteRequired.delete(albumId);
    try {
      const raw = await AsyncStorage.getItem(KEY(albumId));
      let shards = [];
      try {
        const value = raw ? JSON.parse(raw) : null;
        if (value?.version === 2 && Array.isArray(value.shards)) {
          shards = value.shards;
        }
      } catch (e) {
        // Removing the manifest still clears an unreadable reviewed set.
      }
      await AsyncStorage.removeItem(KEY(albumId));
      if (shards.length > 0) AsyncStorage.multiRemove(shards).catch(() => {});
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
          const decoded = await decodeStoredValue(albumId, raw);
          if (!decoded.ok) throw new Error('Unreadable reviewed shards');
          let list = decoded.list;
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

/**
 * Read progress counts for a picker without retaining every album's Set.
 * A device may expose 150+ collections, each with thousands of overlapping
 * ids; memoizing all of them turns a tiny progress UI into tens of MB.
 * Dirty/current scopes still come from the authoritative memo.
 */
export async function getProgressCounts(albumIds) {
  const counts = {};
  const missing = [];
  const seen = new Set();
  for (const id of albumIds || []) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const cached = memo.get(id);
    if (cached) counts[id] = cached.size;
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += PRIME_CHUNK) {
    const part = missing.slice(i, i + PRIME_CHUNK);
    try {
      // eslint-disable-next-line no-await-in-loop
      const pairs = await AsyncStorage.multiGet(part.map(KEY));
      const byKey = new Map(pairs);
      for (const id of part) {
        const raw = byKey.get(KEY(id));
        if (!raw) {
          if (id === scopeFor('photo')) {
            // Preserve the one-time migration from pre-global album keys.
            // eslint-disable-next-line no-await-in-loop
            const migrated = await load(id);
            counts[id] = migrated ? migrated.size : 0;
            continue;
          }
          counts[id] = 0;
          continue;
        }
        try {
          const count = storedCount(raw);
          if (count !== null) counts[id] = count;
        } catch (e) {
          // Corrupt/unknown values are omitted rather than reported as zero.
        }
      }
    } catch (e) {
      // This chunk simply has no progress rings for the current visit.
    }
  }
  return counts;
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

export async function getProgressForIds(albumId, assetIds) {
  await load(albumId);
  return getProgressForIdsSync(albumId, assetIds);
}

/** Progress for a single album. Moving/categorizing also adds to reviewed. */
export async function getProgress(albumId, total) {
  await load(albumId);
  return getProgressSync(albumId, total);
}
