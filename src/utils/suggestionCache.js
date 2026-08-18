import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAlbumFingerprint, ALL_ALBUM_ID } from './albumHelpers';
import { utf8ByteLength } from './safeStore';

/**
 * Persistent cache for the Profile tab's smart-suggestion cards.
 *
 * The old shape was a plain 24h TTL: once it expired the whole scan re-ran —
 * a full metadata fetch plus hundreds of file-size lookups — even when the
 * library had not changed by a single photo since the last run. Keying on the
 * library FINGERPRINT instead means an unchanged gallery never pays for the
 * scan twice, and a changed one refreshes immediately rather than up to a day
 * later. The long TTL below is only a safety net for anything the fingerprint
 * cannot see (a file edited in place, say).
 */
const KEY = 'analysis_suggestions_v3';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
// Android AsyncStorage silently drops values over ~2 MB — and it loses the
// WHOLE entry, not the excess. Every list is capped before it is stored.
const MAX_VALUE_BYTES = 1.8 * 1024 * 1024;
export const MAX_SCREENSHOTS = 300;
export const MAX_VIDEO_DUPE_GROUPS = 100;

/** Library-wide fingerprint: counts + newest modification, per media type. */
export async function getLibraryFingerprint() {
  const [photo, video] = await Promise.all([
    getAlbumFingerprint(ALL_ALBUM_ID, 'photo'),
    getAlbumFingerprint(ALL_ALBUM_ID, 'video'),
  ]);
  return {
    photoCount: photo.assetCount || 0,
    photoLatest: photo.latestModificationTime || 0,
    photoNewestId: photo.newestId || null,
    photoOldestId: photo.oldestId || null,
    photoEdgeIds: photo.edgeIds || '',
    videoCount: video.assetCount || 0,
    videoLatest: video.latestModificationTime || 0,
    videoNewestId: video.newestId || null,
    videoOldestId: video.oldestId || null,
    videoEdgeIds: video.edgeIds || '',
  };
}

function sameFingerprint(a, b) {
  if (!a || !b) return false;
  return (
    a.photoCount === b.photoCount &&
    a.photoLatest === b.photoLatest &&
    a.photoNewestId === b.photoNewestId &&
    a.photoOldestId === b.photoOldestId &&
    a.photoEdgeIds === b.photoEdgeIds &&
    a.videoCount === b.videoCount &&
    a.videoLatest === b.videoLatest &&
    a.videoNewestId === b.videoNewestId &&
    a.videoOldestId === b.videoOldestId &&
    a.videoEdgeIds === b.videoEdgeIds
  );
}

/**
 * Cached suggestions when they are still valid for `fingerprint`, else null.
 * The caller passes the fingerprint it already measured so this never costs a
 * second media-store round trip.
 */
export async function getSuggestions(fingerprint) {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || !entry.data) return null;
    if (new Date().getTime() - (entry.createdAt || 0) > MAX_AGE) return null;
    if (!sameFingerprint(entry.fingerprint, fingerprint)) return null;
    return entry.data;
  } catch (e) {
    return null; // corrupt entry — rescan
  }
}

export async function saveSuggestions(data, fingerprint) {
  try {
    const capped = {
      largest: (data.largest || []).slice(0, 10),
      bursts: (data.bursts || []).slice(0, 30),
      screenshots: (data.screenshots || []).slice(0, MAX_SCREENSHOTS),
      videoDupes: (data.videoDupes || []).slice(0, MAX_VIDEO_DUPE_GROUPS),
    };
    const payload = JSON.stringify({
      createdAt: new Date().getTime(),
      fingerprint,
      data: capped,
    });
    if (utf8ByteLength(payload) > MAX_VALUE_BYTES) return;
    await AsyncStorage.setItem(KEY, payload);
  } catch (e) {
    // best effort — the cards still work, they just rescan next time
  }
}

// ---- Verified burst / duplicate groups (BurstCleanScreen) ----------------
// Verifying a burst runs a perceptual hash + sharpness score for every member
// and generating a video poster per duplicate; both are slow enough to be
// worth never repeating for the same input.
const GROUPS_PREFIX = 'suggestion_groups_v2_';

/** Stable 32-bit signature of the input group ids (order-sensitive). */
function signature(groups, assets = []) {
  const versions = new Map(
    (assets || []).map((asset) => [
      asset.id,
      `${asset.modificationTime || 0}:${asset.width || 0}x${asset.height || 0}`,
    ])
  );
  let h = 5381;
  for (const g of groups) {
    for (const id of g.ids || []) {
      for (let i = 0; i < id.length; i++) {
        h = ((h << 5) + h + id.charCodeAt(i)) | 0;
      }
      const version = versions.get(id) || '';
      for (let i = 0; i < version.length; i++) {
        h = ((h << 5) + h + version.charCodeAt(i)) | 0;
      }
      h = ((h << 5) + h + 44) | 0; // member separator
    }
    h = ((h << 5) + h + 124) | 0; // group separator
  }
  return (h >>> 0).toString(36);
}

export function groupsKey(mode, groups, assets = []) {
  return `${GROUPS_PREFIX}${mode}_${signature(groups, assets)}`;
}

/** Verified sections: [{ids, bestId}] — or null. */
export async function getVerifiedGroups(mode, groups, assets = []) {
  try {
    const raw = await AsyncStorage.getItem(groupsKey(mode, groups, assets));
    if (!raw) return null;
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : null;
  } catch (e) {
    return null;
  }
}

export async function saveVerifiedGroups(mode, groups, sections, assets = []) {
  try {
    const payload = JSON.stringify(sections);
    if (utf8ByteLength(payload) > MAX_VALUE_BYTES) return;
    await AsyncStorage.setItem(groupsKey(mode, groups, assets), payload);
  } catch (e) {
    // best effort
  }
}
