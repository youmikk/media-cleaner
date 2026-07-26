import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as trashManager from './trashManager';
import { getAssetSize } from './albumHelpers';

export const UNDO_TIMEOUT_MS = 10000;
const PENDING_KEY = '@mediacleaner/pending_deletes';

/**
 * Permanently delete an asset according to platform rules:
 * - iOS: deleteAssetsAsync (system moves it to "Recently Deleted").
 * - Android + Recycle Bin ON: copy into internal trash first, then delete.
 * - Android + Recycle Bin OFF: delete permanently.
 * Returns the freed byte count (best effort).
 */
export async function permanentDelete(asset, { useRecycleBin }) {
  let bytes = 0;
  try {
    bytes = await getAssetSize(asset);
  } catch (e) {
    bytes = 0;
  }
  if (Platform.OS === 'android' && useRecycleBin) {
    await trashManager.moveToTrash(asset);
  }
  await MediaLibrary.deleteAssetsAsync([asset.id]);
  return bytes;
}

/**
 * SoftDeleteManager
 * -----------------
 * Stack of soft-deleted assets, each with a 10s timer. When the timer fires
 * the deletion becomes permanent. `undoLast()` restores the most recent one.
 * The pending stack is mirrored to AsyncStorage so an app killed mid-session
 * can finalize leftovers on next launch (see `recoverPending`).
 */
export class SoftDeleteManager {
  constructor({ useRecycleBin = false, onFinalized, onChange } = {}) {
    this.useRecycleBin = useRecycleBin;
    this.onFinalized = onFinalized; // (asset, bytes) => void
    this.onChange = onChange; // (count) => void
    this.stack = []; // [{asset, timer}]
  }

  setOptions({ useRecycleBin }) {
    if (useRecycleBin !== undefined) this.useRecycleBin = useRecycleBin;
  }

  get count() {
    return this.stack.length;
  }

  async _persist() {
    try {
      await AsyncStorage.setItem(
        PENDING_KEY,
        JSON.stringify(this.stack.map((e) => e.asset.id))
      );
    } catch (e) {
      // best effort
    }
  }

  _emit() {
    if (this.onChange) this.onChange(this.stack.length);
    this._persist();
  }

  softDelete(asset) {
    const entry = { asset, timer: null };
    entry.timer = setTimeout(() => this._finalize(entry), UNDO_TIMEOUT_MS);
    this.stack.push(entry);
    this._emit();
    return entry;
  }

  async _finalize(entry) {
    this.stack = this.stack.filter((e) => e !== entry);
    try {
      const bytes = await permanentDelete(entry.asset, {
        useRecycleBin: this.useRecycleBin,
      });
      if (this.onFinalized) this.onFinalized(entry.asset, bytes);
    } catch (e) {
      // deletion cancelled by the system dialog or failed — treat as undone
    }
    this._emit();
  }

  /** Undo the most recent soft delete. Returns the restored asset or null. */
  undoLast() {
    const entry = this.stack.pop();
    if (!entry) return null;
    clearTimeout(entry.timer);
    this._emit();
    return entry.asset;
  }

  /** Undo a specific pending soft delete by asset id. */
  undoById(id) {
    const entry = this.stack.find((e) => e.asset.id === id);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.stack = this.stack.filter((e) => e !== entry);
    this._emit();
    return entry.asset;
  }

  /** Immediately finalize a specific pending soft delete by asset id. */
  async finalizeById(id) {
    const entry = this.stack.find((e) => e.asset.id === id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    await this._finalize(entry);
    return true;
  }

  isPending(id) {
    return this.stack.some((e) => e.asset.id === id);
  }

  /** Immediately finalize everything pending (called on exit/completion). */
  async flushAll() {
    const entries = [...this.stack];
    this.stack = [];
    for (const entry of entries) {
      clearTimeout(entry.timer);
      try {
        const bytes = await permanentDelete(entry.asset, {
          useRecycleBin: this.useRecycleBin,
        });
        if (this.onFinalized) this.onFinalized(entry.asset, bytes);
      } catch (e) {
        // ignore
      }
    }
    this._emit();
  }

  /** Cancel all timers WITHOUT deleting (e.g. discarding a session). */
  cancelAll() {
    this.stack.forEach((e) => clearTimeout(e.timer));
    this.stack = [];
    this._emit();
  }
}

/**
 * On app init: clear the mirrored pending list. Items soft-deleted in a
 * killed session were never permanently removed, so the safe recovery is to
 * leave the photos untouched and just drop the stale bookkeeping.
 */
export async function recoverPending() {
  try {
    await AsyncStorage.removeItem(PENDING_KEY);
  } catch (e) {
    // ignore
  }
}
