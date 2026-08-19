import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, InteractionManager, Platform } from 'react-native';
import { getAssets, getAssetSizes, getAlbumFingerprint } from './albumHelpers';
import { analyzePixels, hammingDistance } from './imageHashing';
import { groupBursts } from './burstDetection';
import { log } from './logger';
import { runMediaWork } from './mediaWorkScheduler';
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
const METRIC_VERSION = 3;
// Each parallel decode holds a FULL-RESOLUTION bitmap natively while it is
// downscaled — 6 concurrent 48MP photos ≈ >1GB peak and OOM-kills the app
// on big libraries. Keep the spike bounded. photoo-style adaptive value:
// half the CPU cores, clamped 1..3 (native core count when available).
let CONCURRENCY = 3;
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
// Budget for the global metric store. Android's AsyncStorage rejects values
// over ~2 MB and loses the WHOLE entry, so stay well under.
//
// This used to be a flat entry COUNT with blind insertion-order eviction,
// which can thrash: once the store is full, finishing a pass evicts the
// entries the SAME pass analysed earlier, so the next run re-decodes them,
// evicts others, and never converges — the device just stays hot. Eviction
// is now (a) driven by actual bytes and (b) forbidden from touching ids the
// running job still depends on.
const MAX_METRIC_BYTES = 1200000;
// Writing the whole store is O(store); doing it every 50 photos meant ~60
// full serialisations per pass. Time-based instead, and only when dirty.
const PERSIST_INTERVAL_MS = 8000;
// Floor on how long one photo may take. Decoding flat out for the length of
// a 3000-photo pass heats the device until the SoC throttles, which slows
// everything down INCLUDING the UI — pacing is faster in wall-clock terms
// than running hot. Slightly looser when only one decode runs at a time.
const TARGET_MS_PER_PHOTO = CONCURRENCY > 1 ? 28 : 40;
const MAX_COOLDOWN_MS = 120; // never stall a batch longer than this

// One decode budget shared by album analysis and on-demand burst scoring.
// Without this, metricsFor() could add another full-resolution decode on top
// of the analyzer's batch and exceed the memory ceiling this constant exists
// to enforce. Same-asset requests also share one in-flight result.
let activeDecodes = 0;
const decodeQueue = [];
const pixelInFlight = new Map();

function withDecodeSlot(work) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeDecodes += 1;
      Promise.resolve()
        .then(work)
        .then(resolve, reject)
        .finally(() => {
          activeDecodes -= 1;
          const next = decodeQueue.shift();
          if (next) next();
        });
    };
    if (activeDecodes < CONCURRENCY) run();
    else decodeQueue.push(run);
  });
}

function analyzeAssetPixels(asset) {
  const key = `${asset.id}:${asset.modificationTime || 0}:${asset.width || 0}x${
    asset.height || 0
  }`;
  if (pixelInFlight.has(key)) return pixelInFlight.get(key);
  const task = withDecodeSlot(() =>
    analyzePixels(asset.localUri || asset.uri)
  ).finally(() => {
    if (pixelInFlight.get(key) === task) pixelInFlight.delete(key);
  });
  pixelInFlight.set(key, task);
  return task;
}

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
    this.appActive = !['background', 'inactive'].includes(AppState.currentState);
    this.suspendCount = 0; // nested screens each own one suspend token
    this.metrics = null; // id -> {hash, sharpness, brightness}
    this._metricsDirty = false;
    this._metricsGeneration = 0;
    this._persistPromise = null;
    this._persistRetryTimer = null;
    this._persistRetryCount = 0;
    this._lastPersist = 0;
    this.state = {
      running: false,
      albumId: null,
      mediaType: null,
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
    log('analysis', `metrics loaded: ${Object.keys(this.metrics).length}`);
    return this.metrics;
  }

  /**
   * Write the store, trimming to the byte budget first.
   *
   * `keep` is the id set the running job still needs. Evicting those is what
   * turns a full store into a treadmill — the pass would re-decode them
   * immediately — so they are only sacrificed if nothing else is left and
   * the value would otherwise be rejected outright.
   */
  async _persistMetrics(keep = null) {
    if (!this.metrics || !this._metricsDirty) return;
    if (this._persistPromise) return this._persistPromise;
    const generation = this._metricsGeneration;
    this._metricsDirty = false;
    this._lastPersist = new Date().getTime();
    const run = (async () => {
      let succeeded = false;
      try {
        let json = JSON.stringify(this.metrics);
        if (json.length > MAX_METRIC_BYTES) {
          const keys = Object.keys(this.metrics);
          const perEntry = json.length / Math.max(1, keys.length);
          let toDrop = keys.length - Math.floor(MAX_METRIC_BYTES / perEntry);
          let dropped = 0;
          // Pass 1: oldest first, but never something in active use.
          for (const k of keys) {
            if (toDrop <= 0) break;
            if (keep && keep.has(k)) continue;
            delete this.metrics[k];
            toDrop--;
            dropped++;
          }
        // Pass 2: still over budget because everything is in use. Dropping
        // in-use entries costs a re-decode, but writing an oversized value
        // loses the ENTIRE store, which costs all of them.
          if (toDrop > 0) {
            for (const k of Object.keys(this.metrics)) {
              if (toDrop <= 0) break;
              delete this.metrics[k];
              toDrop--;
              dropped++;
            }
          }
          json = JSON.stringify(this.metrics);
          log(
            'analysis',
            `metrics evicted ${dropped}, kept ${Object.keys(this.metrics).length}`
          );
        }
        await AsyncStorage.setItem(METRICS_KEY, json);
        succeeded = true;
      } catch (e) {
        // Retry later; dropping dirty here would lose the completed pass.
      } finally {
        if (!succeeded || generation !== this._metricsGeneration) {
          this._metricsDirty = true;
        }
      }
      return succeeded;
    })();
    this._persistPromise = run;
    let succeeded = false;
    try {
      succeeded = await run;
    } finally {
      if (this._persistPromise === run) this._persistPromise = null;
    }
    if (succeeded) {
      this._persistRetryCount = 0;
      if (this._metricsDirty) await this._persistMetrics(keep);
    } else if (
      this._metricsDirty &&
      !this._persistRetryTimer &&
      this._persistRetryCount < 3
    ) {
      const delay = Math.min(8000, 1000 * 2 ** this._persistRetryCount);
      this._persistRetryCount++;
      this._persistRetryTimer = setTimeout(() => {
        this._persistRetryTimer = null;
        this._persistMetrics(keep).catch(() => {});
      }, delay);
    }
  }

  _metricMatches(asset, metric) {
    return !!(
      metric &&
      metric.v === METRIC_VERSION &&
      Number(metric.modificationTime || 0) === Number(asset.modificationTime || 0) &&
      Number(metric.width || 0) === Number(asset.width || 0) &&
      Number(metric.height || 0) === Number(asset.height || 0)
    );
  }

  /** Metrics for one asset — instant when already analyzed. */
  async metricsFor(asset) {
    this._initPowerAdaptation();
    const store = await this._loadMetrics();
    if (this._metricMatches(asset, store[asset.id])) return store[asset.id];
    while (!this.appActive || this.memoryPaused || this.suspendCount > 0) {
      await sleep(400);
    }
    const m = await runMediaWork(
      () => analyzeAssetPixels(asset),
      'interactive'
    );
    store[asset.id] = {
      ...m,
      v: METRIC_VERSION,
      modificationTime: asset.modificationTime || 0,
      width: asset.width || 0,
      height: asset.height || 0,
    };
    this._metricsGeneration++;
    this._metricsDirty = true;
    // Throttled: this is called in a loop by the burst screen, and an
    // unconditional write there meant one full-store serialisation PER PHOTO.
    const now = new Date().getTime();
    if (now - (this._lastPersist || 0) > PERSIST_INTERVAL_MS) {
      this._persistMetrics().catch(() => {}); // best effort, retry on next pass
    }
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
    AppState.addEventListener('change', (state) => {
      this.appActive = state === 'active';
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
      const fp = await getAlbumFingerprint(albumId, mediaType, 'background');
      const stale =
        fp.assetCount !== cache.assetCount ||
        fp.latestModificationTime !== cache.latestModificationTime ||
        fp.newestId !== cache.newestId ||
        fp.oldestId !== cache.oldestId ||
        fp.edgeIds !== cache.edgeIds;
      return { cache, stale };
    } catch (e) {
      // Freshness is unknown. Never bless a deletion suggestion as current
      // when the MediaStore query that verifies it failed.
      return { cache, stale: true };
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

      const key = `${mediaType}/${albumId}`;
      if (this.current && this.current.key === key && !this.current.cancelled) {
        this.current.resolvers.push(resolve);
        if (onProgress) this.current.progressCbs.push(onProgress);
        return;
      }
      const queued = this.queue.find((j) => j.key === key && !j.cancelled);
      if (queued) {
        queued.resolvers.push(resolve);
        if (onProgress) queued.progressCbs.push(onProgress);
        return;
      }

      const job = {
        key,
        albumId,
        mediaType,
        resolvers: [resolve],
        progressCbs: onProgress ? [onProgress] : [],
        cancelled: false,
        pauseRequested: false,
        queuedForResume: false,
      };

      if (this.current) {
        this.current.pauseRequested = true;
        if (!this.current.queuedForResume) {
          this.current.queuedForResume = true;
          this.queue.push(this.current);
        }
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
    this.suspendCount += 1;
  }

  resume() {
    this.suspendCount = Math.max(0, this.suspendCount - 1);
  }

  async _next() {
    if (this.current || this.queue.length === 0) return;
    const job = this.queue.shift();
    this.current = job;
    job.pauseRequested = false;
    job.queuedForResume = false;
    await this._run(job);
  }

  async _run(job) {
    const { albumId, mediaType } = job;
    let finished = false;
    const startedAt = new Date().getTime();
    try {
      const store = await this._loadMetrics();
      // Only the newest MAX_HASHED are ever analysed, so only fetch that
      // many. This used to page the ENTIRE library and discard the tail.
      const scope = await getAssets(
        albumId,
        mediaType,
        MAX_HASHED,
        'background'
      );
      // Ids this pass depends on — eviction must not take them out from
      // under us (see _persistMetrics).
      const scopeIds = new Set(scope.map((a) => a.id));

      // Only photos we have NOT seen before need pixel work — everything
      // already in the global store is free.
      const targets =
        mediaType === 'photo'
          ? scope.filter((a) => !this._metricMatches(a, store[a.id]))
          : [];
      const total = targets.length;
      log(
        'analysis',
        `start ${albumId}/${mediaType} scope=${scope.length} todo=${total}`
          + ` concurrency=${CONCURRENCY} lowPower=${this.lowPower}`
      );
      this._emit({ running: true, albumId, mediaType, done: 0, total });

      let i = 0;
      let failed = 0;
      while (i < total) {
        if (job.cancelled) {
          await this._persistMetrics(scopeIds); // keep what we got
          log('analysis', `cancelled ${albumId} at ${i}/${total}`);
          job.resolvers.forEach((r) => r(null));
          finished = true;
          return;
        }
        if (job.pauseRequested) {
          await this._persistMetrics(scopeIds);
          log('analysis', `paused ${albumId} at ${i}/${total}`);
          finished = true; // re-queued by analyzeAlbum
          return;
        }
        while (
          (!this.appActive || this.memoryPaused || this.suspendCount > 0) &&
          !job.cancelled
        )
          await sleep(400);

        const chunk = chunkSizeFor(this.lowPower);
        const end = Math.min(i + chunk, total);
        // YIELD the JS thread after EVERY small batch — the analyzer must
        // never hold the thread long enough for touches to feel laggy.
        while (i < end && !job.cancelled && !job.pauseRequested) {
          if (!this.appActive || this.suspendCount > 0 || this.memoryPaused) {
            break;
          }
          const batchStart = new Date().getTime();
          const batch = targets.slice(i, Math.min(i + CONCURRENCY, end));
          await runMediaWork(
            () =>
              Promise.all(
                batch.map(async (a) => {
                  try {
                    const metric = await analyzeAssetPixels(a);
                    store[a.id] = {
                      ...metric,
                      v: METRIC_VERSION,
                      modificationTime: a.modificationTime || 0,
                      width: a.width || 0,
                      height: a.height || 0,
                    };
                  } catch (e) {
                    // Do not persist a permanent tombstone for a transient iCloud
                    // or decoder failure. The next pass must be allowed to retry.
                    delete store[a.id];
                    failed++;
                  }
                })
              ),
            'background'
          );
          this._metricsGeneration++;
          this._metricsDirty = true;
          i += batch.length;
          // THERMAL DUTY CYCLE, not just a yield. Decoding back-to-back keeps
          // every core busy for as long as the pass lasts, and on a large
          // library that is long enough to heat the device until it throttles
          // itself — at which point everything, including the UI, gets slower.
          // Hold each batch to a floor of TARGET_MS_PER_PHOTO and sleep the
          // remainder, so the CPU gets idle gaps to shed heat.
          const budget = TARGET_MS_PER_PHOTO * batch.length;
          const spent = new Date().getTime() - batchStart;
          if (spent > Math.max(250, budget * 3)) {
            log(
              'perf',
              `analysis-slow ${albumId}/${mediaType} batch=${batch.length} ` +
                `spent=${spent}ms budget=${budget}ms lowPower=${this.lowPower}`
            );
          }
          await sleep(Math.min(MAX_COOLDOWN_MS, Math.max(0, budget - spent)));
        }
        if (new Date().getTime() - this._lastPersist > PERSIST_INTERVAL_MS) {
          await this._persistMetrics(scopeIds); // INCREMENTAL: survive kills
        }
        this._emit({ done: i });
        job.progressCbs.forEach((cb) => cb(i, total));
        await yieldToUI();
      }
      await this._persistMetrics(scopeIds);

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
        // ONE batched size query for every candidate. This was a serial
        // getAssetSize per member — a native round trip each, awaited one
        // after another, at the tail end of an already expensive pass.
        const candidates = [];
        for (const members of buckets.values()) {
          if (members.length >= 2) candidates.push(...members);
        }
        const sizeMap =
          candidates.length > 0
            ? await getAssetSizes(candidates, { priority: 'background' })
            : {};
        for (const members of buckets.values()) {
          if (members.length < 2) continue;
          const bySize = new Map();
          for (const a of members) {
            const size = sizeMap[a.id] || 0;
            // Unknown is not a size. Grouping all failed lookups under zero
            // falsely promotes visually identical files to exact duplicates.
            if (!(size > 0)) continue;
            if (!bySize.has(size)) bySize.set(size, []);
            bySize.get(size).push(a.id);
          }
          for (const ids of bySize.values()) {
            if (ids.length >= 2) duplicates.push(ids);
          }
        }
      }

      const fp = await getAlbumFingerprint(albumId, mediaType, 'background');
      const result = {
        albumId,
        mediaType,
        assetCount: fp.assetCount,
        latestModificationTime: fp.latestModificationTime,
        newestId: fp.newestId,
        oldestId: fp.oldestId,
        edgeIds: fp.edgeIds,
        createdAt: new Date().getTime(),
        clusters,
        bursts,
        lowQuality,
        duplicates, // Array<string[]> — exact-duplicate id groups
      };
      if (failed === 0) {
        await AsyncStorage.setItem(
          this.cacheKey(albumId, mediaType),
          JSON.stringify(result)
        );
      } else {
        // A previous cache is now stale but has the same fingerprint as this
        // partial run. Remove it so the next visit retries failed assets.
        await AsyncStorage.removeItem(this.cacheKey(albumId, mediaType));
      }
      log(
        'analysis',
        `done ${albumId} in ${Math.round((new Date().getTime() - startedAt) / 1000)}s ` +
          `durationMs=${new Date().getTime() - startedAt} ` +
          `clusters=${clusters.length} low=${lowQuality.length} dupes=${duplicates.length} ` +
          `failed=${failed}`
      );
      job.resolvers.forEach((r) => r(result));
      finished = true;
    } catch (e) {
      log('analysis', `failed ${albumId}: ${(e && e.message) || e}`);
      job.resolvers.forEach((r) => r(null));
      finished = true;
    } finally {
      this.current = null;
      this._emit({
        running: false,
        albumId: null,
        mediaType: null,
        done: 0,
        total: 0,
      });
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
