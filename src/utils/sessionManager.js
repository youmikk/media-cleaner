import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAlbumSnapshot } from './albumHelpers';
import * as statsManager from './statsManager';
import { readJSON, withLock } from './safeStore';

// Sessions are stored PER TYPE — a video session must never overwrite a
// paused photo session (that wiped the saved random order and caused
// "re-entering shows a different group").
const SESSION_KEY = (type) => `@mediacleaner/active_session_${type}`;
const ORDER_KEY = '@mediacleaner/session_order';

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
    before,
    groupIndex: 0,
    photoIndex: 0,
    markedIds: [],
    createdAt: new Date().getTime(),
  };
  await withLock(SESSION_KEY(type), async () => {
    await AsyncStorage.setItem(SESSION_KEY(type), JSON.stringify(session));
  });
  // The saved random ORDER belongs to photo sessions only — starting a
  // VIDEO session must not touch it.
  if (type === 'photo') await AsyncStorage.removeItem(ORDER_KEY);
  return session;
}

export async function getPendingSession(type = 'photo') {
  const { value } = await readJSON(SESSION_KEY(type));
  return value || null;
}

/**
 * Persist the exact (possibly shuffled) cleaning order so resume restores
 * the same sequence. Stored separately — it's large and rarely changes.
 */
export async function saveOrder(assetIds) {
  try {
    await AsyncStorage.setItem(ORDER_KEY, JSON.stringify(assetIds));
  } catch (e) {
    // best effort
  }
}

export async function getOrder() {
  const { value } = await readJSON(ORDER_KEY);
  return Array.isArray(value) ? value : null;
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
    if (type === 'photo') await AsyncStorage.removeItem(ORDER_KEY);
  });
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
    // Reuse the asset list the caller already has: recomputing it meant
    // paging the entire album (up to 100 round-trips) while the screen was
    // being torn down.
    const after = await getAlbumSnapshot(
      session.albumId,
      mediaType,
      session.afterAssets || null
    );
    saved =
      measured && measured.bytes >= 0
        ? { count: measured.count || 0, bytes: measured.bytes || 0 }
        : {
            count: Math.max(0, (session.before?.count || 0) - after.count),
            bytes: Math.max(0, (session.before?.bytes || 0) - after.bytes),
          };
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
