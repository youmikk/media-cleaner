import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as trashManager from './trashManager';
import { getAssetSize } from './albumHelpers';

/**
 * Delete a WHOLE BATCH of assets with a SINGLE media-library call — one
 * system confirmation dialog per group instead of one per photo.
 *
 * - iOS: deleteAssetsAsync (system moves them to "Recently Deleted").
 * - Android + Recycle Bin ON: copy each file into the internal trash first
 *   (30-day retention), then one deleteAssetsAsync.
 * - Android + Recycle Bin OFF: one deleteAssetsAsync, permanent.
 *
 * Returns { count, bytes } actually freed (best effort). Sizes are measured
 * BEFORE deletion.
 */
export async function batchDelete(assets, { useRecycleBin = false } = {}) {
  if (!assets || assets.length === 0) return { count: 0, bytes: 0 };

  let bytes = 0;
  for (const asset of assets) {
    try {
      bytes += await getAssetSize(asset);
    } catch (e) {
      // size unknown — keep going
    }
  }

  if (Platform.OS === 'android' && useRecycleBin) {
    for (const asset of assets) {
      try {
        await trashManager.moveToTrash(asset);
      } catch (e) {
        // copy failed — the asset will still be deleted below
      }
    }
  }

  await MediaLibrary.deleteAssetsAsync(assets.map((a) => a.id));
  return { count: assets.length, bytes };
}

/** Single-asset convenience wrapper around batchDelete. */
export async function permanentDelete(asset, { useRecycleBin = false } = {}) {
  const { bytes } = await batchDelete([asset], { useRecycleBin });
  return bytes;
}
