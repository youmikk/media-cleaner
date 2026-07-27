import AsyncStorage from '@react-native-async-storage/async-storage';
import * as MediaLibrary from 'expo-media-library';
import { ALL_ALBUM_ID } from './albumHelpers';
import { log } from './logger';

/**
 * Per-album storage is keyed by album id and was never cleaned up: nothing
 * in the app called getAllKeys. Delete an album, or let Android renumber a
 * MediaStore bucket after files move, and its reviewed set (up to ~900 KB),
 * asset-list cache (up to ~1.5 MB), analysis cache and summary all become
 * unreachable garbage that survives forever. Two years of use accumulates
 * tens of MB of dead entries.
 */
const ALBUM_KEY_PATTERNS = [
  /^@mediacleaner\/reviewed_(.+)$/,
  /^asset_list_v1_(?:photo|video)_(.+)$/,
  /^analysis_v3_(?:video_)?(.+)$/,
  /^album_summary_(.+)$/,
];

function albumIdOf(key) {
  for (const pattern of ALBUM_KEY_PATTERNS) {
    const m = key.match(pattern);
    if (m) return m[1];
  }
  return null;
}

/**
 * Drop per-album entries whose album no longer exists. Best effort and
 * deliberately conservative: anything unexpected aborts without deleting.
 * @returns {Promise<number>} number of keys removed
 */
export async function pruneOrphanAlbumKeys() {
  try {
    const [keys, albums] = await Promise.all([
      AsyncStorage.getAllKeys(),
      MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true }),
    ]);
    // An empty album list means the query failed or permission was revoked.
    // Treating that as "no albums exist" would wipe every cache the app has.
    if (!albums || albums.length === 0) return 0;

    const alive = new Set(albums.map((a) => String(a.id)));
    alive.add(ALL_ALBUM_ID); // the synthetic "All photos/videos" scope

    const orphans = [];
    for (const key of keys) {
      const id = albumIdOf(key);
      if (id && !alive.has(id)) orphans.push(key);
    }
    if (orphans.length === 0) return 0;
    await AsyncStorage.multiRemove(orphans);
    log('gc', `removed ${orphans.length} orphan album keys`);
    return orphans.length;
  } catch (e) {
    return 0;
  }
}
