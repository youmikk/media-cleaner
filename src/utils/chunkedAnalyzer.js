import AsyncStorage from '@react-native-async-storage/async-storage';
import { InteractionManager, Platform } from 'react-native';
import { getAssets, getAssetSize, getAlbumFingerprint } from './albumHelpers';
import { analyzePixels, hammingDistance } from './imageHashing';
import { groupBursts } from './burstDetection';
import {
  subscribeLowPower,
  subscribeMemoryWarning,
  chunkSizeFor,
} from './batteryUtils';

// v3: time-windowed clustering (metrics store stays v2 — hashes unchanged,
// so the rebuild is pure math over cached hashes, no pixel work).
const CACHE_PREFIX = 'analysis_v3_';
const METRICS_KEY = 'analysis_metrics_v2'; // GLOBAL per-asset metric store
const SIMILAR_THRESHOLD = 8; // photoo uses 7; +1 for our decode variance
const SIMILAR_TIME_WINDOW_MS = 120 * 1000; // only compare shots ≤2min apart
const MAX_HASHED = 3000;
// Each parallel decode holds a FULL-RESOLUTION bitmap natively while it is
// downscaled — 6 concurrent 48MP photos ≈ >1GB peak and OOM-kills the app
// on big libraries. Keep the spike bounded. photoo-style adaptive value:
// half the CPU cores, clamped 1..3 (native core count when available).
let CONCURRENCY = Platform.OS === 'android' ? 3 : 4;
try {
  // eslint-disable-next-line global-require
  const PhotoMove = require('../../modules/photo-move');
  if (PhotoMove.isAvailable()) {
    const cores = PhotoMove.cpuCores();
    if (cores > 0) {
      CONCURRENCY = Math.min(3, Math.max(1, Math.floor(cores / 2)));
    }
  }
} catch (e) {
  // keep the static default
}
// Cap the global metric store: Android's AsyncStorage rejects values >2MB,
// which would silently lose the WHOLE cache. ~6000 entries stays well under.
const MAX_METRIC_ENTRIES = 6000;

// Low-quality thresholds
const BLUR_THRESHOLD = 45;
const UNDER_MEAN = 45;
const UNDER_RATIO = 0.55;
const OVER_MEAN = 215;
const OVER_RATIO = 0.45;
const BLANK_STDDEV = 8; // near-uniform frame => blank / pocket shot

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function yieldToUI() {
  return new Promise((resolve) => {
    InteractionManager.runAfterInteractions(() => setTimeout(resolve, 0));
  });
}

/**
 * ChunkedAnalyzer v3
 * ------------------
 * - Metrics (hash / sharpness / exposure) are stored PER ASSET in one global
 *   store, persisted INCREMENTALLY after every chunk. Killing or cancelling
 *   the app never loses progress, revisits resume instead of restarting, and
 *   assets shared between albums ("All Photos" ∩ "Screenshots") are decoded
 *   exactly once.
 * - No file-size lookups during analysis (they doubled the per-photo cost);
 *   size-based features compute sizes themselves.
 * - One album at a time (FIFO), pause/requeue on album switch, low-power
 *   chunk shrink (50 -> 10), memory-warning pause. Album caches store only
 *   derived results (clusters/bursts/lowQuality) + freshness fingerprint.
 */
class ChunkedAnalyzer {
  constructor() {
    this.queue = [];
    this.current = null;
    this.listeners = new Set();
    this.lowPower = false;
    this.memoryPaused = false;
    this.suspended = false; // e.g. while a cleaning session is active
    this.metrics = null; // id -> {hash, sharpness, brightness}
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

  async _loadMetrics() {
    if (this.metrics) return this.metrics;
    try {
      const raw = await AsyncStorage.getItem(METRICS_KEY);
      this.metrics = raw ? JSON.parse(raw) : {};
    } catch (e) {
      this.metrics = {};
    }
    return this.metrics;
  }

  async _persistMetrics() {
    try {
      // FIFO eviction: JS object keys keep insertion order, so the first
      // keys are the oldest metrics.
      const keys = Object.keys(this.metrics);
      if (keys.length > MAX_METRIC_ENTRIES) {
        const drop = keys.length - MAX_METRIC_ENTRIES;
        for (let i = 0; i < drop; i++) delete this.metrics[keys[i]];
      }
      await AsyncStorage.setItem(METRICS_KEY, JSON.stringify(this.metrics));
    } catch (e) {
      // best effort
    }
  }

  /** Metrics for one asset — instant when already analyzed. */
  async metricsFor(asset) {
    const store = await this._loadMetrics();
    if (store[asset.id]) return store[asset.id];
    const m = await analyzePixels(asset.localUri || asset.uri);
    store[asset.id] = m;
    this._persistMetrics(); // fire & forget
    return m;
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
      };

      if (this.current) {
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

  /** Pause heavy work while the user is actively cleaning — keeps swipes
   *  buttery. resume() picks up exactly where it left off. */
  suspend() {
    this.suspended = true;
  }

  resume() {
    this.suspended = false;
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
      const store = await this._loadMetrics();
      const assets = await getAssets(albumId, mediaType);
      const scope = assets.slice(0, MAX_HASHED);

      // Only photos we have NOT seen before need pixel work — everything
      // already in the global store is free.
      const targets =
        mediaType === 'photo' ? scope.filter((a) => !store[a.id]) : [];
      const total = targets.length;
      this._emit({ running: true, albumId, done: 0, total });

      let i = 0;
      let sinceSave = 0;
      while (i < total) {
        if (job.cancelled) {
          await this._persistMetrics(); // keep what we got
          job.resolvers.forEach((r) => r(null));
          finished = true;
          return;
        }
        if (job.pauseRequested) {
          await this._persistMetrics();
          finished = true; // re-queued by analyzeAlbum
          return;
        }
        while ((this.memoryPaused || this.suspended) && !job.cancelled)
          await sleep(400);

        const chunk = chunkSizeFor(this.lowPower);
        const end = Math.min(i + chunk, total);
        // YIELD the JS thread after EVERY small batch — the analyzer must
        // never hold the thread long enough for touches to feel laggy.
        while (i < end && !job.cancelled && !job.pauseRequested) {
          if (this.suspended || this.memoryPaused) break;
          const batch = targets.slice(i, Math.min(i + CONCURRENCY, end));
          await Promise.all(
            batch.map(async (a) => {
              try {
                store[a.id] = await analyzePixels(a.uri);
              } catch (e) {
                store[a.id] = { hash: null, sharpness: 0, brightness: null };
              }
            })
          );
          i += batch.length;
          await sleep(0); // give the UI thread a turn between batches
        }
        sinceSave += chunk;
        if (sinceSave >= 50) {
          sinceSave = 0;
          await this._persistMetrics(); // INCREMENTAL: survive app kills
        }
        this._emit({ done: i });
        job.progressCbs.forEach((cb) => cb(i, total));
        await yieldToUI();
      }
      await this._persistMetrics();

      // ---- Aggregate derived results for THIS album ----
      const clusters = mediaType === 'photo' ? this._cluster(scope, store) : [];
      const bursts = mediaType === 'photo' ? groupBursts(scope) : [];
      const lowQuality = [];
      if (mediaType === 'photo') {
        for (const a of scope) {
          const m = store[a.id];
          if (!m || !m.hash) continue;
          const b = m.brightness || {};
          if (b.stdDev !== undefined && b.stdDev < BLANK_STDDEV) {
            lowQuality.push({ id: a.id, reason: 'blank' });
          } else if (m.sharpness < BLUR_THRESHOLD) {
            lowQuality.push({ id: a.id, reason: 'blurry' });
          } else if (b.mean < UNDER_MEAN || b.underRatio > UNDER_RATIO) {
            lowQuality.push({ id: a.id, reason: 'underexposed' });
          } else if (b.mean > OVER_MEAN || b.overRatio > OVER_RATIO) {
            lowQuality.push({ id: a.id, reason: 'overexposed' });
          }
        }
      }

      // ---- EXACT duplicates: identical hash + identical dimensions,
      // confirmed by identical file size (only candidates get a size call) --
      let duplicates = [];
      if (mediaType === 'photo') {
        const buckets = new Map();
        for (const a of scope) {
          const m = store[a.id];
          if (!m || !m.hash) continue;
          const key = `${m.hash}_${a.width}x${a.height}`;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(a);
        }
        for (const members of buckets.values()) {
          if (members.length < 2) continue;
          const bySize = new Map();
          for (const a of members) {
            let size = 0;
            try {
              size = await getAssetSize(a);
            } catch (e) {
              size = 0;
            }
            if (!bySize.has(size)) bySize.set(size, []);
            bySize.get(size).push(a.id);
          }
          for (const ids of bySize.values()) {
            if (ids.length >= 2) duplicates.push(ids);
          }
        }
      }

      const fp = await getAlbumFingerprint(albumId, mediaType);
      const result = {
        albumId,
        mediaType,
        assetCount: fp.assetCount,
        latestModificationTime: fp.latestModificationTime,
        createdAt: new Date().getTime(),
        clusters,
        bursts,
        lowQuality,
        duplicates, // Array<string[]> — exact-duplicate id groups
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

  /**
   * photoo-style clustering: only photos taken within TIME_WINDOW of each
   * other are compared (fewer false positives, orders of magnitude fewer
   * comparisons), and a Live Photo next to its same-moment still frame is
   * NOT a duplicate.
   */
  _cluster(assets, store) {
    const isLive = (a) =>
      Array.isArray(a.mediaSubtypes) &&
      a.mediaSubtypes.some((s) => String(s).toLowerCase().includes('live'));
    const entries = assets
      .filter((a) => store[a.id] && store[a.id].hash)
      .sort((x, y) => (y.creationTime || 0) - (x.creationTime || 0));
    const used = new Set();
    const clusters = [];
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i];
      if (used.has(a.id)) continue;
      const cluster = [a.id];
      let lastTime = a.creationTime || 0;
      for (let j = i + 1; j < entries.length; j++) {
        const b = entries[j];
        if (used.has(b.id)) continue;
        const bt = b.creationTime || 0;
        // Sorted desc: once past the window from the cluster's newest
        // accepted member, nothing further can match — stop early.
        if (lastTime - bt > SIMILAR_TIME_WINDOW_MS) break;
        // A Live Photo and a plain still captured the same instant are
        // two forms of the SAME shot — not duplicates to clean.
        if (
          isLive(a) !== isLive(b) &&
          Math.abs((a.creationTime || 0) - bt) <= 2000
        ) {
          continue;
        }
        if (
          hammingDistance(store[a.id].hash, store[b.id].hash) <=
          SIMILAR_THRESHOLD
        ) {
          cluster.push(b.id);
          used.add(b.id);
          lastTime = bt; // window chains from the newest accepted member
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
