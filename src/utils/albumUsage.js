import AsyncStorage from '@react-native-async-storage/async-storage';
import { readJSON, withLock } from './safeStore';

const KEY = '@mediacleaner/album_usage';
let cache = null;

export async function getUsage() {
  if (cache) return cache;
  const { value } = await readJSON(KEY);
  cache = value && typeof value === 'object' ? value : {};
  return cache;
}

/** Count a move-to-album action (drives chip ordering). */
export async function incrementUsage(albumId) {
  return withLock(KEY, async () => {
    const { ok, value } = await readJSON(KEY);
    if (!ok) return cache || {}; // unknown prior state — don't overwrite it
    const usage = value && typeof value === 'object' ? value : {};
    usage[albumId] = (usage[albumId] || 0) + 1;
    cache = usage;
    try {
      await AsyncStorage.setItem(KEY, JSON.stringify(usage));
    } catch (e) {
      // best effort
    }
    return usage;
  });
}

/** Most-used first, then bigger albums first. */
export function sortByUsage(albums, usage) {
  return [...albums].sort(
    (a, b) =>
      (usage[b.id] || 0) - (usage[a.id] || 0) ||
      (b.assetCount || 0) - (a.assetCount || 0)
  );
}
