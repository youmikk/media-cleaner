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

// Parsed ids per album. The stored value reaches CAP entries (~400 KB of
// JSON), and both the home screen and the cleaning screen read it on every
// entry — that JSON.parse ran on the JS thread while the preview images were
// trying to decode. Every write below goes through this module, so the memo
// cannot drift from disk.
const memo = new Map(); // albumId -> string[]

export async function getReviewed(albumId) {
  let ids = memo.get(albumId);
  if (!ids) {
    const { value } = await readJSON(KEY(albumId));
    ids = Array.isArray(value) ? value : [];
    memo.set(albumId, ids);
  }
  // A FRESH Set per call: CleaningScreen adds to the set it gets back, and
  // handing out the cached one would let that mutation rewrite history.
  return new Set(ids);
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
    memo.set(albumId, list);
    return new Set(list);
  });
}

export async function clearReviewed(albumId) {
  return withLock(KEY(albumId), async () => {
    memo.delete(albumId);
    try {
      await AsyncStorage.removeItem(KEY(albumId));
    } catch (e) {
      // best effort
    }
  });
}
