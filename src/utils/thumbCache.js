import AsyncStorage from '@react-native-async-storage/async-storage';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { utf8ByteLength } from './safeStore';

/**
 * Persistent video-thumbnail cache. Generating a thumbnail decodes the
 * video — expensive. The generated file lives in the app cache dir; we
 * remember its uri per asset and only regenerate when the OS has purged it.
 */
const KEY = '@mediacleaner/video_thumbs_v1';
const MAX_ENTRIES = 2000;
const MAX_VALUE_BYTES = 1.6 * 1024 * 1024;
let mem = null; // {assetId: fileUri}; insertion order evicts the oldest entry
let loadPromise = null;
const pending = new Map();
let persistTimer = null;
let persistChain = Promise.resolve();
let cacheGeneration = 0;

async function load() {
  if (mem) return mem;
  if (!loadPromise) {
    loadPromise = AsyncStorage.getItem(KEY)
      .then((raw) => {
        mem = JSON.parse(raw || '{}');
        return mem;
      })
      .catch(() => {
        mem = {};
        return mem;
      })
      .finally(() => {
        loadPromise = null;
      });
  }
  return loadPromise;
}

function trim() {
  if (!mem) return;
  const keys = Object.keys(mem);
  const evictOldest = () => {
    const oldest = keys.shift();
    if (!oldest) return false;
    const uri = mem[oldest];
    delete mem[oldest];
    if (uri) FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    return true;
  };
  while (keys.length > MAX_ENTRIES) {
    if (!evictOldest()) break;
  }
  let payload = JSON.stringify(mem);
  while (utf8ByteLength(payload) > MAX_VALUE_BYTES) {
    if (!evictOldest()) break;
    payload = JSON.stringify(mem);
  }
}

function flushPersist() {
  if (!mem) return persistChain;
  trim();
  const payload = JSON.stringify(mem);
  persistChain = persistChain
    .catch(() => {})
    .then(() => AsyncStorage.setItem(KEY, payload));
  return persistChain.catch(() => {});
}

function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushPersist();
  }, 200);
}

/** Cached thumbnail uri for a video asset — generates once, reuses after. */
export async function getVideoThumbnail(asset, opts = {}) {
  const store = await load();
  const id = String(asset.id);
  const cached = store[asset.id];
  if (cached) {
    try {
      const info = await FileSystem.getInfoAsync(cached);
      if (info.exists) return cached;
    } catch (e) {
      return cached; // can't verify — assume it's still there
    }
  }
  if (pending.has(id)) return pending.get(id);
  const generation = cacheGeneration;
  const task = VideoThumbnails.getThumbnailAsync(asset.localUri || asset.uri, {
    time: 500,
    quality: 0.5,
    ...opts,
  })
    .then(({ uri }) => {
      if (generation === cacheGeneration) {
        store[id] = uri;
        trim();
        persist();
      }
      return uri;
    })
    .finally(() => {
      if (pending.get(id) === task) pending.delete(id);
    });
  pending.set(id, task);
  return task;
}

const trashImageMem = {};
const trashPending = new Map();

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
  if (trashPending.has(key)) return trashPending.get(key);

  const dir = `${FileSystem.cacheDirectory}trash-thumbs/`;
  const output = `${dir}${stableKey(key)}.jpg`;
  const task = (async () => {
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
        await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => {});
        trashImageMem[key] = output;
        return output;
      }
    } catch (e) {
      // The row remains usable with its media-type placeholder.
    }
    return null;
  })().finally(() => {
    if (trashPending.get(key) === task) trashPending.delete(key);
  });
  trashPending.set(key, task);
  return task;
}

export async function getThumbnailCacheBytes() {
  const store = await load();
  let bytes = 0;
  const files = Object.values(store);
  for (let i = 0; i < files.length; i += 20) {
    // eslint-disable-next-line no-await-in-loop
    const sizes = await Promise.all(
      files.slice(i, i + 20).map(async (uri) => {
        try {
          const info = await FileSystem.getInfoAsync(uri);
          return info.exists ? Number(info.size) || 0 : 0;
        } catch (e) {
          return 0;
        }
      })
    );
    bytes += sizes.reduce((sum, size) => sum + size, 0);
  }
  const trashDir = `${FileSystem.cacheDirectory}trash-thumbs/`;
  try {
    const names = await FileSystem.readDirectoryAsync(trashDir);
    const sizes = await Promise.all(
      names.map(async (name) => {
        try {
          const info = await FileSystem.getInfoAsync(`${trashDir}${name}`);
          return info.exists ? Number(info.size) || 0 : 0;
        } catch (e) {
          return 0;
        }
      })
    );
    bytes += sizes.reduce((sum, size) => sum + size, 0);
  } catch (e) {
    // Directory has not been created yet.
  }
  return bytes;
}

export async function clearThumbnailCache() {
  cacheGeneration += 1;
  const inflight = [...pending.values(), ...trashPending.values()];
  pending.clear();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await persistChain.catch(() => {});
  const settled = await Promise.allSettled(inflight);
  const generated = settled
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result) => result.value);
  const files = mem ? [...Object.values(mem), ...generated] : generated;
  mem = {};
  Object.keys(trashImageMem).forEach((key) => delete trashImageMem[key]);
  trashPending.clear();
  await AsyncStorage.removeItem(KEY).catch(() => {});
  await Promise.all(files.map((uri) => FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})));
  const dir = `${FileSystem.cacheDirectory}trash-thumbs/`;
  await FileSystem.deleteAsync(dir, { idempotent: true }).catch(() => {});
}
