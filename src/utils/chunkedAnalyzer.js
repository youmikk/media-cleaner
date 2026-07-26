import AsyncStorage from '@react-native-async-storage/async-storage';
import { InteractionManager } from 'react-native';
import {
  getAssets,
  getAssetSize,
  getAlbumFingerprint,
} from './albumHelpers';
import { aHash, hammingDistance } from './imageHashing';
import { laplacianVariance } from './sharpness';
import { groupBursts } from './burstDetection';
import {
  subscribeLowPower,
  subscribeMemoryWarning,
  chunkSizeFor,
} from './batteryUtils';

const CACHE_PREFIX = 'analysis_';
const SIMILAR_THRESHOLD = 10; // hamming distance on 64-bit aHash
const MAX_HASHED = 3000; // cap heavy per-photo work for huge albums

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Yield to the UI thread between chunks. */
function yieldToUI() {
  return new Promise((resolve) => {
    InteractionManager.runAfterInteractions(() => setTimeout(resolve, 0));
  });
}

/**
 * ChunkedAnalyzer
 * ----------------
 * - FIFO queue; only ONE album analyzed at a time.
 * - Selecting a different album pauses the current job (progress kept) and
 *   moves it to the back of the queue.
 * - Chunk size adapts to low-power mode (50 -> 10); iOS memory warnings
 *   pause the loop entirely until pressure clears.
 * - Results cached in AsyncStorage under `analysis_${albumId}` together with
 *   { assetCount, latestModificationTime } for staleness detection.
 */
class ChunkedAnalyzer {
  constructor() {
    this.queue = [];
    this.current = null;
    this.listeners = new Set();
    this.lowPower = false;
    this.memoryPaused = false;
    this.state = {
      running: false,
      albumId: null,
      done: 0,
      total: 0,
      lowPower: false,
      memoryPaused: false,
    };
    this._powerInit = false;
  }

  _initPowerAdaptation() {
    if (this._powerInit) return;
    this._powerInit = true;
    subscribeLowPower((low) => {
      this.lowPower = low;
      this._emit({ lowPower: low });
    });
    subscribeMemoryWarning(() => {
      this.memoryPaused = true;
      this._emit({ memoryPaused: true });
      // Resume automatically after a cool-down period.
      setTimeout(() => {
        this.memoryPaused = false;
        this._emit({ memoryPaused: false });
      }, 8000);
    });
  }

  subscribe(cb) {
    this.listeners.add(cb);
    cb(this.state);
    return () => this.listeners.delete(cb);
  }

  _emit(patch = {}) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((cb) => cb(this.state));
  }

  cacheKey(albumId, mediaType) {
    return mediaType === 'video'
      ? `${CACHE_PREFIX}video_${albumId}`
      : `${CACHE_PREFIX}${albumId}`;
  }

  async getCached(albumId, mediaType = 'photo') {
    try {
      const raw = await AsyncStorage.getItem(this.cacheKey(albumId, mediaType));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Compare the stored fingerprint with the album's current one.
   * Returns { cache, stale } — cache may be non-null but stale.
   */
  async checkCache(albumId, mediaType = 'photo') {
    const cache = await this.getCached(albumId, mediaType);
    if (!cache) return { cache: null, stale: false };
    try {
      const fp = await getAlbumFingerprint(albumId, mediaType);
      const stale =
        fp.assetCount !== cache.assetCount ||
        fp.latestModificationTime !== cache.latestModificationTime;
      return { cache, stale };
    } catch (e) {
      return { cache, stale: false };
    }
  }

  /**
   * Queue an album for analysis. Resolves with the analysis result, or null
   * when cancelled. If the album is already cached and fresh (and !force),
   * resolves immediately from cache.
   */
  analyzeAlbum(albumId, options = {}) {
    const { mediaType = 'photo', force = false, onProgress } = options;
    this._initPowerAdaptation();

    return new Promise(async (resolve) => {
      if (!force) {
        const { cache, stale } = await this.checkCache(albumId, mediaType);
        if (cache && !stale) {
          resolve(cache);
          return;
        }
      }

      // Already queued or running for this album? Attach to it.
      if (this.current && this.current.albumId === albumId && !this.current.cancelled) {
        this.current.resolvers.push(resolve);
        if (onProgress) this.current.progressCbs.push(onProgress);
        return;
      }
      const queued = this.queue.find((j) => j.albumId === albumId);
      if (queued) {
        queued.resolvers.push(resolve);
        if (onProgress) queued.progressCbs.push(onProgress);
        return;
      }

      const job = {
        albumId,
        mediaType,
        resolvers: [resolve],
        progressCbs: onProgress ? [onProgress] : [],
        cancelled: false,
        pauseRequested: false,
        doneIndex: 0,
        hashes: {},
        sizes: {},
      };

      if (this.current) {
        // Pause the running job, keep its progress, run the new one first.
        this.current.pauseRequested = true;
        this.queue.push(this.current);
        this.queue.unshift(job);
      } else {
        this.queue.push(job);
        this._next();
      }
    });
  }

  cancel(albumId) {
    if (this.current && (!albumId || this.current.albumId === albumId)) {
      this.current.cancelled = true;
    }
    this.queue = this.queue.filter((j) => {
      if (!albumId || j.albumId === albumId) {
        j.resolvers.forEach((r) => r(null));
        return false;
      }
      return true;
    });
  }

  cancelAll() {
    this.cancel();
  }

  async _next() {
    if (this.current || this.queue.length === 0) return;
    const job = this.queue.shift();
    this.current = job;
    job.pauseRequested = false;
    await this._run(job);
  }

  async _run(job) {
    const { albumId, mediaType } = job;
    let finished = false;
    try {
      const assets = await getAssets(albumId, mediaType);
      const total = assets.length;
      const heavyTotal = Math.min(total, MAX_HASHED);
      this._emit({ running: true, albumId, done: job.doneIndex, total: heavyTotal });

      let i = job.doneIndex;
      while (i < heavyTotal) {
        if (job.cancelled) {
          job.resolvers.forEach((r) => r(null));
          finished = true;
          return;
        }
        if (job.pauseRequested) {
          job.doneIndex = i;
          finished = true; // job re-queued by analyzeAlbum
          return;
        }
        while (this.memoryPaused && !job.cancelled) await sleep(500);

        const chunk = chunkSizeFor(this.lowPower);
        const end = Math.min(i + chunk, heavyTotal);
        for (; i < end; i++) {
          const a = assets[i];
          try {
            if (mediaType === 'photo') {
              job.hashes[a.id] = await aHash(a.uri);
            }
            job.sizes[a.id] = await getAssetSize(a);
          } catch (e) {
            // unreadable asset -> skip
          }
          if (job.cancelled || job.pauseRequested) break;
        }
        job.doneIndex = i;
        this._emit({ done: i });
        job.progressCbs.forEach((cb) => cb(i, heavyTotal));
        await yieldToUI();
      }

      // ---- Aggregate results ----
      const clusters =
        mediaType === 'photo' ? this._cluster(assets, job.hashes) : [];
      const bursts =
        mediaType === 'photo' ? groupBursts(assets.slice(0, heavyTotal)) : [];

      // Sharpness only for burst members (bounded work).
      const sharpness = {};
      if (mediaType === 'photo') {
        const assetById = Object.fromEntries(assets.map((a) => [a.id, a]));
        for (const g of bursts.slice(0, 20)) {
          for (const id of g.ids) {
            if (job.cancelled) break;
            const a = assetById[id];
            if (a) sharpness[id] = await laplacianVariance(a.uri);
          }
          await yieldToUI();
        }
      }

      const fp = await getAlbumFingerprint(albumId, mediaType);
      const result = {
        albumId,
        mediaType,
        assetCount: fp.assetCount,
        latestModificationTime: fp.latestModificationTime,
        createdAt: new Date().getTime(),
        clusters, // Array<string[]> asset-id clusters of similar photos
        bursts, // Array<{ids, startTime}>
        sharpness, // id -> laplacian variance
        sizes: job.sizes, // id -> bytes (sampled set)
      };
      await AsyncStorage.setItem(
        this.cacheKey(albumId, mediaType),
        JSON.stringify(result)
      );
      job.resolvers.forEach((r) => r(result));
      finished = true;
    } catch (e) {
      job.resolvers.forEach((r) => r(null));
      finished = true;
    } finally {
      this.current = null;
      this._emit({ running: false, albumId: null, done: 0, total: 0 });
      if (finished) this._next();
    }
  }

  /** Greedy clustering of assets by aHash hamming distance. */
  _cluster(assets, hashes) {
    const entries = assets.filter((a) => hashes[a.id]);
    const used = new Set();
    const clusters = [];
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i];
      if (used.has(a.id)) continue;
      const cluster = [a.id];
      for (let j = i + 1; j < entries.length; j++) {
        const b = entries[j];
        if (used.has(b.id)) continue;
        if (hammingDistance(hashes[a.id], hashes[b.id]) <= SIMILAR_THRESHOLD) {
          cluster.push(b.id);
          used.add(b.id);
        }
      }
      if (cluster.length > 1) {
        used.add(a.id);
        clusters.push(cluster);
      }
    }
    return clusters;
  }
}

const analyzer = new ChunkedAnalyzer();
export default analyzer;
