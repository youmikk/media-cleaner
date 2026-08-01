import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image as ExpoImage } from 'expo-image';
import { utf8ByteLength } from './safeStore';
import { log } from './logger';

/**
 * Cache housekeeping for the Settings screen.
 *
 * The split below is the whole point of this file: everything listed as a
 * CACHE can be rebuilt from the photo library by re-scanning, so deleting it
 * costs the user time and nothing else. Everything else the app stores is
 * either the user's own decisions (favorites, reviewed history, a paused
 * session) or unrecoverable (the Android recycle bin holds the only copy of
 * a deleted file) — none of it is touched here, and the confirmation shown
 * to the user says so explicitly.
 */

// Regenerable caches, matched against AsyncStorage.getAllKeys().
const CACHE_PATTERNS = [
  /^analysis_v3_/, //         per-album similarity / burst / low-quality results
  /^analysis_metrics_v2$/, // the global per-asset metric store
  /^analysis_suggestions_v2$/, // home suggestion cards
  /^album_summary_/, //       count + preview thumbs + time histogram
  /^asset_list_v1_/, //       local asset index
  /^@mediacleaner\/library_size$/, // measured gallery size
  /^@mediacleaner\/video_thumbs_v1$/, // generated video thumbnail map
];

/**
 * Keys that must NEVER be cleared. Listed explicitly (rather than relying on
 * the patterns above not matching) so that adding a new cache prefix later
 * can't silently start eating user data.
 */
const PROTECTED = [
  '@mediacleaner/settings',
  '@mediacleaner/stats',
  '@mediacleaner/favorites',
  '@mediacleaner/album_usage',
  '@mediacleaner/session_order',
  '@mediacleaner/active_session_photo',
  '@mediacleaner/active_session_video',
];
const PROTECTED_PATTERNS = [
  /^@mediacleaner\/reviewed_/, // "already reviewed" history
  /^@mediacleaner\/trash/, //    recycle bin index — the only copy
  /^@mediacleaner\/tutorial/,
  /^@mediacleaner\/last_/,
];

function isCacheKey(key) {
  if (PROTECTED.includes(key)) return false;
  if (PROTECTED_PATTERNS.some((p) => p.test(key))) return false;
  return CACHE_PATTERNS.some((p) => p.test(key));
}

/**
 * Approximate size of the clearable caches.
 *
 * Reads the values, so it is NOT free (the analysis cache alone can be
 * megabytes) — call it on demand, never during a screen's first paint.
 * Returns {bytes, entries}; bytes is 0 when nothing could be read.
 */
export async function getCacheSize() {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter(isCacheKey);
    if (keys.length === 0) return { bytes: 0, entries: 0 };
    let bytes = 0;
    // Chunked: a single multiGet of every cache value peaks at the sum of
    // all of them in memory, which is exactly the size we are worried about.
    for (let i = 0; i < keys.length; i += 20) {
      // eslint-disable-next-line no-await-in-loop
      const pairs = await AsyncStorage.multiGet(keys.slice(i, i + 20));
      for (const [, value] of pairs) {
        if (value) bytes += utf8ByteLength(value);
      }
    }
    return { bytes, entries: keys.length };
  } catch (e) {
    return { bytes: 0, entries: 0 };
  }
}

/**
 * Delete every regenerable cache, plus expo-image's thumbnail caches.
 * Returns {bytes, entries} — what was actually removed.
 */
export async function clearCaches() {
  const before = await getCacheSize();
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter(isCacheKey);
    if (keys.length > 0) await AsyncStorage.multiRemove(keys);
    log('cache', `cleared ${keys.length} keys, ~${before.bytes}B`);
  } catch (e) {
    log('cache', `clear failed: ${(e && e.message) || e}`);
  }
  // Decoded bitmaps and the on-disk image cache. Best effort: an older
  // expo-image build may not expose both.
  try {
    await ExpoImage.clearMemoryCache();
  } catch (e) {
    // not available
  }
  try {
    await ExpoImage.clearDiskCache();
  } catch (e) {
    // not available
  }
  return before;
}
