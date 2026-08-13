import AsyncStorage from '@react-native-async-storage/async-storage';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';

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

const trashImageMem = {};

function stableKey(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** Generate a small cached JPEG for an image stored in the recycle bin. */
export async function getTrashImageThumbnail(entry) {
  const source = entry.fileUri;
  const key = `${entry.id || ''}:${entry.deletedAt || ''}:${source}`;
  if (trashImageMem[key]) return trashImageMem[key];

  const dir = `${FileSystem.cacheDirectory}trash-thumbs/`;
  const output = `${dir}${stableKey(key)}.jpg`;
  try {
    const existing = await FileSystem.getInfoAsync(output);
    if (existing.exists) {
      trashImageMem[key] = output;
      return output;
    }
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
    const result = await ImageManipulator.manipulateAsync(
      source,
      [{ resize: { width: 320 } }],
      { compress: 0.72, format: ImageManipulator.SaveFormat.JPEG }
    );
    if (result?.uri) {
      await FileSystem.copyAsync({ from: result.uri, to: output });
      trashImageMem[key] = output;
      return output;
    }
  } catch (e) {
    // The row remains usable with its media-type placeholder.
  }
  return null;
}
