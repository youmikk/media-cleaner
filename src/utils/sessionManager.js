import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAlbumSnapshot } from './albumHelpers';
import * as statsManager from './statsManager';

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
  await AsyncStorage.setItem(SESSION_KEY(type), JSON.stringify(session));
  // The saved random ORDER belongs to photo sessions only — starting a
  // VIDEO session must not touch it.
  if (type === 'photo') await AsyncStorage.removeItem(ORDER_KEY);
  return session;
}

export async function getPendingSession(type = 'photo') {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY(type));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
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
  try {
    const raw = await AsyncStorage.getItem(ORDER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export async function saveProgress(patch, type = 'photo') {
  const session = await getPendingSession(type);
  if (!session) return;
  await AsyncStorage.setItem(
    SESSION_KEY(type),
    JSON.stringify({ ...session, ...patch })
  );
}

export async function discardSession(type = 'photo') {
  await AsyncStorage.removeItem(SESSION_KEY(type));
  if (type === 'photo') await AsyncStorage.removeItem(ORDER_KEY);
}

/**
 * End the session: compute the "after" snapshot, store the difference into
 * persistent stats (feeds the storage comparison chart), clear the session.
 */
export async function finishSession(session) {
  let saved = { count: 0, bytes: 0 };
  try {
    const mediaType = session.type === 'video' ? 'video' : 'photo';
    const after = await getAlbumSnapshot(session.albumId, mediaType);
    saved = {
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
  await discardSession(session.type === 'video' ? 'video' : 'photo');
  return saved;
}
