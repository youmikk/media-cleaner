import * as MediaLibrary from 'expo-media-library';
// SDK 54: use the stable legacy file-system API (getInfoAsync etc.).
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { utf8ByteLength, MAX_VALUE_BYTES, withLock } from './safeStore';
import { log } from './logger';
import { runMediaWork } from './mediaWorkScheduler';

export const ALL_ALBUM_ID = 'all';
const PAGE_SIZE = 200;
const MAX_ASSETS = 20000; // safety cap for very large libraries
const ALBUMS_TTL_MS = 30000;
const FINGERPRINT_TTL_MS = 5000;
// A follow-up page slower than this is worth a log line; the rest are noise.
const SLOW_PAGE_MS = 150;
const albumsMemoryCache = new Map();
const fingerprintMemoryCache = new Map();
const fingerprintPromises = new Map();
let fingerprintGeneration = 0;
let rawAlbumsPromise = null;
const ALBUMS_CACHE_PREFIX = '@mediacleaner/albums_v1_';
const PREVIEW_CACHE_PREFIX = '@mediacleaner/preview_v1_';
const assetInfoMemoryCache = new Map();
// AssetInfo objects can include large EXIF/location payloads. Keep enough to
// make revisiting suggestion groups instant without retaining an unbounded
// copy of every asset inspected during the process lifetime.
const ASSET_INFO_CACHE_LIMIT = 2000;
const assetFetchPromises = new Map();
const SNAPSHOT_SAMPLE = 60; // size sampling cap when there is no native query
const SNAPSHOT_CONCURRENCY = 6;
// Assets measured for real per album snapshot. Cheap on Android (a cursor),
// a few hundred ms on iOS for a big album — past this the average of 4000
// real sizes is accurate enough that reading more only costs latency.
const EXACT_SIZE_CAP = 4000;
// Ids per native size query. The native side re-chunks internally; this only
// bounds how much crosses the bridge at once.
const SIZE_QUERY_CHUNK = 4000;
const IOS_SIZE_QUERY_CHUNK = 256;
const LIBRARY_SIZE_KEY = '@mediacleaner/library_size';
const LIBRARY_SIZE_GRACE_MS = 15 * 60 * 1000;
// A slim asset serialises to ~300 B, so this is the point past which the
// list cannot fit under the per-value storage ceiling.
const MAX_CACHED_LIST = 4800;
// getAssetsByIds cap. Exposed so callers can tell the user when a selection
// was trimmed instead of silently cleaning a subset.
export const MAX_ASSETS_BY_IDS = 600;

function getCachedAssetInfo(id) {
  const value = assetInfoMemoryCache.get(id);
  if (!value) return null;
  // Map iteration order is insertion order: reinserting makes this the most
  // recently used entry without maintaining a second linked structure.
  assetInfoMemoryCache.delete(id);
  assetInfoMemoryCache.set(id, value);
  return value;
}

function cacheAssetInfo(id, value) {
  if (!value) return;
  assetInfoMemoryCache.delete(id);
  assetInfoMemoryCache.set(id, value);
  while (assetInfoMemoryCache.size > ASSET_INFO_CACHE_LIMIT) {
    const oldest = assetInfoMemoryCache.keys().next().value;
    assetInfoMemoryCache.delete(oldest);
  }
}

/**
 * The raw device album list, memoised for ALBUMS_TTL_MS.
 *
 * `getAlbumsAsync({includeSmartAlbums:true})` is one of the most expensive
 * calls in the app — 116 ms warm but 4.5 s on a cold MediaStore cursor with
 * 150+ albums — and five different places wanted it. Sharing one memo keeps
 * a screen that needs the list (the categorize chips) from racing the first
 * photo decode for the native media thread.
 */
export async function getRawAlbums({ force = false } = {}) {
  const cached = albumsMemoryCache.get('raw');
  if (!force && cached && Date.now() - cached.at < ALBUMS_TTL_MS) {
    return cached.value;
  }
  if (!force && rawAlbumsPromise) return rawAlbumsPromise;
  const promise = (async () => {
    const startedAt = Date.now();
    const albums = await runMediaWork(
      () => MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true }),
      'interactive'
    );
    log('perf', `getAlbumsAsync raw ${Date.now() - startedAt}ms count=${albums.length}`);
    albumsMemoryCache.set('raw', { at: Date.now(), value: albums });
    return albums;
  })();
  rawAlbumsPromise = promise;
  try {
    return await promise;
  } finally {
    if (rawAlbumsPromise === promise) rawAlbumsPromise = null;
  }
}

/**
 * List device albums for the given media type, prefixed by a synthetic
 * "All Photos"/"All Videos" entry.
 */
export async function getAlbums(mediaType, allLabel) {
  // getAlbumsAsync exposes a mixed photo+video assetCount. Keep separate
  // typed caches; sharing one made the photos tab overwrite the video list.
  const cacheKey = `library_${mediaType}`;
  const cached = albumsMemoryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ALBUMS_TTL_MS) {
    // Keep the synthetic "All" label in the current locale when the user
    // changes language while the short-lived album cache is warm.
    //
    // COPY, never write into cached.value: photos and videos share this one
    // entry but pass DIFFERENT labels for row 0, so relabelling in place made
    // whichever tab asked last silently retitle the other tab's list too.
    const result =
      cached.value.length > 0
        ? [{ ...cached.value[0], title: allLabel }, ...cached.value.slice(1)]
        : cached.value;
    // `age`, NOT a duration: this branch did no work. Logging it as "…ms"
    // made a 19-second-old cache hit read like a 19-second call.
    log('perf', `getAlbums ${mediaType} cache-hit age=${Date.now() - cached.at}ms count=${result.length}`);
    return result;
  }
  // Android's MediaStore album query can take several seconds on large
  // libraries. Use the last known list immediately, then refresh it for the
  // next visit in the background.
  try {
    const raw = await AsyncStorage.getItem(`${ALBUMS_CACHE_PREFIX}${cacheKey}`);
    const stored = raw ? JSON.parse(raw) : null;
    if (Array.isArray(stored) && stored.length > 0) {
      // Older caches may contain collections that have since become empty or
      // inaccessible. Do not briefly expose them and enqueue pointless work
      // while the background refresh catches up.
      const result = stored
        .filter(
          (a) =>
            a.id === ALL_ALBUM_ID ||
            a.assetCount === undefined ||
            Number(a.assetCount) > 0
        )
        .map((a) =>
          a.id === ALL_ALBUM_ID ? { ...a, title: allLabel } : a
        );
      albumsMemoryCache.set(cacheKey, { at: Date.now(), value: result });
      refreshAlbums(mediaType, allLabel).catch(() => {});
      log('perf', `getAlbumsAsync ${mediaType} persisted-cache count=${result.length}`);
      return result;
    }
  } catch (e) {
    // Fall through to the native query.
  }
  return refreshAlbums(mediaType, allLabel);
}

async function refreshAlbums(mediaType, allLabel) {
  const cacheKey = `library_${mediaType}`;
  const startedAt = Date.now();
  try {
    const albums = await getRawAlbums();
    const result = [{ id: ALL_ALBUM_ID, title: allLabel, assetCount: undefined }];
    // Query exact typed totals in small batches. Running all 150+ album
    // cursors together overwhelms MediaStore/PhotoKit on real devices.
    for (let i = 0; i < albums.length; i += 4) {
      const typed = await runMediaWork(
        () =>
          Promise.all(
            albums.slice(i, i + 4).map(async (album) => {
              try {
                const page = await MediaLibrary.getAssetsAsync({
                  album: album.id,
                  mediaType,
                  first: 1,
                });
                return page.totalCount > 0
                  ? { id: album.id, title: album.title, assetCount: page.totalCount }
                  : null;
              } catch (e) {
                return null;
              }
            })
          ),
        'interactive'
      );
      for (const album of typed) if (album) result.push(album);
    }
    log(
      'perf',
      `getAlbums ${mediaType} ${Date.now() - startedAt}ms count=${result.length}`
    );
    albumsMemoryCache.set(cacheKey, { at: Date.now(), value: result });
    AsyncStorage.setItem(
      `${ALBUMS_CACHE_PREFIX}${cacheKey}`,
      JSON.stringify(result)
    ).catch(() => {});
    return result;
  } catch (e) {
    log('perf', `getAlbums ${mediaType} failed ${Date.now() - startedAt}ms`);
    throw e;
  }
}

/**
 * Fetch ONE page of assets (for progressive loading — first page shows
 * immediately, the rest streams in the background).
 *
 * `range` ({start, end} in ms) is pushed down to the MEDIA STORE via
 * createdAfter/createdBefore instead of being filtered in JS. Paging the
 * whole library just to keep one month of it is why time-scoped screens
 * took many seconds to show anything on a large library.
 */
export async function getAssetsPage(
  albumId,
  mediaType,
  after,
  range = null,
  priority = 'interactive'
) {
  const startedAt = Date.now();
  const options = {
    first: PAGE_SIZE,
    mediaType,
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
  };
  if (after) options.after = after;
  if (albumId && albumId !== ALL_ALBUM_ID) options.album = albumId;
  if (range && range.start) options.createdAfter = range.start;
  // createdBefore is exclusive of the boundary in practice; the callers'
  // own `< end` filter still runs, so an off-by-one here can't leak.
  if (range && range.end) options.createdBefore = range.end;
  try {
    const page = await runMediaWork(
      () => MediaLibrary.getAssetsAsync(options),
      priority
    );
    // Only the FIRST page (which is what "how fast did the screen open?"
    // actually measures) and pages that were slow enough to matter. Logging
    // every page meant a 13k-photo library wrote 66 lines per home refresh,
    // which flushed the real diagnostics out of the 1500-line ring buffer.
    const spent = Date.now() - startedAt;
    if (!after || spent > SLOW_PAGE_MS) {
      log(
        'perf',
        `getAssetsPage ${mediaType}/${albumId || ALL_ALBUM_ID} ${spent}ms ` +
          `count=${page.assets.length} after=${after ? '1' : '0'}`
      );
    }
    return {
      assets: page.assets,
      hasNext: page.hasNextPage && page.assets.length > 0,
      endCursor: page.endCursor,
    };
  } catch (e) {
    log(
      'perf',
      `getAssetsPage ${mediaType}/${albumId || ALL_ALBUM_ID} failed ${Date.now() - startedAt}ms`
    );
    throw e;
  }
}

/**
 * A handful of preview assets for a time range — ONE scoped media-store
 * query, no paging. Used by the home cards when a year/month is picked.
 */
/** Cached first preview used by album selectors while MediaStore warms up. */
export async function getCachedPreview(albumId, mediaType) {
  try {
    const raw = await AsyncStorage.getItem(
      `${PREVIEW_CACHE_PREFIX}${mediaType}_${albumId || ALL_ALBUM_ID}`
    );
    const assets = raw ? JSON.parse(raw) : null;
    return Array.isArray(assets) ? assets : null;
  } catch (e) {
    return null;
  }
}

export function saveCachedPreview(albumId, mediaType, assets) {
  if (!Array.isArray(assets) || assets.length === 0) return;
  AsyncStorage.setItem(
    `${PREVIEW_CACHE_PREFIX}${mediaType}_${albumId || ALL_ALBUM_ID}`,
    JSON.stringify(assets.slice(0, 3).map((a) => ({
      id: a.id,
      uri: a.uri,
      mediaType: a.mediaType,
      width: a.width,
      height: a.height,
    })))
  ).catch(() => {});
}

export async function getRangeThumbs(albumId, mediaType, range, count = 3) {
  try {
    const options = {
      first: count,
      mediaType,
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    };
    if (albumId && albumId !== ALL_ALBUM_ID) options.album = albumId;
    if (range && range.start) options.createdAfter = range.start;
    if (range && range.end) options.createdBefore = range.end;
    const page = await runMediaWork(
      () => MediaLibrary.getAssetsAsync(options),
      'interactive'
    );
    return page.assets.map((a) => ({ id: a.id, uri: a.uri }));
  } catch (e) {
    return [];
  }
}

/**
 * Fetch all assets of an album (paginated), newest first.
 *
 * `limit` stops the paging early. Callers that only want the newest N (the
 * analyzer wants 3000) were otherwise walking the entire library — 79 native
 * round trips on a 15k-photo device — and throwing most of it away.
 */
export async function getAssets(
  albumId,
  mediaType,
  limit = MAX_ASSETS,
  priority = 'interactive'
) {
  const cap = Math.min(limit, MAX_ASSETS);
  const key = `${mediaType}/${albumId || ALL_ALBUM_ID}/${cap}`;
  let promise = assetFetchPromises.get(key);
  if (!promise) {
    promise = (async () => {
      const assets = [];
      let after;
      let hasNext = true;
      while (hasNext && assets.length < cap) {
        const options = {
          first: PAGE_SIZE,
          mediaType,
          sortBy: [[MediaLibrary.SortBy.creationTime, false]],
        };
        if (after) options.after = after;
        if (albumId && albumId !== ALL_ALBUM_ID) options.album = albumId;
        // eslint-disable-next-line no-await-in-loop
        const page = await runMediaWork(
          () => MediaLibrary.getAssetsAsync(options),
          priority
        );
        assets.push(...page.assets);
        hasNext = page.hasNextPage && page.assets.length > 0;
        after = page.endCursor;
      }
      return assets.length > cap ? assets.slice(0, cap) : assets;
    })();
    assetFetchPromises.set(key, promise);
  }
  try {
    // Callers may sort/filter in place; never share the resolved array itself.
    return (await promise).slice();
  } finally {
    if (assetFetchPromises.get(key) === promise) assetFetchPromises.delete(key);
  }
}

export async function getAssetsByIds(ids) {
  // Parallel (8-wide) and hard-capped: the old serial loop stalled for
  // tens of seconds on large id lists (Low-Quality with hundreds of hits
  // looked like "the screen won't open").
  const capped = ids.slice(0, MAX_ASSETS_BY_IDS);
  const out = [];
  const missing = [];
  for (const id of capped) {
    const cached = getCachedAssetInfo(id);
    if (cached) out.push(cached);
    else missing.push(id);
  }
  const CONC = 8;
  for (let i = 0; i < missing.length; i += CONC) {
    const batch = missing.slice(i, i + CONC);
    // eslint-disable-next-line no-await-in-loop
    const infos = await runMediaWork(
      () =>
        Promise.all(
          batch.map(async (id) => {
            try {
              const info = await MediaLibrary.getAssetInfoAsync(id);
              if (info) cacheAssetInfo(id, info);
              return info;
            } catch (e) {
              return null; // asset may have been deleted meanwhile
            }
          })
        ),
      'interactive'
    );
    for (const info of infos) if (info) out.push(info);
  }
  const byId = new Map(out.map((a) => [a.id, a]));
  out.length = 0;
  for (const id of capped) {
    const asset = byId.get(id) || getCachedAssetInfo(id);
    if (asset) out.push(asset);
  }
  // Non-enumerable so existing `.map`/`.length` callers are unaffected, but
  // a caller that cares can tell the user "600 of 1500 shown" instead of
  // reporting "all done" over a silently trimmed selection.
  Object.defineProperty(out, 'truncated', {
    value: ids.length > MAX_ASSETS_BY_IDS,
    enumerable: false,
  });
  Object.defineProperty(out, 'totalRequested', {
    value: ids.length,
    enumerable: false,
  });
  return out;
}

/**
 * Best-effort file size for an asset, in bytes.
 */
async function getAssetSizeRaw(asset) {
  const id = asset && asset.id ? asset.id : asset;
  // System index first (native module): under Android scoped storage,
  // stat-ing another app's media file often reports 0/not-found, and on iOS
  // the stat path costs two native round-trips per photo.
  try {
    // eslint-disable-next-line global-require
    const PhotoMove = require('../../modules/photo-move');
    // hasNativeSizes(), not isAvailable(): getSizes now exists on BOTH
    // platforms, but an older installed binary (or Expo Go) has the module
    // without it, and calling it there just throws into a swallowed catch.
    if (PhotoMove.hasNativeSizes()) {
      const sizes = await PhotoMove.getSizes([String(id)]);
      const s = sizes[String(id).split('/')[0]];
      if (s > 0) return s;
    }
  } catch (e) {
    // fall through to file stats
  }
  try {
    const info = asset.localUri
      ? asset
      : await MediaLibrary.getAssetInfoAsync(id);
    const uri = info.localUri || info.uri;
    if (!uri) return 0;
    const stat = await FileSystem.getInfoAsync(uri, { size: true });
    return stat.exists && stat.size ? stat.size : 0;
  } catch (e) {
    return 0;
  }
}

export async function getAssetSize(asset, { priority = 'interactive' } = {}) {
  return runMediaWork(() => getAssetSizeRaw(asset), priority);
}

/**
 * Whole-library index from ONE native scan: ids, timestamps, dimensions and
 * — the part expo-media-library cannot give us — the byte size of every
 * asset. Held in memory briefly so the several callers that all want some
 * slice of it during one screen visit share a single scan.
 */
let scanCache = null; // {at, mediaType, index}
let scanPromise = null;
let scanGeneration = 0;
const SCAN_TTL_MS = 15 * 60 * 1000;

function buildIndex(raw) {
  const ids = raw.ids || [];
  const sizes = raw.size || [];
  const sizeById = new Map();
  for (let i = 0; i < ids.length; i++) {
    if (sizes[i] > 0) sizeById.set(ids[i], sizes[i]);
  }
  return {
    ids,
    creationTime: raw.creationTime || [],
    mediaType: raw.mediaType || [],
    sizeById,
    total: raw.total || ids.length,
  };
}

/** The cached scan if it is warm — never triggers one. */
function peekLibraryIndex(mediaType = 'all') {
  if (!scanCache) return null;
  if (scanCache.mediaType !== mediaType && scanCache.mediaType !== 'all') {
    return null;
  }
  if (new Date().getTime() - scanCache.at > SCAN_TTL_MS) return null;
  return scanCache.index;
}

/**
 * Read (or reuse) the whole-library scan. Returns null when the native
 * module can't do it — Expo Go and binaries built before scanLibrary existed
 * keep working through the per-query paths.
 */
export async function getLibraryIndex(
  mediaType = 'all',
  { force = false, priority = 'background' } = {}
) {
  if (!force) {
    const warm = peekLibraryIndex(mediaType);
    if (warm) return warm;
  }
  // eslint-disable-next-line global-require
  const PhotoMove = require('../../modules/photo-move');
  if (!PhotoMove.hasScanLibrary()) return null;
  if (!force && scanPromise && scanPromise.mediaType === mediaType) {
    return scanPromise.promise;
  }
  const promise = (async () => {
  try {
    const generation = scanGeneration;
    const started = new Date().getTime();
    let raw;
    if (Platform.OS === 'ios' && PhotoMove.hasScanLibraryMetadata()) {
      raw = await runMediaWork(
        () => PhotoMove.scanLibraryMetadata(mediaType, 0),
        priority
      );
      const ids = raw.ids || [];
      const measured = new Array(ids.length).fill(0);
      // PHAssetResource enumeration is split into short chunks. The total
      // work is similar, but a foreground page/fingerprint query can run
      // between chunks instead of waiting behind a 5-180 second native call.
      for (let i = 0; i < ids.length; i += IOS_SIZE_QUERY_CHUNK) {
        const part = ids.slice(i, i + IOS_SIZE_QUERY_CHUNK);
        // eslint-disable-next-line no-await-in-loop
        const sizes = await runMediaWork(
          () => PhotoMove.getSizes(part),
          priority
        );
        for (let j = 0; j < part.length; j++) {
          measured[i + j] = Number(sizes[part[j]]) || 0;
        }
      }
      raw = { ...raw, size: measured };
    } else {
      raw = await runMediaWork(
        () => PhotoMove.scanLibrary(mediaType, 0),
        priority
      );
    }
    const index = buildIndex(raw);
    if (generation !== scanGeneration) {
      log('size', `scan ${mediaType} discarded after library change`);
      return null;
    }
    scanCache = { at: new Date().getTime(), mediaType, index };
    log(
      'size',
      `scan ${mediaType}: ${index.ids.length}/${index.total} in ` +
        `${new Date().getTime() - started}ms`
    );
    return index;
  } catch (e) {
    log('size', `scan failed: ${(e && e.message) || e}`);
    return null;
  }
  })();
  scanPromise = { mediaType, promise };
  try {
    return await promise;
  } finally {
    if (scanPromise && scanPromise.promise === promise) scanPromise = null;
  }
}

/** Drop the cached scan — call after deleting or moving assets. */
export function invalidateLibraryIndex() {
  scanGeneration += 1;
  fingerprintGeneration += 1;
  scanCache = null;
  scanPromise = null;
  fingerprintMemoryCache.clear();
  albumsMemoryCache.clear();
}

/**
 * Delete-aware alternative to invalidateLibraryIndex(): remove the given ids
 * from the cached scan instead of throwing the whole thing away.
 *
 * Deleting does not change the size of any SURVIVING asset, so a full rescan
 * afterwards recomputes information we already hold. It is also expensive —
 * ~5.5s of JS-thread work on a 4700-asset library — and it was being paid
 * once per confirmed group, because the very next album snapshot re-triggered
 * it. Worse, the analyser's batch loop ran straight into it (the log shows
 * `analysis-slow … spent=5580ms budget=84ms`), so low-quality detection
 * stalled for seconds at a time throughout a cleaning session.
 *
 * The album/fingerprint caches ARE still cleared — counts really did change.
 */
export function pruneLibraryIndex(deletedIds = []) {
  scanGeneration += 1;
  fingerprintGeneration += 1;
  fingerprintMemoryCache.clear();
  albumsMemoryCache.clear();
  scanPromise = null;
  if (!scanCache || deletedIds.length === 0) return;
  // Ids arrive in expo-media-library's "<id>/L0/001" form on iOS; the scan is
  // keyed by the bare MediaStore/PhotoKit id.
  const gone = new Set(deletedIds.map((id) => String(id).split('/')[0]));
  const old = scanCache.index;
  const ids = [];
  const creationTime = [];
  const mediaType = [];
  for (let i = 0; i < old.ids.length; i++) {
    if (gone.has(old.ids[i])) {
      old.sizeById.delete(old.ids[i]);
      continue;
    }
    ids.push(old.ids[i]);
    creationTime.push(old.creationTime[i]);
    mediaType.push(old.mediaType[i]);
  }
  scanCache = {
    // Keep the ORIGINAL timestamp: pruning refreshes the contents but must
    // not extend the scan's 60s life, or a library changed outside the app
    // could stay stale indefinitely across a long session.
    at: scanCache.at,
    mediaType: scanCache.mediaType,
    index: {
      ids,
      creationTime,
      mediaType,
      sizeById: old.sizeById,
      total: ids.length,
    },
  };
}

/** Keep the persisted storage chart exact after deletions without rescanning. */
export async function adjustLibrarySizeAfterDeletion(assets, sizesById = {}) {
  const list = (assets || []).filter((asset) => asset && asset.id);
  if (list.length === 0) return;
  await withLock(LIBRARY_SIZE_KEY, async () => {
    try {
      const raw = await AsyncStorage.getItem(LIBRARY_SIZE_KEY);
      const cached = raw ? JSON.parse(raw) : null;
      if (!cached?.value) return;
      const next = { ...cached.value };
      let unknownSize = false;
      for (const asset of list) {
        const bytes = Number(sizesById[asset.id]) || 0;
        if (!(bytes > 0)) unknownSize = true;
        if (asset.mediaType === 'video') {
          next.videoCount = Math.max(0, (next.videoCount || 0) - 1);
          next.videoBytes = Math.max(0, (next.videoBytes || 0) - bytes);
        } else {
          next.photoCount = Math.max(0, (next.photoCount || 0) - 1);
          next.photoBytes = Math.max(0, (next.photoBytes || 0) - bytes);
        }
      }
      next.bytes = Math.max(
        0,
        (next.photoBytes || 0) + (next.videoBytes || 0)
      );
      if (unknownSize) next.exact = false;
      await AsyncStorage.setItem(
        LIBRARY_SIZE_KEY,
        JSON.stringify({ fingerprint: null, value: next, updatedAt: Date.now() })
      );
    } catch (e) {
      // Best effort: a failed adjustment only causes a later refresh.
    }
  });
}

/**
 * Ask the native module for {id: bytes} over an arbitrarily long id list.
 * Returns null when the module can't answer at all, so callers can tell
 * "unavailable" apart from "answered, some ids unknown".
 */
async function nativeSizes(ids, priority = 'interactive') {
  if (ids.length === 0) return null;
  // A warm library scan already holds every size, so the fastest query is
  // no query. Only *warm* — scanning on demand to answer a five-id question
  // would cost far more than it saves.
  const index = peekLibraryIndex('all');
  if (index) {
    const out = {};
    for (const id of ids) {
      const s = index.sizeById.get(String(id).split('/')[0]);
      if (s > 0) out[String(id).split('/')[0]] = s;
    }
    return out;
  }
  // eslint-disable-next-line global-require
  const PhotoMove = require('../../modules/photo-move');
  if (!PhotoMove.hasNativeSizes()) return null;
  const out = {};
  try {
    for (let i = 0; i < ids.length; i += SIZE_QUERY_CHUNK) {
      const part = ids.slice(i, i + SIZE_QUERY_CHUNK);
      // eslint-disable-next-line no-await-in-loop
      const sizes = await runMediaWork(
        () => PhotoMove.getSizes(part),
        priority
      );
      Object.assign(out, sizes);
    }
  } catch (e) {
    log('size', `native getSizes failed: ${(e && e.message) || e}`);
    return null;
  }
  return out;
}

/**
 * Batch sizes for many assets: ONE system-index query via the native module
 * (MediaStore on Android, PhotoKit on iOS) when available, per-file stats
 * otherwise. Returns {assetId: bytes}.
 */
export async function getAssetSizes(
  assets,
  { priority = 'interactive' } = {}
) {
  const out = {};
  const sizes = await nativeSizes(
    assets.map((a) => String(a.id)),
    priority
  );
  if (sizes) {
    let missing = 0;
    for (const a of assets) {
      const s = sizes[String(a.id).split('/')[0]];
      if (s > 0) out[a.id] = s;
      else missing++;
    }
    if (missing === 0) return out;
    log('size', `native covered ${assets.length - missing}/${assets.length}`);
  }
  // Fallback: run it CONCURRENTLY. The old serial loop meant two awaited
  // native calls per asset — hundreds of assets took tens of seconds, which
  // is why "largest files" felt broken on iOS.
  const pending = assets.filter((a) => !(out[a.id] > 0));
  for (let i = 0; i < pending.length; i += SNAPSHOT_CONCURRENCY) {
    const batch = pending.slice(i, i + SNAPSHOT_CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop
    const stats = await runMediaWork(
      () => Promise.all(batch.map((a) => getAssetSizeRaw(a))),
      priority
    );
    batch.forEach((a, k) => {
      out[a.id] = stats[k];
    });
  }
  return out;
}

/**
 * Pick at most `n` items spread EVENLY across the list.
 *
 * Taking the first n instead is what made album size estimates so wrong:
 * assets come back newest-first, and the newest photos are systematically
 * the largest (newer phone, bigger sensor), so the head over-estimated
 * every big album.
 */
function spread(list, n) {
  if (list.length <= n) return list;
  const step = list.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

/**
 * Compute a storage snapshot {count, bytes} for an album.
 *
 * Preferred path: the whole-library scan already carries every size, so the
 * album is summed EXACTLY with no query of its own. That also retires the
 * old "measure 4000 of them and extrapolate" compromise, which on a 15k
 * library meant a 4000-id batch query every time a cleaning session started.
 *
 * Without the scan it falls back to a batched size query over an evenly
 * spread subset, and without that to per-file stats.
 */
export async function getAlbumSnapshot(albumId, mediaType, precomputedAssets) {
  const assets =
    precomputedAssets ||
    (await getAssets(albumId, mediaType, MAX_ASSETS, 'background'));
  if (assets.length === 0) return { count: 0, bytes: 0 };

  const index = await getLibraryIndex('all');
  if (index) {
    let bytes = 0;
    let measured = 0;
    for (const a of assets) {
      const s = index.sizeById.get(String(a.id).split('/')[0]);
      if (s > 0) {
        bytes += s;
        measured++;
      }
    }
    if (measured > 0) {
      // Ids the scan couldn't size (iCloud-only originals) must not shrink
      // the total — spread the measured average over them.
      const total =
        measured === assets.length
          ? bytes
          : Math.round((bytes / measured) * assets.length);
      log('size', `${albumId}/${mediaType}: scan ${measured}/${assets.length}`);
      return { count: assets.length, bytes: total };
    }
  }

  const capped = assets.slice(0, MAX_ASSETS);
  const target = spread(capped, EXACT_SIZE_CAP);
  const sizes = await nativeSizes(
    target.map((a) => String(a.id)),
    'background'
  );
  if (sizes) {
    let bytes = 0;
    let measured = 0;
    for (const a of target) {
      const s = sizes[String(a.id).split('/')[0]];
      if (s > 0) {
        bytes += s;
        measured++;
      }
    }
    if (measured > 0) {
      const total = Math.round((bytes / measured) * assets.length);
      log('size', `${albumId}/${mediaType}: native ${measured}/${assets.length}`);
      return { count: assets.length, bytes: total };
    }
    log('size', `${albumId}/${mediaType}: native returned no sizes`);
  }

  // Sampled fallback (Expo Go / older binaries): parallel per-file stats.
  const sample = spread(capped, SNAPSHOT_SAMPLE);
  let sampleBytes = 0;
  for (let i = 0; i < sample.length; i += SNAPSHOT_CONCURRENCY) {
    const batch = sample.slice(i, i + SNAPSHOT_CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop
    const stats = await runMediaWork(
      () => Promise.all(batch.map((a) => getAssetSizeRaw(a))),
      'background'
    );
    for (const s of stats) sampleBytes += s;
  }
  log(
    'size',
    `${albumId}/${mediaType}: sampled ${sample.length} -> ${sampleBytes}B`
  );
  const bytes =
    sample.length > 0
      ? Math.round((sampleBytes / sample.length) * assets.length)
      : 0;
  return { count: assets.length, bytes };
}

/**
 * Real size of the user's whole photo + video library.
 *
 * Prefers the native whole-library query (exact, straight off the system
 * index, no per-file I/O) and caches it against the library fingerprint, so
 * repeat visits cost nothing.
 *
 * Returns null when only the SLOW path is left (Expo Go, binaries built
 * before librarySize existed): walking every page of a 20k-asset library to
 * size 60 of them is not something a screen should do on entry — callers
 * fall back to the stored lifetime reference instead. Pass
 * allowSlowFallback for the rare caller that really wants a number.
 *
 * Otherwise {bytes, photoBytes, videoBytes, photoCount, videoCount, exact}.
 */
export async function getLibrarySize({
  force = false,
  allowSlowFallback = false,
} = {}) {
  let storedSize = null;
  if (!force) {
    try {
      const raw = await AsyncStorage.getItem(LIBRARY_SIZE_KEY);
      storedSize = raw ? JSON.parse(raw) : null;
      // During this grace period in-app deletions update the cached totals
      // exactly. Returning before even querying fingerprints keeps Profile
      // from touching PhotoKit on every focus.
      if (
        storedSize?.value &&
        storedSize.updatedAt &&
        Date.now() - storedSize.updatedAt < LIBRARY_SIZE_GRACE_MS
      ) {
        return storedSize.value;
      }
    } catch (e) {
      storedSize = null;
    }
  }

  let fingerprint = null;
  try {
    const [p, v] = await Promise.all([
      getAlbumFingerprint(ALL_ALBUM_ID, 'photo', 'background'),
      getAlbumFingerprint(ALL_ALBUM_ID, 'video', 'background'),
    ]);
    fingerprint = [
      p.assetCount,
      p.latestModificationTime,
      v.assetCount,
      v.latestModificationTime,
    ].join('_');
  } catch (e) {
    fingerprint = null; // freshness unknown — recompute rather than lie
  }

  if (
    !force &&
    storedSize?.value &&
    fingerprint &&
    storedSize.fingerprint === fingerprint
  ) {
    if (!storedSize.updatedAt) {
      withLock(LIBRARY_SIZE_KEY, async () => {
        const currentRaw = await AsyncStorage.getItem(LIBRARY_SIZE_KEY);
        const current = currentRaw ? JSON.parse(currentRaw) : null;
        if (
          current?.value &&
          !current.updatedAt &&
          current.fingerprint === fingerprint
        ) {
          await AsyncStorage.setItem(
            LIBRARY_SIZE_KEY,
            JSON.stringify({ ...current, updatedAt: Date.now() })
          );
        }
      }).catch(() => {});
    }
    return storedSize.value;
  }

  let value = null;
  // The library scan already holds every size — summing it beats a second
  // whole-library query.
  const index = await getLibraryIndex('all');
  if (index && index.sizeById.size > 0) {
    let photoBytes = 0;
    let videoBytes = 0;
    let photoCount = 0;
    let videoCount = 0;
    for (let i = 0; i < index.ids.length; i++) {
      const bytes = index.sizeById.get(index.ids[i]) || 0;
      if (index.mediaType[i] === 1) {
        videoBytes += bytes;
        videoCount++;
      } else {
        photoBytes += bytes;
        photoCount++;
      }
    }
    if (photoBytes + videoBytes > 0) {
      value = {
        bytes: photoBytes + videoBytes,
        photoBytes,
        videoBytes,
        photoCount,
        videoCount,
        exact: true,
      };
      log('size', `library: scan ${value.bytes}B`);
    }
  }

  // eslint-disable-next-line global-require
  const PhotoMove = require('../../modules/photo-move');
  if (!value && PhotoMove.hasLibrarySize()) {
    try {
      const r = await runMediaWork(
        () => PhotoMove.librarySize(),
        'background'
      );
      const photoBytes = r.photoBytes || 0;
      const videoBytes = r.videoBytes || 0;
      if (photoBytes + videoBytes > 0) {
        value = {
          bytes: photoBytes + videoBytes,
          photoBytes,
          videoBytes,
          photoCount: r.photoCount || 0,
          videoCount: r.videoCount || 0,
          exact: true,
        };
        log('size', `library: native ${value.bytes}B`);
      } else {
        log('size', 'library: native returned 0 — falling back');
      }
    } catch (e) {
      log('size', `library: native failed (${(e && e.message) || e})`);
    }
  }

  if (!value && allowSlowFallback) {
    const [p, v] = await Promise.all([
      getAlbumSnapshot(ALL_ALBUM_ID, 'photo'),
      getAlbumSnapshot(ALL_ALBUM_ID, 'video'),
    ]);
    value = {
      bytes: p.bytes + v.bytes,
      photoBytes: p.bytes,
      videoBytes: v.bytes,
      photoCount: p.count,
      videoCount: v.count,
      exact: false,
    };
  }

  if (value && fingerprint) {
    try {
      await withLock(
        LIBRARY_SIZE_KEY,
        () =>
          AsyncStorage.setItem(
            LIBRARY_SIZE_KEY,
            JSON.stringify({ fingerprint, value, updatedAt: Date.now() })
          )
      );
    } catch (e) {
      // best effort — a missing cache only costs one recompute
    }
  }
  return value;
}

/**
 * Quick staleness fingerprint of an album: count, modification-time edges
 * and a small newest-id signature. Two tiny queries, no full scan.
 */
export async function getAlbumFingerprint(
  albumId,
  mediaType,
  priority = 'interactive'
) {
  const cacheKey = `${mediaType}/${albumId || ALL_ALBUM_ID}`;
  const cached = fingerprintMemoryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < FINGERPRINT_TTL_MS) {
    // `age`, not a duration — this branch did no work. See getAlbums().
    log('perf', `getAlbumFingerprint ${cacheKey} cache-hit age=${Date.now() - cached.at}ms count=${cached.value.assetCount || 0}`);
    return cached.value;
  }
  const existing = fingerprintPromises.get(cacheKey);
  if (
    existing &&
    (priority === 'background' || existing.priority === 'interactive')
  ) {
    return existing.promise;
  }
  const promise = (async () => {
    const generation = fingerprintGeneration;
    const startedAt = Date.now();
    const options = {
      first: 3,
      mediaType,
      sortBy: [[MediaLibrary.SortBy.modificationTime, false]],
    };
    if (albumId && albumId !== ALL_ALBUM_ID) options.album = albumId;
  try {
    // Count + newest timestamp misses an equal-count membership swap. Keep a
    // small signature from both edges so moving one asset out and another in
    // cannot usually leave a stale list/analysis cache looking fresh.
    const oldestOptions = {
      ...options,
      first: 1,
      sortBy: [[MediaLibrary.SortBy.modificationTime, true]],
    };
    const [page, oldestPage] = await runMediaWork(
      () =>
        Promise.all([
          MediaLibrary.getAssetsAsync(options),
          MediaLibrary.getAssetsAsync(oldestOptions),
        ]),
      priority
    );
    const newest = page.assets[0];
    const oldest = oldestPage.assets[0];
    const result = {
      assetCount: page.totalCount,
      latestModificationTime: newest
        ? newest.modificationTime || newest.creationTime || 0
        : 0,
      newestId: newest ? newest.id : null,
      oldestId: oldest ? oldest.id : null,
      edgeIds: page.assets.map((a) => a.id).join('|'),
    };
    log(
      'perf',
      `getAlbumFingerprint ${cacheKey} ` +
        `${Date.now() - startedAt}ms count=${result.assetCount || 0}`
    );
    if (generation === fingerprintGeneration) {
      fingerprintMemoryCache.set(cacheKey, { at: Date.now(), value: result });
    }
    return result;
  } catch (e) {
    log(
      'perf',
      `getAlbumFingerprint ${mediaType}/${albumId || ALL_ALBUM_ID} failed ` +
        `${Date.now() - startedAt}ms`
    );
    throw e;
  }
  })();
  fingerprintPromises.set(cacheKey, { promise, priority });
  try {
    return await promise;
  } finally {
    if (fingerprintPromises.get(cacheKey)?.promise === promise) {
      fingerprintPromises.delete(cacheKey);
    }
  }
}

export async function findAlbumByTitle(title) {
  const albums = await getRawAlbums();
  return albums.find((a) => a.title === title) || null;
}

/**
 * Move assets to a target album (adds to album; may copy on iOS).
 */
export async function moveAssetsToAlbum(assets, album, copy = false) {
  const ids = assets.map((a) => (typeof a === 'string' ? a : a.id));
  // copy=true: file is DUPLICATED into the album — the original keeps every
  // bit of its metadata untouched (used by Android categorize-then-delete).
  await runMediaWork(
    () => MediaLibrary.addAssetsToAlbumAsync(ids, album.id, copy),
    'interactive'
  );
  invalidateLibraryIndex();
}

/** Undo an add: take the assets back OUT of the album (iOS collections). */
export async function removeAssetsFromAlbum(assets, album) {
  const ids = assets.map((a) => (typeof a === 'string' ? a : a.id));
  await runMediaWork(
    () => MediaLibrary.removeAssetsFromAlbumAsync(ids, album.id),
    'interactive'
  );
  invalidateLibraryIndex();
}

// ---- Album summary cache: the home screen renders INSTANTLY from this and
// skips scanning entirely while the album's fingerprint is unchanged. ----

const SUMMARY_PREFIX = 'album_summary_';
const summaryMemoryCache = new Map();

// Photos and videos have separate summaries (count, preview thumbs, year
// histogram) for the same album id. Photos keep the original key so an
// update doesn't cost them their instant first paint.
function summaryKey(albumId, mediaType) {
  return mediaType === 'video'
    ? `${SUMMARY_PREFIX}video_${albumId}`
    : `${SUMMARY_PREFIX}${albumId}`;
}

/** Synchronous cache peek for the already visited home screen. */
export function peekAlbumSummary(albumId, mediaType = 'photo') {
  return summaryMemoryCache.get(summaryKey(albumId, mediaType)) || null;
}

/** Build the year -> month photo-count histogram used by the time picker. */
export function buildYearHistogram(assets) {
  const map = new Map();
  for (const a of assets) {
    if (!a.creationTime) continue;
    const d = new Date(a.creationTime);
    const y = d.getFullYear();
    const m = d.getMonth();
    if (!map.has(y)) map.set(y, { count: 0, months: new Map() });
    const e = map.get(y);
    e.count++;
    e.months.set(m, (e.months.get(m) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, e]) => ({
      year,
      count: e.count,
      months: [...e.months.entries()].sort((a, b) => b[0] - a[0]),
    }));
}

// ---- Persistent asset-list cache (Fossify/photoo-style local index) ----
// The full asset list of an album, keyed by fingerprint: when the album is
// unchanged, cleaning screens open with ZERO MediaStore scanning.
const LIST_PREFIX = 'asset_list_v1_';

function slimAsset(a) {
  return {
    id: a.id,
    uri: a.uri,
    mediaType: a.mediaType,
    mediaSubtypes: a.mediaSubtypes,
    width: a.width,
    height: a.height,
    creationTime: a.creationTime,
    modificationTime: a.modificationTime,
    duration: a.duration,
    albumId: a.albumId,
    filename: a.filename,
  };
}

/** Cached full asset list, or null when missing/stale. */
export async function getCachedAssetList(
  albumId,
  mediaType,
  priority = 'interactive'
) {
  try {
    const raw = await AsyncStorage.getItem(
      `${LIST_PREFIX}${mediaType}_${albumId}`
    );
    if (!raw) return null;
    const { fingerprint, assets } = JSON.parse(raw);
    if (!fingerprint || !Array.isArray(assets) || assets.length === 0)
      return null;
    const fp = await getAlbumFingerprint(albumId, mediaType, priority);
    if (
      fingerprint.assetCount !== fp.assetCount ||
      fingerprint.latestModificationTime !== fp.latestModificationTime ||
      fingerprint.newestId !== fp.newestId ||
      fingerprint.oldestId !== fp.oldestId ||
      fingerprint.edgeIds !== fp.edgeIds
    ) {
      return null; // album changed — caller rescans (and re-saves)
    }
    return assets;
  } catch (e) {
    return null;
  }
}

/** Persist an album's full asset list (newest-first, slimmed, capped). */
export async function saveCachedAssetList(albumId, mediaType, assets) {
  try {
    if (!assets || assets.length === 0) return;
    // Bail BEFORE the expensive part. A slim entry is ~300 B, so anything
    // past ~5000 assets cannot fit anyway — the old code sorted, mapped and
    // serialised a 20 000-entry list into a ~6 MB string just to measure it
    // and throw it away, on the JS thread, while the cleaning screen held
    // decoded bitmaps.
    if (assets.length > MAX_CACHED_LIST) return;
    const fp = await getAlbumFingerprint(albumId, mediaType);
    // Only COMPLETE lists may be cached: a partial index would silently
    // hide the rest of the album from the cleaning flow.
    if (fp.assetCount && assets.length !== fp.assetCount) return;
    const slim = [...assets]
      .sort((a, b) => (b.creationTime || 0) - (a.creationTime || 0))
      .map(slimAsset);
    const payload = JSON.stringify({ fingerprint: fp, assets: slim });
    // Byte length, not String.length: the payload is stored as UTF-8 and a
    // Chinese album/file name costs 3 bytes per character, so the old
    // character-count guard let ~2.2 MB payloads through — which Android
    // then rejected silently, so the cache never existed and every entry
    // rescanned MediaStore from scratch.
    if (utf8ByteLength(payload) > MAX_VALUE_BYTES) return;
    await AsyncStorage.setItem(`${LIST_PREFIX}${mediaType}_${albumId}`, payload);
  } catch (e) {
    // best effort
  }
}

export async function getAlbumSummary(albumId, mediaType = 'photo') {
  const key = summaryKey(albumId, mediaType);
  const memory = summaryMemoryCache.get(key);
  if (memory) return memory;
  try {
    const raw = await AsyncStorage.getItem(key);
    const value = raw ? JSON.parse(raw) : null;
    if (value) summaryMemoryCache.set(key, value);
    return value;
  } catch (e) {
    return null;
  }
}

export async function saveAlbumSummary(albumId, entry, mediaType = 'photo') {
  const key = summaryKey(albumId, mediaType);
  summaryMemoryCache.set(key, entry);
  try {
    await AsyncStorage.setItem(key, JSON.stringify(entry));
  } catch (e) {
    // best effort
  }
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(ms, language) {
  if (!ms) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  // toLocaleString with an options bag needs Intl. Hermes ships it on both
  // platforms now, but an older installed binary (or a build with Intl
  // stripped) throws "undefined is not a function" here — which used to take
  // the whole basic-info block of the EXIF sheet down with it. Fall back to a
  // hand-built stamp instead of losing every row.
  try {
    return d.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (e) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  }
}
