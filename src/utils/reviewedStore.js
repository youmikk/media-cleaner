import AsyncStorage from '@react-native-async-storage/async-storage';
import { readJSON, withLock } from './safeStore';

/**
 * Persistent per-album "already reviewed" record. A photo counts as
 * reviewed once its GROUP was confirmed (deleted or kept) — it then never
 * re-enters the random cleaning pool, session after session, until every
 * photo of the album has been reviewed once (the round auto-resets).
 */
const KEY = (albumId) => `@mediacleaner/reviewed_${albumId}`;
const CAP = 20000;

export async function getReviewed(albumId) {
  const { value } = await readJSON(KEY(albumId));
  return new Set(Array.isArray(value) ? value : []);
}

/**
 * Add ids to the reviewed set.
 *
 * Serialised per album: call sites are fire-and-forget (`nextGroup` does not
 * await), and two overlapping calls used to both read the same base set and
 * the second write erased the first — a confirmed group would silently
 * re-enter the random pool, which is precisely what this store exists to
 * prevent. A failed READ also aborts instead of writing a set built from
 * nothing, which would have dropped the album's entire history.
 */
export async function addReviewed(albumId, ids) {
  return withLock(KEY(albumId), async () => {
    const { ok, value } = await readJSON(KEY(albumId));
    if (!ok) return null; // unknown prior state — never overwrite it
    const set = new Set(Array.isArray(value) ? value : []);
    ids.forEach((id) => set.add(id));
    let list = [...set];
    if (list.length > CAP) list = list.slice(list.length - CAP);
    try {
      await AsyncStorage.setItem(KEY(albumId), JSON.stringify(list));
    } catch (e) {
      return null;
    }
    return new Set(list);
  });
}

export async function clearReviewed(albumId) {
  return withLock(KEY(albumId), async () => {
    try {
      await AsyncStorage.removeItem(KEY(albumId));
    } catch (e) {
      // best effort
    }
  });
}
