import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAlbumSnapshot } from './albumHelpers';
import * as statsManager from './statsManager';
import { readJSON, withLock } from './safeStore';

// Sessions are stored PER TYPE — a video session must never overwrite a
// paused photo session (that wiped the saved random order and caused
// "re-entering shows a different group").
const SESSION_KEY = (type) => `@mediacleaner/active_session_${type}`;
// The saved cleaning ORDER is per type too. Photos keep the original key so
// an app update doesn't lose a paused photo session's shuffle; videos get
// their own, now that the video flow resumes the same way photos do.
const ORDER_KEY = (type) =>
  type === 'video'
    ? '@mediacleaner/session_order_video'
    : '@mediacleaner/session_order';

/**
 * Start a cleaning session: capture a "before" snapshot of the album and
 * persist it so a killed app can offer resume on next launch.
 */
export async function startSession({
  type, // 'photo' | 'video'
  albumId,
  albumTitle,
  groupSize,
  assetIds = null,
  timeRange = null,
  order = null, // 'random' | 'date' — the queue was built for THIS mode
  segmented = false,
  windowIds = null,
  cursorAfter = null,
  cursorHasNext = false,
  before,
}) {
  const session = {
    id: `session_${new Date().getTime()}`,
    type,
    albumId,
    albumTitle,
    groupSize,
    assetIds,
    timeRange,
    order,
    segmented,
    windowIds,
    cursorAfter,
    cursorHasNext,
    before,
    groupIndex: 0,
    photoIndex: 0,
    markedIds: [],
    createdAt: new Date().getTime(),
  };
  await withLock(SESSION_KEY(type), async () => {
    await AsyncStorage.setItem(SESSION_KEY(type), JSON.stringify(session));
  });
  // A fresh session invalidates the saved order of ITS OWN type only —
  // starting a video session must not touch a paused photo session's queue.
  await withLock(ORDER_KEY(type), async () => {
    orderMemo.delete(type);
    await AsyncStorage.removeItem(ORDER_KEY(type));
  });
  return session;
}

export async function getPendingSession(type = 'photo') {
  const { value } = await readJSON(SESSION_KEY(type));
  return value || null;
}

/**
 * Persist the exact (possibly shuffled) cleaning order so resume restores
 * the same sequence. Stored separately — it's large and rarely changes.
 *
 * Kept in memory as well: the list runs to 20k ids, and both the home
 * preview and the resume path parse it on entry. That parse landed on the
 * JS thread right when the preview images needed it.
 */
let orderMemo = new Map(); // type -> string[]

export async function saveOrder(assetIds, type = 'photo') {
  orderMemo.set(type, assetIds);
  return withLock(ORDER_KEY(type), async () => {
    try {
      await AsyncStorage.setItem(ORDER_KEY(type), JSON.stringify(assetIds));
    } catch (e) {
      // best effort
    }
  });
}

export async function getOrder(type = 'photo') {
  const memo = orderMemo.get(type);
  if (memo) return [...memo];
  const { value } = await readJSON(ORDER_KEY(type));
  if (!Array.isArray(value)) return null;
  orderMemo.set(type, value);
  return [...value];
}

/**
 * Merge a patch into the stored session.
 *
 * Locked: this is a read-modify-write and the caller fires it from an effect
 * on every group/mark change, so two overlapping calls used to read the same
 * base and the later write dropped the earlier patch — a just-marked photo
 * could vanish from the resumed session.
 */
export async function saveProgress(patch, type = 'photo') {
  return withLock(SESSION_KEY(type), async () => {
    const { ok, value } = await readJSON(SESSION_KEY(type));
    if (!ok || !value) return;
    try {
      await AsyncStorage.setItem(
        SESSION_KEY(type),
        JSON.stringify({ ...value, ...patch })
      );
    } catch (e) {
      // best effort
    }
  });
}

export async function discardSession(type = 'photo') {
  return withLock(SESSION_KEY(type), async () => {
    await AsyncStorage.removeItem(SESSION_KEY(type));
    await withLock(ORDER_KEY(type), async () => {
      orderMemo.delete(type);
      await AsyncStorage.removeItem(ORDER_KEY(type));
    });
  });
}

/** Remove only the session created by a screen that was closed mid-startup. */
export async function discardSessionIfId(id, type = 'photo') {
  return withLock(SESSION_KEY(type), async () => {
    const { ok, value } = await readJSON(SESSION_KEY(type));
    if (!ok || !value || value.id !== id) return false;
    await AsyncStorage.removeItem(SESSION_KEY(type));
    await withLock(ORDER_KEY(type), async () => {
      orderMemo.delete(type);
      await AsyncStorage.removeItem(ORDER_KEY(type));
    });
    return true;
  });
}

/**
 * A paused session holds a FROZEN queue — the shuffled (or date-sorted)
 * order it was built with. Flipping the cleaning-order setting outside the
 * cleaning screen left that queue untouched, so the home preview kept
 * showing the old group and tapping it resumed the old order: the setting
 * looked broken. Drop the session instead, so the next start rebuilds the
 * queue under the new rule.
 *
 * Sessions saved before `order` was recorded have no mode to compare and
 * are left alone rather than silently thrown away.
 *
 * @returns {Promise<boolean>} true when a session was dropped
 */
export async function dropSessionIfOrderChanged(order, type = 'photo') {
  try {
    const pending = await getPendingSession(type);
    if (!pending || !pending.order || pending.order === order) return false;
    await discardSession(type);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * End the session: store what was actually freed into persistent stats
 * (feeds the storage comparison chart), then clear the session.
 *
 * `measured` is the byte total the deletion path actually observed. Prefer
 * it over differencing two snapshots: a snapshot extrapolates the whole
 * album from its 60 NEWEST assets, which are systematically the largest
 * files, so before-minus-after was dominated by sampling noise — it could
 * report "0 B freed" after deleting gigabytes, or invent savings when
 * nothing was deleted.
 */
export async function finishSession(session, measured = null) {
  let saved = { count: 0, bytes: 0 };
  try {
    const mediaType = session.type === 'video' ? 'video' : 'photo';
    let after;
    if (measured && measured.bytes >= 0) {
      saved = { count: measured.count || 0, bytes: measured.bytes || 0 };
      // Deletion already returned exact count/bytes. Do not trigger another
      // full album + library scan just to construct a history row.
      after = {
        count: Math.max(0, (session.before?.count || 0) - saved.count),
        bytes: Math.max(0, (session.before?.bytes || 0) - saved.bytes),
      };
    } else {
      // Compatibility fallback for sessions created by older builds.
      after = await getAlbumSnapshot(
        session.albumId,
        mediaType,
        session.afterAssets || null
      );
      saved = {
        count: Math.max(0, (session.before?.count || 0) - after.count),
        bytes: Math.max(0, (session.before?.bytes || 0) - after.bytes),
      };
    }
    await statsManager.recordSession({
      type: session.type,
      albumTitle: session.albumTitle,
      before: session.before,
      after,
      savedBytes: saved.bytes,
      finishedAt: new Date().getTime(),
    });
  } catch (e) {
    // stats are best-effort
  }
  // Ephemeral (preset) sessions were never persisted — discarding here
  // would wipe the REAL paused session + saved order of the same type.
  if (!session.ephemeral) {
    await discardSession(session.type === 'video' ? 'video' : 'photo');
  }
  return saved;
}
