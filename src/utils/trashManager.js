// SDK 54: the modern expo-file-system API changed; we use the stable legacy
// API which remains available at this import path.
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { readJSON, withLock, utf8ByteLength, MAX_VALUE_BYTES } from './safeStore';

const TRASH_DIR = FileSystem.documentDirectory + 'trash/';
const INDEX_KEY = '@mediacleaner/trash_index';
export const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// The index is the ONLY record of what is in trash/: if it overflows
// Android's silent ~2 MB per-value limit the whole recycle bin disappears
// AND the copied files become unreachable garbage. Cap it like every other
// large writer in this codebase.
const MAX_ENTRIES = 4000;

async function ensureDir() {
  const info = await FileSystem.getInfoAsync(TRASH_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(TRASH_DIR, { intermediates: true });
  }
}

/**
 * @returns {{ok: boolean, index: Array}} `ok:false` means the read failed —
 * callers MUST NOT write in that case. Writing an empty array on a failed
 * read used to wipe the recycle bin (purgeExpired runs on every launch) and
 * strand every copied file with no code path left to delete it.
 */
async function readIndex() {
  const { ok, value } = await readJSON(INDEX_KEY);
  return { ok, index: Array.isArray(value) ? value : [] };
}

async function writeIndex(index) {
  let list = index;
  if (list.length > MAX_ENTRIES) list = list.slice(0, MAX_ENTRIES);
  let payload = JSON.stringify(list);
  // Shed oldest entries until the payload fits rather than let the write be
  // silently dropped.
  while (utf8ByteLength(payload) > MAX_VALUE_BYTES && list.length > 1) {
    list = list.slice(0, Math.floor(list.length * 0.8));
    payload = JSON.stringify(list);
  }
  try {
    await AsyncStorage.setItem(INDEX_KEY, payload);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Copy an asset's file into the app-internal trash folder and record it.
 * Returns the trash entry, or null on failure.
 *
 * A null return MUST block the caller's deletion — see deletionManager.
 */
export async function moveToTrash(asset) {
  let dest = null;
  try {
    await ensureDir();
    const info = await MediaLibrary.getAssetInfoAsync(asset.id ? asset.id : asset);
    const src = info.localUri || info.uri;
    if (!src) return null;
    const ext = (info.filename && info.filename.split('.').pop()) || 'bin';
    dest = `${TRASH_DIR}${info.id}_${new Date().getTime()}.${ext}`;
    await FileSystem.copyAsync({ from: src, to: dest });
    const stat = await FileSystem.getInfoAsync(dest, { size: true });
    // A short write (disk filled up mid-copy) must not be reported as a
    // successful backup — the original is about to be deleted forever.
    if (!stat.exists || !stat.size) {
      await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
      return null;
    }
    const entry = {
      id: info.id,
      filename: info.filename || `asset.${ext}`,
      mediaType: info.mediaType,
      size: stat.size || 0,
      deletedAt: new Date().getTime(),
      fileUri: dest,
      creationTime: info.creationTime || 0,
    };
    const stored = await withLock(INDEX_KEY, async () => {
      const { ok, index } = await readIndex();
      if (!ok) return false; // unknown state — don't clobber the index
      index.unshift(entry);
      return writeIndex(index);
    });
    if (!stored) {
      // The file would be unreachable without an index row: drop the copy
      // and report failure so the asset is not deleted.
      await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
      return null;
    }
    return entry;
  } catch (e) {
    if (dest) {
      await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
    }
    return null;
  }
}

/**
 * List trash entries with computed daysLeft, newest first.
 *
 * Note: this does NOT stat every backing file — that would be one disk call
 * per row on every screen focus. Entries whose file vanished are pruned by
 * purgeExpired() at launch instead.
 */
export async function listTrash() {
  const { index } = await readIndex();
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
  // The photo is back in the library, so the internal copy is redundant.
  await removeFromTrash(entry);
  return asset;
}

/** Permanently remove trash entries (delete backing files + index rows). */
export async function removeManyFromTrash(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  if (list.length === 0) return;
  await Promise.all(
    list.map((e) =>
      FileSystem.deleteAsync(e.fileUri, { idempotent: true }).catch(() => {})
    )
  );
  const gone = new Set(list.map((e) => e.fileUri));
  await withLock(INDEX_KEY, async () => {
    const { ok, index } = await readIndex();
    if (!ok) return;
    await writeIndex(index.filter((e) => !gone.has(e.fileUri)));
  });
}

/** Single-entry convenience wrapper. */
export async function removeFromTrash(entry) {
  return removeManyFromTrash([entry]);
}

/**
 * Delete items older than RETENTION_DAYS, and prune rows whose backing file
 * is gone. Call on app init.
 */
export async function purgeExpired() {
  return withLock(INDEX_KEY, async () => {
    const { ok, index } = await readIndex();
    // Bail out on a read failure: rewriting the index from a default here
    // is what used to erase the entire recycle bin.
    if (!ok) return [];
    const now = new Date().getTime();
    const keep = [];
    for (const e of index) {
      if (now - e.deletedAt > RETENTION_DAYS * DAY_MS) {
        try {
          await FileSystem.deleteAsync(e.fileUri, { idempotent: true });
        } catch (err) {
          // ignore
        }
        continue;
      }
      // Drop rows whose file disappeared (external cleaner, restore, etc.)
      try {
        const info = await FileSystem.getInfoAsync(e.fileUri);
        if (!info.exists) continue;
      } catch (err) {
        // stat failed — keep the row rather than lose a recoverable file
      }
      keep.push(e);
    }
    if (keep.length !== index.length) await writeIndex(keep);
    return keep;
  });
}
