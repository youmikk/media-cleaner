import * as MediaLibrary from 'expo-media-library';
// SDK 54: use the stable legacy file-system API (getInfoAsync etc.).
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { utf8ByteLength, MAX_VALUE_BYTES } from './safeStore';
import { log } from './logger';

export const ALL_ALBUM_ID = 'all';
const PAGE_SIZE = 200;
const MAX_ASSETS = 20000; // safety cap for very large libraries
const SNAPSHOT_SAMPLE = 60; // size sampling cap when there is no native query
const SNAPSHOT_CONCURRENCY = 6;
// Assets measured for real per album snapshot. Cheap on Android (a cursor),
// a few hundred ms on iOS for a big album — past this the average of 4000
// real sizes is accurate enough that reading more only costs latency.
const EXACT_SIZE_CAP = 4000;
// Ids per native size query. The native side re-chunks internally; this only
// bounds how much crosses the bridge at once.
const SIZE_QUERY_CHUNK = 4000;
const LIBRARY_SIZE_KEY = '@mediacleaner/library_size';
// A slim asset serialises to ~300 B, so this is the point past which the
// list cannot fit under the per-value storage ceiling.
const MAX_CACHED_LIST = 4800;
// getAssetsByIds cap. Exposed so callers can tell the user when a selection
// was trimmed instead of silently cleaning a subset.
export const MAX_ASSETS_BY_IDS = 600;

/**
 * List device albums for the given media type, prefixed by a synthetic
 * "All Photos"/"All Videos" entry.
 */
export async function getAlbums(mediaType, allLabel) {
  const albums = await MediaLibrary.getAlbumsAsync({
    includeSmartAlbums: true,
  });
  const result = [{ id: ALL_ALBUM_ID, title: allLabel, assetCount: undefined }];
  for (const album of albums) {
    // Filter out empty albums; keep smart albums like Screenshots / Camera.
    if (album.assetCount === 0) continue;
    result.push({ id: album.id, title: album.title, assetCount: album.assetCount });
  }
  return result;
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
export async function getAssetsPage(albumId, mediaType, after, range = null) {
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
  const page = await MediaLibrary.getAssetsAsync(options);
  return {
    assets: page.assets,
    hasNext: page.hasNextPage && page.assets.length > 0,
    endCursor: page.endCursor,
  };
}

/**
 * A handful of preview assets for a time range — ONE scoped media-store
 * query, no paging. Used by the home cards when a year/month is picked.
 */
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
    const page = await MediaLibrary.getAssetsAsync(options);
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
export async function getAssets(albumId, mediaType, limit = MAX_ASSETS) {
  const assets = [];
  const cap = Math.min(limit, MAX_ASSETS);
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
    const page = await MediaLibrary.getAssetsAsync(options);
    assets.push(...page.assets);
    hasNext = page.hasNextPage;
    after = page.endCursor;
  }
  return assets.length > cap ? assets.slice(0, cap) : assets;
}

export async function getAssetsByIds(ids) {
  // Parallel (8-wide) and hard-capped: the old serial loop stalled for
  // tens of seconds on large id lists (Low-Quality with hundreds of hits
  // looked like "the screen won't open").
  const capped = ids.slice(0, MAX_ASSETS_BY_IDS);
  const out = [];
  const CONC = 8;
  for (let i = 0; i < capped.length; i += CONC) {
    const batch = capped.slice(i, i + CONC);
    // eslint-disable-next-line no-await-in-loop
    const infos = await Promise.all(
      batch.map(async (id) => {
        try {
          return await MediaLibrary.getAssetInfoAsync(id);
        } catch (e) {
          return null; // asset may have been deleted meanwhile
        }
      })
    );
    for (const info of infos) if (info) out.push(info);
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
export async function getAssetSize(asset) {
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

/**
 * Whole-library index from ONE native scan: ids, timestamps, dimensions and
 * — the part expo-media-library cannot give us — the byte size of every
 * asset. Held in memory briefly so the several callers that all want some
 * slice of it during one screen visit share a single scan.
 */
let scanCache = null; // {at, mediaType, index}
const SCAN_TTL_MS = 60000;

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
export async function getLibraryIndex(mediaType = 'all', { force = false } = {}) {
  if (!force) {
    const warm = peekLibraryIndex(mediaType);
    if (warm) return warm;
  }
  // eslint-disable-next-line global-require
  const PhotoMove = require('../../modules/photo-move');
  if (!PhotoMove.hasScanLibrary()) return null;
  try {
    const started = new Date().getTime();
    const raw = await PhotoMove.scanLibrary(mediaType, 0);
    const index = buildIndex(raw);
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
}

/** Drop the cached scan — call after deleting or moving assets. */
export function invalidateLibraryIndex() {
  scanCache = null;
}

/**
 * Ask the native module for {id: bytes} over an arbitrarily long id list.
 * Returns null when the module can't answer at all, so callers can tell
 * "unavailable" apart from "answered, some ids unknown".
 */
async function nativeSizes(ids) {
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
      const sizes = await PhotoMove.getSizes(part);
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
export async function getAssetSizes(assets) {
  const out = {};
  const sizes = await nativeSizes(assets.map((a) => String(a.id)));
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
    const stats = await Promise.all(batch.map((a) => getAssetSize(a)));
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
  const assets = precomputedAssets || (await getAssets(albumId, mediaType));
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
  const sizes = await nativeSizes(target.map((a) => String(a.id)));
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
    const stats = await Promise.all(batch.map((a) => getAssetSize(a)));
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
  let fingerprint = null;
  try {
    const [p, v] = await Promise.all([
      getAlbumFingerprint(ALL_ALBUM_ID, 'photo'),
      getAlbumFingerprint(ALL_ALBUM_ID, 'video'),
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

  if (!force && fingerprint) {
    try {
      const raw = await AsyncStorage.getItem(LIBRARY_SIZE_KEY);
      const cached = raw ? JSON.parse(raw) : null;
      if (cached && cached.fingerprint === fingerprint && cached.value) {
        return cached.value;
      }
    } catch (e) {
      // unreadable cache — just recompute
    }
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
      const r = await PhotoMove.librarySize();
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
      await AsyncStorage.setItem(
        LIBRARY_SIZE_KEY,
        JSON.stringify({ fingerprint, value })
      );
    } catch (e) {
      // best effort — a missing cache only costs one recompute
    }
  }
  return value;
}

/**
 * Quick staleness fingerprint of an album: total count and the newest
 * modification time. Cheap (single page of 1).
 */
export async function getAlbumFingerprint(albumId, mediaType) {
  const options = {
    first: 1,
    mediaType,
    sortBy: [[MediaLibrary.SortBy.modificationTime, false]],
  };
  if (albumId && albumId !== ALL_ALBUM_ID) options.album = albumId;
  const page = await MediaLibrary.getAssetsAsync(options);
  const newest = page.assets[0];
  return {
    assetCount: page.totalCount,
    latestModificationTime: newest
      ? newest.modificationTime || newest.creationTime || 0
      : 0,
  };
}

export async function findAlbumByTitle(title) {
  const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
  return albums.find((a) => a.title === title) || null;
}

/**
 * Move assets to a target album (adds to album; may copy on iOS).
 */
export async function moveAssetsToAlbum(assets, album, copy = false) {
  const ids = assets.map((a) => (typeof a === 'string' ? a : a.id));
  // copy=true: file is DUPLICATED into the album — the original keeps every
  // bit of its metadata untouched (used by Android categorize-then-delete).
  await MediaLibrary.addAssetsToAlbumAsync(ids, album.id, copy);
}

/** Undo an add: take the assets back OUT of the album (iOS collections). */
export async function removeAssetsFromAlbum(assets, album) {
  const ids = assets.map((a) => (typeof a === 'string' ? a : a.id));
  await MediaLibrary.removeAssetsFromAlbumAsync(ids, album.id);
}

// ---- Album summary cache: the home screen renders INSTANTLY from this and
// skips scanning entirely while the album's fingerprint is unchanged. ----

const SUMMARY_PREFIX = 'album_summary_';

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
export async function getCachedAssetList(albumId, mediaType) {
  try {
    const raw = await AsyncStorage.getItem(
      `${LIST_PREFIX}${mediaType}_${albumId}`
    );
    if (!raw) return null;
    const { fingerprint, assets } = JSON.parse(raw);
    if (!fingerprint || !Array.isArray(assets) || assets.length === 0)
      return null;
    const fp = await getAlbumFingerprint(albumId, mediaType);
    if (
      fingerprint.assetCount !== fp.assetCount ||
      fingerprint.latestModificationTime !== fp.latestModificationTime
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

export async function getAlbumSummary(albumId) {
  try {
    const raw = await AsyncStorage.getItem(`${SUMMARY_PREFIX}${albumId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export async function saveAlbumSummary(albumId, entry) {
  try {
    await AsyncStorage.setItem(
      `${SUMMARY_PREFIX}${albumId}`,
      JSON.stringify(entry)
    );
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
  return d.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
