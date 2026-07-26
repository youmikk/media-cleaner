import AsyncStorage from '@react-native-async-storage/async-storage';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as FileSystem from 'expo-file-system/legacy';

/**
 * Persistent video-thumbnail cache. Generating a thumbnail decodes the
 * video — expensive. The generated file lives in the app cache dir; we
 * remember its uri per asset and only regenerate when the OS has purged it.
 */
const KEY = '@mediacleaner/video_thumbs_v1';
let mem = null; // {assetId: fileUri}

async function load() {
  if (mem) return mem;
  try {
    mem = JSON.parse((await AsyncStorage.getItem(KEY)) || '{}');
  } catch (e) {
    mem = {};
  }
  return mem;
}

function persist() {
  AsyncStorage.setItem(KEY, JSON.stringify(mem)).catch(() => {});
}

/** Cached thumbnail uri for a video asset — generates once, reuses after. */
export async function getVideoThumbnail(asset, opts = {}) {
  const store = await load();
  const cached = store[asset.id];
  if (cached) {
    try {
      const info = await FileSystem.getInfoAsync(cached);
      if (info.exists) return cached;
    } catch (e) {
      return cached; // can't verify — assume it's still there
    }
  }
  const { uri } = await VideoThumbnails.getThumbnailAsync(
    asset.localUri || asset.uri,
    { time: 500, quality: 0.5, ...opts }
  );
  store[asset.id] = uri;
  persist();
  return uri;
}
