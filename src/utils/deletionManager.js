import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import * as trashManager from './trashManager';
import { getAssetSizes, pruneLibraryIndex } from './albumHelpers';
import { log, logSync } from './logger';

/**
 * Delete a WHOLE BATCH of assets with a SINGLE media-library call — one
 * system confirmation dialog per group instead of one per photo.
 *
 * - iOS: deleteAssetsAsync (system moves them to "Recently Deleted").
 * - Android + Recycle Bin ON: copy each file into the internal trash first
 *   (30-day retention), then one deleteAssetsAsync.
 * - Android + Recycle Bin OFF: one deleteAssetsAsync, permanent.
 *
 * Returns { count, bytes, deletedIds, skipped }. `deletedIds` lists what was
 * ACTUALLY removed — callers must use it rather than assume the whole input
 * went away.
 *
 * Throws when the user rejects the system dialog, or when the library
 * reports the deletion did not happen. Callers treat a throw as "cancelled:
 * keep the marks".
 */
export async function batchDelete(assets, { useRecycleBin = false } = {}) {
  if (!assets || assets.length === 0) {
    return { count: 0, bytes: 0, bytesById: {}, deletedIds: [], skipped: 0 };
  }

  // ONE MediaStore query for the whole batch. The old per-asset loop cost a
  // native round-trip each — seconds of frozen UI before the system dialog
  // even appeared when compressing/deleting a few hundred files.
  let sizes = {};
  try {
    sizes = await getAssetSizes(assets);
  } catch (e) {
    sizes = {};
  }
  const sizeOf = (a) => sizes[a.id] || 0;

  let deletable = assets;
  let skipped = 0;
  const trashEntries = [];

  if (Platform.OS === 'android' && useRecycleBin) {
    // The recycle bin COPIES each file before deletion, so it needs as much
    // free space as the batch occupies. Checking up front turns "silently
    // lost half the batch" into an honest failure.
    const needed = assets.reduce((sum, a) => sum + sizeOf(a), 0);
    if (needed > 0) {
      try {
        const free = await FileSystem.getFreeDiskStorageAsync();
        if (free > 0 && free < needed * 1.1) {
          log('delete', `trash aborted: need ${needed}B, free ${free}B`);
          throw new Error('trash-no-space');
        }
      } catch (e) {
        if (e && e.message === 'trash-no-space') throw e;
        // free-space probe unavailable — fall through, per-file checks below
        // still protect us.
      }
    }

    deletable = [];
    for (const asset of assets) {
      // A null entry means the backup did NOT happen. Deleting anyway is
      // how photos used to disappear permanently while the UI promised a
      // 30-day recovery window.
      const entry = await trashManager.moveToTrash(asset, sizeOf(asset));
      if (entry) {
        deletable.push(asset);
        trashEntries.push(entry);
      }
      else skipped++;
    }
    if (skipped > 0) {
      log('delete', `${skipped}/${assets.length} not backed up — kept`);
    }
    if (deletable.length === 0) {
      return { count: 0, bytes: 0, bytesById: {}, deletedIds: [], skipped };
    }
  }

  const ids = deletable.map((a) => a.id);
  // deleteAssetsAsync resolves FALSE when the library declines (rejected
  // dialog on some paths, scoped-storage refusal, partial failure). Treating
  // that as success marked photos as cleaned, cleared their marks and
  // inflated the "space freed" stat while the files were still there.
  await logSync('delete', `batch start count=${ids.length} recycle=${useRecycleBin}`);
  let ok;
  try {
    ok = await MediaLibrary.deleteAssetsAsync(ids);
  } catch (e) {
    if (trashEntries.length > 0) {
      await trashManager.removeManyFromTrash(trashEntries).catch(() => {});
    }
    throw e;
  }
  if (!ok) {
    if (trashEntries.length > 0) {
      await trashManager.removeManyFromTrash(trashEntries).catch(() => {});
    }
    throw new Error('delete-rejected');
  }

  const bytes = deletable.reduce((sum, a) => sum + sizeOf(a), 0);
  const bytesById = Object.fromEntries(deletable.map((a) => [a.id, sizeOf(a)]));
  // Prune the deleted ids out of the cached library scan rather than dropping
  // it: a full rescan costs ~5.5s of JS-thread time and would be paid after
  // EVERY confirmed group, stalling the analyser mid-session.
  pruneLibraryIndex(ids);
  return { count: deletable.length, bytes, bytesById, deletedIds: ids, skipped };
}

/** Single-asset convenience wrapper around batchDelete. */
export async function permanentDelete(asset, { useRecycleBin = false } = {}) {
  const { bytes } = await batchDelete([asset], { useRecycleBin });
  return bytes;
}
