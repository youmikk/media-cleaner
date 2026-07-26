import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';

export const ALL_ALBUM_ID = 'all';
const PAGE_SIZE = 200;
const MAX_ASSETS = 5000; // safety cap for very large libraries
const SNAPSHOT_SAMPLE = 300; // size sampling cap for storage snapshots

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
  const sample = assets.slice(0, SNAPSHOT_SAMPLE);
  let sampleBytes = 0;
  for (const a of sample) {
    sampleBytes += await getAssetSize(a);
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
