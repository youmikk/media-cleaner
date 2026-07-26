import AsyncStorage from '@react-native-async-storage/async-storage';

const STATS_KEY = '@mediacleaner/stats';

export const EMPTY_STATS = {
  photosCleaned: 0,
  videosCleaned: 0,
  photosViewed: 0,
  videosViewed: 0,
  spaceSavedBytes: 0,
  originalSizeBytes: 0,
  sessions: [], // [{type, albumTitle, before, after, savedBytes, finishedAt}]
};

export async function getStats() {
  try {
    const raw = await AsyncStorage.getItem(STATS_KEY);
    return raw ? { ...EMPTY_STATS, ...JSON.parse(raw) } : { ...EMPTY_STATS };
  } catch (e) {
    return { ...EMPTY_STATS };
  }
}

async function save(stats) {
  await AsyncStorage.setItem(STATS_KEY, JSON.stringify(stats));
}

export async function recordViewed(mediaType, count = 1) {
  const stats = await getStats();
  if (mediaType === 'video') stats.videosViewed += count;
  else stats.photosViewed += count;
  await save(stats);
}

export async function recordCleaned(mediaType, count, bytes = 0) {
  const stats = await getStats();
  if (mediaType === 'video') stats.videosCleaned += count;
  else stats.photosCleaned += count;
  stats.spaceSavedBytes += Math.max(0, bytes || 0);
  await save(stats);
}

export async function recordSession(session) {
  const stats = await getStats();
  stats.sessions = [session, ...stats.sessions].slice(0, 100);
  // Track the largest observed gallery size as the "original" reference.
  if (session.before && session.before.bytes > stats.originalSizeBytes) {
    stats.originalSizeBytes = session.before.bytes;
  }
  await save(stats);
}

export async function setOriginalSize(bytes) {
  const stats = await getStats();
  if (bytes > stats.originalSizeBytes) {
    stats.originalSizeBytes = bytes;
    await save(stats);
  }
}
