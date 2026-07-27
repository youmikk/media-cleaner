import AsyncStorage from '@react-native-async-storage/async-storage';
import { readJSON, withLock } from './safeStore';

const STATS_KEY = '@mediacleaner/stats';

export const EMPTY_STATS = {
  photosCleaned: 0,
  videosCleaned: 0,
  photosViewed: 0,
  videosViewed: 0,
  spaceSavedBytes: 0,
  originalSizeBytes: 0,
  sessions: [], // [{type, albumTitle, before, after, savedBytes, finishedAt}]
};

export async function getStats() {
  const { value } = await readJSON(STATS_KEY);
  return value ? { ...EMPTY_STATS, ...value } : { ...EMPTY_STATS };
}

/**
 * Read-modify-write under a lock, aborting if the read failed.
 *
 * Every record* below is called fire-and-forget, often twice in the same
 * tick (CompressScreen reports photos and videos back to back; finishing an
 * album fires recordCleaned + recordViewed + recordSession concurrently).
 * Without the lock they all read the same base and the last write wins,
 * losing whole categories of counts — that was deterministic, not a race
 * that needed bad luck. Aborting on a failed read stops a transient storage
 * error from resetting the user's lifetime totals to zero.
 */
function update(mutate) {
  return withLock(STATS_KEY, async () => {
    const { ok, value } = await readJSON(STATS_KEY);
    if (!ok) return null;
    const stats = value ? { ...EMPTY_STATS, ...value } : { ...EMPTY_STATS };
    mutate(stats);
    try {
      await AsyncStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch (e) {
      return null;
    }
    return stats;
  });
}

export async function recordViewed(mediaType, count = 1) {
  return update((stats) => {
    if (mediaType === 'video') stats.videosViewed += count;
    else stats.photosViewed += count;
  });
}

export async function recordCleaned(mediaType, count, bytes = 0) {
  return update((stats) => {
    if (mediaType === 'video') stats.videosCleaned += count;
    else stats.photosCleaned += count;
    stats.spaceSavedBytes += Math.max(0, bytes || 0);
  });
}

export async function recordSession(session) {
  return update((stats) => {
    stats.sessions = [session, ...stats.sessions].slice(0, 100);
    // Track the largest observed gallery size as the "original" reference.
    if (session.before && session.before.bytes > stats.originalSizeBytes) {
      stats.originalSizeBytes = session.before.bytes;
    }
  });
}

export async function setOriginalSize(bytes) {
  return update((stats) => {
    if (bytes > stats.originalSizeBytes) stats.originalSizeBytes = bytes;
  });
}
