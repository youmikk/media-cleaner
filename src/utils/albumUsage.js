import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@mediacleaner/album_usage';
let cache = null;

export async function getUsage() {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = raw ? JSON.parse(raw) : {};
  } catch (e) {
    cache = {};
  }
  return cache;
}

/** Count a move-to-album action (drives chip ordering). */
export async function incrementUsage(albumId) {
  const usage = await getUsage();
  usage[albumId] = (usage[albumId] || 0) + 1;
  cache = usage;
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(usage));
  } catch (e) {
    // best effort
  }
  return usage;
}

/** Most-used first, then bigger albums first. */
export function sortByUsage(albums, usage) {
  return [...albums].sort(
    (a, b) =>
      (usage[b.id] || 0) - (usage[a.id] || 0) ||
      (b.assetCount || 0) - (a.assetCount || 0)
  );
}
