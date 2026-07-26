import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Persistent per-album "already reviewed" record. A photo counts as
 * reviewed once its GROUP was confirmed (deleted or kept) — it then never
 * re-enters the random cleaning pool, session after session, until every
 * photo of the album has been reviewed once (the round auto-resets).
 */
const KEY = (albumId) => `@mediacleaner/reviewed_${albumId}`;
const CAP = 20000;

export async function getReviewed(albumId) {
  try {
    const raw = await AsyncStorage.getItem(KEY(albumId));
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (e) {
    return new Set();
  }
}

export async function addReviewed(albumId, ids) {
  try {
    const set = await getReviewed(albumId);
    ids.forEach((id) => set.add(id));
    let list = [...set];
    if (list.length > CAP) list = list.slice(list.length - CAP);
    await AsyncStorage.setItem(KEY(albumId), JSON.stringify(list));
    return new Set(list);
  } catch (e) {
    return null;
  }
}

export async function clearReviewed(albumId) {
  try {
    await AsyncStorage.removeItem(KEY(albumId));
  } catch (e) {
    // best effort
  }
}
