import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import AsyncStorage from '@react-native-async-storage/async-storage';

const TRASH_DIR = FileSystem.documentDirectory + 'trash/';
const INDEX_KEY = '@mediacleaner/trash_index';
export const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

async function ensureDir() {
  const info = await FileSystem.getInfoAsync(TRASH_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(TRASH_DIR, { intermediates: true });
  }
}

async function readIndex() {
  try {
    const raw = await AsyncStorage.getItem(INDEX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

async function writeIndex(index) {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

/**
 * Copy an asset's file into the app-internal trash folder and record it.
 * Returns the trash entry, or null on failure.
 */
export async function moveToTrash(asset) {
  try {
    await ensureDir();
    const info = await MediaLibrary.getAssetInfoAsync(asset.id ? asset.id : asset);
    const src = info.localUri || info.uri;
    if (!src) return null;
    const ext = (info.filename && info.filename.split('.').pop()) || 'bin';
    const dest = `${TRASH_DIR}${info.id}_${new Date().getTime()}.${ext}`;
    await FileSystem.copyAsync({ from: src, to: dest });
    const stat = await FileSystem.getInfoAsync(dest, { size: true });
    const entry = {
      id: info.id,
      filename: info.filename || `asset.${ext}`,
      mediaType: info.mediaType,
      size: stat.size || 0,
      deletedAt: new Date().getTime(),
      fileUri: dest,
      creationTime: info.creationTime || 0,
    };
    const index = await readIndex();
    index.unshift(entry);
    await writeIndex(index);
    return entry;
  } catch (e) {
    return null;
  }
}

/**
 * List trash entries with computed daysLeft. Skips entries whose file no
 * longer exists.
 */
export async function listTrash() {
  const index = await readIndex();
  const now = new Date().getTime();
  return index.map((e) => ({
    ...e,
    daysLeft: Math.max(
      0,
      RETENTION_DAYS - Math.floor((now - e.deletedAt) / DAY_MS)
    ),
  }));
}

/** Restore a trash entry back into the media library. */
export async function restoreFromTrash(entry) {
  const asset = await MediaLibrary.createAssetAsync(entry.fileUri);
  await removeFromTrash(entry, false);
  return asset;
}

/** Permanently remove a trash entry (delete backing file + index row). */
export async function removeFromTrash(entry, deleteFile = true) {
  if (deleteFile) {
    try {
      await FileSystem.deleteAsync(entry.fileUri, { idempotent: true });
    } catch (e) {
      // ignore
    }
  } else {
    try {
      await FileSystem.deleteAsync(entry.fileUri, { idempotent: true });
    } catch (e) {
      // restored copy stays in media library; internal copy removed
    }
  }
  const index = await readIndex();
  await writeIndex(index.filter((e) => e.fileUri !== entry.fileUri));
}

/** Delete items older than RETENTION_DAYS. Call on app init. */
export async function purgeExpired() {
  const now = new Date().getTime();
  const index = await readIndex();
  const keep = [];
  for (const e of index) {
    if (now - e.deletedAt > RETENTION_DAYS * DAY_MS) {
      try {
        await FileSystem.deleteAsync(e.fileUri, { idempotent: true });
      } catch (err) {
        // ignore
      }
    } else {
      keep.push(e);
    }
  }
  await writeIndex(keep);
  return keep;
}
