// SDK 54: the modern expo-file-system API changed; we use the stable legacy
// API which remains available at this import path.
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { readJSON, withLock, utf8ByteLength, MAX_VALUE_BYTES } from './safeStore';
import * as PhotoMove from '../../modules/photo-move';
import { log } from './logger';

const TRASH_DIR = FileSystem.documentDirectory + 'trash/';
const INDEX_KEY = '@mediacleaner/trash_index';
export const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const RESTORE_GUARD_MS = DAY_MS;
// The index is the ONLY record of what is in trash/: never silently drop old
// rows, because their backing files would become unreachable garbage. When a
// new row would exceed either cap, reject that backup and keep the source.
const MAX_ENTRIES = 4000;

function hasCompleteProtectedMetadata(metadata) {
  if (!metadata || metadata.pathRestorable !== true) return false;
  if (!metadata.originalDir || !metadata.displayName) return false;
  if (!(Number(metadata.size) > 0) || !(Number(metadata.fileMtime) > 0)) return false;
  if (!(Number(metadata.dateAdded) > 0) || !(Number(metadata.dateModified) > 0)) {
    return false;
  }
  if (typeof metadata.dateTakenPresent !== 'boolean') return false;
  if (
    metadata.dateTakenPresent &&
    (!Number.isFinite(Number(metadata.dateTaken)) || Number(metadata.dateTaken) < 0)
  ) {
    return false;
  }
  return metadata.mediaType === 'photo' || metadata.mediaType === 'video';
}

function sameProtectedMetadata(expected, actual) {
  if (!hasCompleteProtectedMetadata(expected) || !actual) return false;
  const numericFields = [
    'size',
    'dateAdded',
    'dateModified',
    'width',
    'height',
    'duration',
    'orientation',
    'fileMtime',
  ];
  if (numericFields.some((key) => Number(expected[key] || 0) !== Number(actual[key] || 0))) {
    return false;
  }
  if (expected.dateTakenPresent !== actual.dateTakenPresent) return false;
  if (
    expected.dateTakenPresent &&
    Number(expected.dateTaken) !== Number(actual.dateTaken)
  ) {
    return false;
  }
  return (
    expected.displayName === actual.displayName &&
    (expected.mimeType || null) === (actual.mimeType || null) &&
    expected.mediaType === actual.mediaType
  );
}

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
  const list = index;
  if (list.length > MAX_ENTRIES) return false;
  const payload = JSON.stringify(list);
  if (utf8ByteLength(payload) > MAX_VALUE_BYTES) return false;
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
export async function moveToTrash(asset, expectedSize = 0) {
  let dest = null;
  try {
    // Old Android binaries can only recreate a row with createAssetAsync,
    // which resets gallery dates. Do not delete an original into a recycle
    // bin that this installed binary cannot restore without metadata loss.
    if (
      Platform.OS === 'android' &&
      (Number(Platform.Version) < 29 ||
        !PhotoMove.hasSafeRestore() ||
        (Number(Platform.Version) >= 30 && !PhotoMove.hasAllFilesPermission()))
    ) {
      return null;
    }
    await ensureDir();
    const info = await MediaLibrary.getAssetInfoAsync(asset.id ? asset.id : asset);
    const protectedMetadata =
      Platform.OS === 'android'
        ? await PhotoMove.getProtectedMetadata(info.id)
        : null;
    if (Platform.OS === 'android' && !hasCompleteProtectedMetadata(protectedMetadata)) {
      return null;
    }
    const src = info.localUri || info.uri;
    if (!src) return null;
    const ext = (info.filename && info.filename.split('.').pop()) || 'bin';
    dest = `${TRASH_DIR}${info.id}_${new Date().getTime()}.${ext}`;
    await FileSystem.copyAsync({ from: src, to: dest });
    const stat = await FileSystem.getInfoAsync(dest, { size: true });
    // A short write (disk filled up mid-copy) must not be reported as a
    // successful backup — the original is about to be deleted forever.
    const sourceSize =
      Number(protectedMetadata?.size) ||
      expectedSize ||
      info.fileSize ||
      info.size ||
      0;
    if (!stat.exists || !stat.size || (sourceSize > 0 && stat.size !== sourceSize)) {
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
      modificationTime: info.modificationTime || 0,
      originalUri: src,
      originalAlbumId: info.albumId || asset.albumId || null,
      protectedMetadata,
      originalDir:
        Platform.OS === 'android'
          ? protectedMetadata.originalDir
          : typeof src === 'string' && src.startsWith('file://')
            ? src.slice(7).replace(/[\\/][^\\/]+$/, '')
            : null,
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
  return index
    .filter((e) => !e.restoredAt)
    .map((e) => ({
      ...e,
      daysLeft: Math.max(
        0,
        RETENTION_DAYS - Math.floor((now - e.deletedAt) / DAY_MS)
      ),
    }));
}

/** Restore a trash entry back into the media library. */
export async function restoreFromTrash(entry, { remove = true } = {}) {
  let asset;
  if (Platform.OS === 'android') {
    if (
      Number(Platform.Version) < 29 ||
      !PhotoMove.hasSafeRestore() ||
      (Number(Platform.Version) >= 30 && !PhotoMove.hasAllFilesPermission())
    ) {
      throw new Error('safe-restore-unavailable');
    }
    // Old entries never stored DATE_ADDED or original filesystem mtime. An
    // exact restore is mathematically impossible, so keep their backup and
    // fail visibly instead of silently assigning today's gallery date.
    if (!hasCompleteProtectedMetadata(entry.protectedMetadata)) {
      throw new Error('legacy-metadata-incomplete');
    }
    const metadata = entry.protectedMetadata;
    const restored = await PhotoMove.restoreFromTrash(
      entry.fileUri,
      metadata,
      entry.originalDir
    );
    if (!restored?.ok) {
      throw new Error(restored?.error || 'safe-restore-failed');
    }
    asset = {
      id: restored.id,
      uri: `file://${restored.path}`,
      mediaType: entry.mediaType,
      filename: entry.filename,
      creationTime: entry.creationTime,
      modificationTime: entry.modificationTime,
    };
  } else {
    // iOS uses PhotoKit's own Recently Deleted flow in normal operation.
    asset = await MediaLibrary.createAssetAsync(entry.fileUri);
  }
  // Keep the byte-for-byte backup hidden for one extra day. Some OEM media
  // providers rewrite metadata asynchronously after publishing the row; an
  // immediate delete would remove the only trustworthy recovery source.
  if (remove) await markRestored([{ ...entry, restoredId: asset.id }]);
  return asset;
}

export async function markRestored(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  const restoredFiles = new Set(list.map((entry) => entry.fileUri));
  const updated = await withLock(INDEX_KEY, async () => {
    const { ok, index } = await readIndex();
    if (!ok) return false;
    const restoredAt = Date.now();
    const restoredByFile = new Map(
      list.map((entry) => [entry.fileUri, entry.restoredId || null])
    );
    return writeIndex(
      index.map((entry) =>
        restoredFiles.has(entry.fileUri)
          ? {
              ...entry,
              restoredAt,
              restoredId: restoredByFile.get(entry.fileUri),
            }
          : entry
      )
    );
  });
  if (!updated) throw new Error('trash-index-update-failed');
}

/** Permanently remove trash entries (delete backing files + index rows). */
export async function removeManyFromTrash(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  if (list.length === 0) return;
  const gone = new Set(list.map((e) => e.fileUri));
  const indexUpdated = await withLock(INDEX_KEY, async () => {
    const { ok, index } = await readIndex();
    if (!ok) return false;
    return writeIndex(index.filter((e) => !gone.has(e.fileUri)));
  });
  if (!indexUpdated) throw new Error('trash-index-update-failed');
  // Commit the index first. A failed file deletion leaves reclaimable app
  // storage; deleting files first can leave visible rows whose only copy is
  // already gone when AsyncStorage fails.
  await Promise.all(
    list.map((e) =>
      FileSystem.deleteAsync(e.fileUri, { idempotent: true }).catch(() => {})
    )
  );
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
    const expiredFiles = [];
    for (const e of index) {
      let expired = e.restoredAt
        ? now - e.restoredAt > RESTORE_GUARD_MS
        : now - e.deletedAt > RETENTION_DAYS * DAY_MS;
      if (expired && e.restoredAt && Platform.OS === 'android') {
        // The backup is the last trustworthy copy until the restored row has
        // survived an OEM metadata pass. Missing ids, read failures, or any
        // changed field retain it for a later retry rather than risking loss.
        try {
          const current = e.restoredId
            ? await PhotoMove.getProtectedMetadata(e.restoredId)
            : null;
          expired = sameProtectedMetadata(e.protectedMetadata, current);
          if (!expired) log('trash', `restore guard retained ${e.id}`);
        } catch (err) {
          expired = false;
          log('trash', `restore guard query failed ${e.id}`);
        }
      }
      if (expired) {
        expiredFiles.push(e.fileUri);
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
    if (keep.length !== index.length) {
      const written = await writeIndex(keep);
      if (!written) return index;
      await Promise.all(
        expiredFiles.map((uri) =>
          FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
        )
      );
    }
    return keep;
  });
}
