import AsyncStorage from '@react-native-async-storage/async-storage';
import { ALL_ALBUM_ID, getRawAlbums } from './albumHelpers';
import { log } from './logger';

/**
 * Per-album storage is keyed by album id and was never cleaned up: nothing
 * in the app called getAllKeys. Delete an album, or let Android renumber a
 * MediaStore bucket after files move, and its reviewed set (up to ~900 KB),
 * asset-list cache (up to ~1.5 MB), analysis cache and summary all become
 * unreachable garbage that survives forever. Two years of use accumulates
 * tens of MB of dead entries.
 */
const ALBUM_KEY_PATTERNS = [
  /^asset_list_v1_(?:photo|video)_(.+)$/,
  /^analysis_v3_(?:video_)?(.+)$/,
  /^album_summary_(?:video_)?(.+)$/,
];

const REVIEWED_PREFIX = '@mediacleaner/reviewed_';
const REVIEWED_SHARD_PREFIX = `${REVIEWED_PREFIX}shard_v2_`;
const REVIEWED_MIGRATION_KEY = '@mediacleaner/reviewed_global_migrated_v1';
const SHARD_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;
const STORAGE_BATCH = 40;

function shardCreatedAt(key) {
  const match = key.match(/_(\d{13})_[a-z0-9]+_\d+$/i);
  return match ? Number(match[1]) : null;
}

function albumIdOf(key) {
  // Global history and the migration marker are never orphanable. Album and
  // round scopes encode the real album id explicitly; legacy keys use it raw.
  if (key.startsWith(REVIEWED_PREFIX)) {
    if (key === REVIEWED_MIGRATION_KEY) return null;
    const suffix = key.slice(REVIEWED_PREFIX.length);
    // v2 shards are referenced by a manifest and do not encode an album id
    // that this GC can safely compare. The reviewed store removes superseded
    // shards after publishing a new manifest; deleting a live shard here
    // would corrupt the entire >20k-item history on the next app launch.
    if (
      suffix.startsWith('global:') ||
      suffix.startsWith('v:') ||
      suffix.startsWith('shard_v2_')
    ) {
      return null;
    }
    const scoped = suffix.match(/^(?:album|round):(photo|video):([^:]+)/);
    if (scoped) return scoped[2];
    return suffix || null;
  }
  for (const pattern of ALBUM_KEY_PATTERNS) {
    const m = key.match(pattern);
    if (m) return m[1];
  }
  return null;
}

/**
 * Drop per-album entries whose album no longer exists. Best effort and
 * deliberately conservative: anything unexpected aborts without deleting.
 * @returns {Promise<number>} number of keys removed
 */
export async function pruneOrphanAlbumKeys() {
  try {
    const [keys, albums] = await Promise.all([
      AsyncStorage.getAllKeys(),
      getRawAlbums(),
    ]);
    // An empty album list means the query failed or permission was revoked.
    // Treating that as "no albums exist" would wipe every cache the app has.
    if (!albums || albums.length === 0) return 0;

    const alive = new Set(albums.map((a) => String(a.id)));
    alive.add(ALL_ALBUM_ID); // the synthetic "All photos/videos" scope

    const orphans = [];
    for (const key of keys) {
      const id = albumIdOf(key);
      if (id && !alive.has(id)) orphans.push(key);
    }
    const orphanSet = new Set(orphans);
    const shardKeys = keys.filter((key) => key.startsWith(REVIEWED_SHARD_PREFIX));
    const manifestKeys = keys.filter(
      (key) =>
        key.startsWith(REVIEWED_PREFIX) &&
        !key.startsWith(REVIEWED_SHARD_PREFIX) &&
        key !== REVIEWED_MIGRATION_KEY
    );
    const liveShards = new Set();
    const orphanShards = new Set();
    let liveManifestsReadable = true;

    // A shard name cannot be safely mapped back to an album because encoded
    // album ids may contain underscores. Read the tiny manifests instead and
    // build the exact reference graph before deleting any shard payload.
    for (let i = 0; i < manifestKeys.length; i += STORAGE_BATCH) {
      // eslint-disable-next-line no-await-in-loop
      const pairs = await AsyncStorage.multiGet(
        manifestKeys.slice(i, i + STORAGE_BATCH)
      );
      const byKey = new Map(pairs);
      for (const key of manifestKeys.slice(i, i + STORAGE_BATCH)) {
        const isOrphan = orphanSet.has(key);
        try {
          const raw = byKey.get(key);
          if (!raw) throw new Error('Missing reviewed manifest');
          const value = JSON.parse(raw);
          if (Array.isArray(value)) continue; // legacy inline reviewed list
          if (
            !value ||
            value.version !== 2 ||
            !Array.isArray(value.shards)
          ) {
            throw new Error('Invalid reviewed manifest');
          }
          const target = isOrphan ? orphanShards : liveShards;
          for (const shard of value.shards) {
            if (
              typeof shard === 'string' &&
              shard.startsWith(REVIEWED_SHARD_PREFIX)
            ) {
              target.add(shard);
            }
          }
        } catch (e) {
          // Never sweep unreferenced shards if even one live manifest could
          // not be read; its references are unknown and may still be valid.
          if (!isOrphan) liveManifestsReadable = false;
        }
      }
    }

    if (liveManifestsReadable) {
      const cutoff = Date.now() - SHARD_SWEEP_GRACE_MS;
      for (const key of shardKeys) {
        if (liveShards.has(key)) continue;
        const createdAt = shardCreatedAt(key);
        if (orphanShards.has(key) || (createdAt !== null && createdAt < cutoff)) {
          orphanSet.add(key);
        }
      }
    }

    const toRemove = [...orphanSet];
    if (toRemove.length === 0) return 0;
    await AsyncStorage.multiRemove(toRemove);
    log('gc', `removed ${toRemove.length} orphan album keys`);
    return toRemove.length;
  } catch (e) {
    return 0;
  }
}
