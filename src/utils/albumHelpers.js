import * as MediaLibrary from 'expo-media-library';
// SDK 54: use the stable legacy file-system API (getInfoAsync etc.).
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const ALL_ALBUM_ID = 'all';
const PAGE_SIZE = 200;
const MAX_ASSETS = 20000; // safety cap for very large libraries
const SNAPSHOT_SAMPLE = 60; // size sampling cap for storage snapshots
const SNAPSHOT_CONCURRENCY = 6;

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
 */
export async function getAssetsPage(albumId, mediaType, after) {
  const options = {
    first: PAGE_SIZE,
    mediaType,
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
  };
  if (after) options.after = after;
  if (albumId && albumId !== ALL_ALBUM_ID) options.album = albumId;
  const page = await MediaLibrary.getAssetsAsync(options);
  return {
    assets: page.assets,
    hasNext: page.hasNextPage && page.assets.length > 0,
    endCursor: page.endCursor,
  };
}

/**
 * Fetch all assets of an album (paginated), newest first.
 */
export async function getAssets(albumId, mediaType) {
  const assets = [];
  let after;
  let hasNext = true;
  while (hasNext && assets.length < MAX_ASSETS) {
    const options = {
      first: PAGE_SIZE,
      mediaType,
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    };
    if (after) options.after = after;
    if (albumId && albumId !== ALL_ALBUM_ID) options.album = albumId;
    const page = await MediaLibrary.getAssetsAsync(options);
    assets.push(...page.assets);
    hasNext = page.hasNextPage;
    after = page.endCursor;
  }
  return assets;
}

export async function getAssetsByIds(ids) {
  const out = [];
  for (const id of ids) {
    try {
      const info = await MediaLibrary.getAssetInfoAsync(id);
      if (info) out.push(info);
    } catch (e) {
      // asset may have been deleted meanwhile
    }
  }
  return out;
}

/**
 * Best-effort file size for an asset, in bytes.
 */
export async function getAssetSize(asset) {
  try {
    const info = asset.localUri
      ? asset
      : await MediaLibrary.getAssetInfoAsync(asset.id ? asset.id : asset);
    const uri = info.localUri || info.uri;
    if (!uri) return 0;
    const stat = await FileSystem.getInfoAsync(uri, { size: true });
    return stat.exists && stat.size ? stat.size : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Compute a storage snapshot {count, bytes} for an album.
 * Sizes are sampled (first SNAPSHOT_SAMPLE assets) and extrapolated for
 * very large albums to keep this fast.
 */
export async function getAlbumSnapshot(albumId, mediaType, precomputedAssets) {
  const assets = precomputedAssets || (await getAssets(albumId, mediaType));
  // Small sample, parallel batches — keeps cleaning-screen entry snappy.
  const sample = assets.slice(0, SNAPSHOT_SAMPLE);
  let sampleBytes = 0;
  for (let i = 0; i < sample.length; i += SNAPSHOT_CONCURRENCY) {
    const batch = sample.slice(i, i + SNAPSHOT_CONCURRENCY);
    const sizes = await Promise.all(batch.map((a) => getAssetSize(a)));
    for (const s of sizes) sampleBytes += s;
  }
  const bytes =
    sample.length > 0
      ? Math.round((sampleBytes / sample.length) * assets.length)
      : 0;
  return { count: assets.length, bytes };
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
export async function moveAssetsToAlbum(assets, album) {
  const ids = assets.map((a) => (typeof a === 'string' ? a : a.id));
  await MediaLibrary.addAssetsToAlbumAsync(ids, album.id, false);
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
    const fp = await getAlbumFingerprint(albumId, mediaType);
    // Only COMPLETE lists may be cached: a partial index would silently
    // hide the rest of the album from the cleaning flow.
    if (fp.assetCount && assets.length < fp.assetCount) return;
    const slim = [...assets]
      .sort((a, b) => (b.creationTime || 0) - (a.creationTime || 0))
      .map(slimAsset);
    const payload = JSON.stringify({ fingerprint: fp, assets: slim });
    // Android AsyncStorage rejects values >2MB — skip (don't truncate).
    if (payload.length > 1800000) return;
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
