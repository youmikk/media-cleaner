import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAlbumSnapshot } from './albumHelpers';
import * as statsManager from './statsManager';

const SESSION_KEY = '@mediacleaner/active_session';

/**
 * Start a cleaning session: capture a "before" snapshot of the album and
 * persist it so a killed app can offer resume on next launch.
 */
export async function startSession({
  type, // 'photo' | 'video'
  albumId,
  albumTitle,
  groupSize,
  assetIds = null, // optional explicit subset (suggestions)
  before, // {count, bytes} — precomputed snapshot
}) {
  const session = {
    id: `session_${new Date().getTime()}`,
    type,
    albumId,
    albumTitle,
    groupSize,
    assetIds,
    before,
    groupIndex: 0,
    cleanedCount: 0,
    createdAt: new Date().getTime(),
  };
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export async function getPendingSession() {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export async function saveProgress(patch) {
  const session = await getPendingSession();
  if (!session) return;
  await AsyncStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ ...session, ...patch })
  );
}

export async function discardSession() {
  await AsyncStorage.removeItem(SESSION_KEY);
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
  await discardSession();
  return saved;
}
