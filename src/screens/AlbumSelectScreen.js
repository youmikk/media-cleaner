import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  InteractionManager,
  View,
  Text,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';
import AlbumPicker from '../components/AlbumPicker';
import TimePicker from '../components/TimePicker';
import GroupSizeStepper from '../components/GroupSizeStepper';
import StackedCards from '../components/StackedCards';
import AnalysisProgress from '../components/AnalysisProgress';
import analyzer from '../utils/chunkedAnalyzer';
import * as sessionManager from '../utils/sessionManager';
import * as reviewedStore from '../utils/reviewedStore';
import {
  getAlbums,
  getAssets,
  getAssetsPage,
  getAssetsByIds,
  getRangeThumbs,
  getAlbumFingerprint,
  getAlbumSummary,
  peekAlbumSummary,
  saveAlbumSummary,
  buildYearHistogram,
  getCachedAssetList,
  ALL_ALBUM_ID,
} from '../utils/albumHelpers';
import { log } from '../utils/logger';

// Preview pool cached per album. Three are shown; the extras exist so
// "random" order can show a DIFFERENT three without a rescan.
const THUMB_POOL = 12;
// Everything below the cached summary reads BIG AsyncStorage values and
// JSON.parses them on the JS thread: the saved session order (up to 20k
// ids), the reviewed set (another 20k) and the analysis cache (megabytes).
// Doing that the instant the tab appears blocks the very thread the three
// preview images need to attach and decode — on Android the cards sat
// blank for seconds. Let the cached summary paint first, then catch up.
const DEFER_MS = 450;

/**
 * Album-select entry for BOTH the Photos and the Videos tab (`mediaType`).
 * One component on purpose: the two tabs used to be separate screens with
 * separate control rows, so they offered different options and centred their
 * card stack at different heights.
 *
 * Renders INSTANTLY from a cached album summary (count, preview thumbs, time
 * histogram) — the album is only re-scanned when its fingerprint (count +
 * latest modification) changed. Stale analysis refreshes SILENTLY and
 * incrementally in the background (no prompt: old photos are already in the
 * global metric store, only new ones get decoded).
 */
export default function AlbumSelectScreen({
  navigation,
  mediaType = 'photo',
  cleaningRoute = 'Cleaning',
}) {
  const { colors, t, settings, setSetting } = useSettings();
  const { width } = useWindowDimensions();
  const isVideo = mediaType === 'video';
  const groupSizeKey = isVideo ? 'videoGroupSize' : 'groupSize';
  const groupSize = settings[groupSizeKey] || 5;
  const reviewScope = useMemo(() => reviewedStore.scopeFor(mediaType), [mediaType]);

  const [albums, setAlbums] = useState([]);
  const [albumId, setAlbumId] = useState(ALL_ALBUM_ID);
  const [summary, setSummary] = useState(
    () => peekAlbumSummary(ALL_ALBUM_ID, mediaType)?.summary || null
  ); // {count, thumbs, years}
  const [timeFilter, setTimeFilter] = useState(null);
  const [analysisState, setAnalysisState] = useState(null);
  // When an unfinished session exists for this album, the three preview
  // cards show the CURRENT GROUP's items (and tapping resumes).
  const [sessionPreview, setSessionPreview] = useState(null); // {thumbs} | null
  // Preview for the picked year/month — one scoped media-store query.
  const [rangeThumbs, setRangeThumbs] = useState(null);
  const [progressByAlbum, setProgressByAlbum] = useState({});
  const [totalCounts, setTotalCounts] = useState({});
  const focusStartedAt = useRef(0);
  const firstThumbLogged = useRef(false);

  useFocusEffect(
    useCallback(() => {
      const startedAt = Date.now();
      focusStartedAt.current = startedAt;
      firstThumbLogged.current = false;
      log('perf', `home focus-start screen=${mediaType}s`);
      const frame = requestAnimationFrame(() => {
        log('perf', `home first-frame ${Date.now() - startedAt}ms screen=${mediaType}s`);
      });
      const interactive = InteractionManager.runAfterInteractions(() => {
        log(
          'perf',
          `home first-interactive ${Date.now() - startedAt}ms screen=${mediaType}s`
        );
      });
      return () => {
        cancelAnimationFrame(frame);
        interactive.cancel();
      };
    }, [mediaType])
  );

  const albumTitle = useMemo(() => {
    const a = albums.find((x) => x.id === albumId);
    return a ? a.title : '';
  }, [albums, albumId]);

  // Per-album cleaning progress for the picker. ONE batched storage read for
  // the whole list: a phone can have 150+ albums, and asking the reviewed
  // store for them one at a time was 150 getItem calls (plus 150 JSON
  // parses) on the JS thread every time this tab came into focus.
  useEffect(() => {
    if (albums.length === 0) return undefined;
    let alive = true;
    (async () => {
      const allEntry = albums.find((a) => a.id === ALL_ALBUM_ID);
      let allTotal = allEntry ? allEntry.assetCount : 0;
      if (allEntry && !allTotal) {
        allTotal = (await getAlbumFingerprint(ALL_ALBUM_ID, mediaType)).assetCount;
        if (!alive) return;
      }
      // Prime the global ledger and every album ledger in one bounded batch.
      // Progress is shared across overlapping collections, but the album
      // ledger also contains ids reviewed before an asset was deleted.
      await reviewedStore.primeReviewed([
        reviewScope,
        ...albums.map((album) => reviewedStore.albumScopeFor(mediaType, album.id)),
      ]);
      if (!alive) return;
      const out = {};
      const totals = {};
      for (const album of albums) {
        const total = album.id === ALL_ALBUM_ID ? allTotal : album.assetCount;
        if (total !== undefined && total !== null) totals[album.id] = total;
      }
      setTotalCounts(totals);
      setProgressByAlbum(out);

      // Resolve every category in the background. This is deliberately
      // throttled: opening the picker should never launch one MediaStore
      // cursor per album at once, but every row should eventually show the
      // same progress for an asset handled from any overlapping view.
      const pending = albums.filter((album) => (totals[album.id] || 0) > 0);
      const CONCURRENCY = 2;
      for (let i = 0; i < pending.length && alive; i += CONCURRENCY) {
        const batch = pending.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (album) => {
            try {
              const assets =
                (await getCachedAssetList(album.id, mediaType)) ||
                (await getAssets(album.id, mediaType));
              if (!alive) return null;
              reviewedStore.rememberAlbumMembership(mediaType, album.id, assets);
              return [
                album.id,
                reviewedStore.getAlbumProgressSync(mediaType, album.id, assets),
              ];
            } catch (e) {
              return null;
            }
          })
        );
        if (!alive) return;
        setProgressByAlbum((current) => {
          const next = { ...current };
          for (const result of results) {
            if (result) next[result[0]] = result[1];
          }
          return next;
        });
        // Yield one frame between bridge batches so the picker and cards stay
        // responsive on large libraries.
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [albums, mediaType, reviewScope]);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      // Album names are secondary to the first paint. Android's album query
      // can compete with the first thumbnail query on the MediaStore bridge.
      const timer = setTimeout(
        () =>
          getAlbums(mediaType, t(isVideo ? 'all_videos' : 'all_photos'))
            .then((list) => alive && setAlbums(list))
            .catch(() => {}),
        350
      );
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }, [t, mediaType, isVideo])
  );

  // Follow the cleaning progress: show the current group's items on the
  // three cards whenever an unfinished session matches this album.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const timer = setTimeout(() => {
        (async () => {
          try {
            // The cleaning-order setting can be flipped from the Profile tab
            // while this screen is mounted. A paused session froze its queue
            // under the OLD mode, so honour the new setting by dropping it —
            // otherwise the preview and the resume both ignore the change.
            await sessionManager.dropSessionIfOrderChanged(
              settings.order,
              mediaType
            );
            const pending = await sessionManager.getPendingSession(mediaType);
            if (
              !pending ||
              pending.type !== mediaType ||
              pending.albumId !== albumId
            ) {
              if (alive) setSessionPreview(null);
              return;
            }
            const order = (await sessionManager.getOrder(mediaType)) || [];
            const gs = pending.groupSize || 5;
            // SAME rule as resume: confirmed (reviewed) ids are dropped, the
            // interrupted group is the first gs unreviewed ids — the cards
            // show exactly what re-entering will show.
            const reviewed = await reviewedStore.getReviewed(
              reviewScope
            );
            const ids = order.filter((id) => !reviewed.has(id)).slice(0, gs);
            if (ids.length === 0) {
              if (alive) setSessionPreview(null);
              return;
            }
            const assets = await getAssetsByIds(ids);
            const thumbs = [...assets]
              .sort((a, b) => (b.creationTime || 0) - (a.creationTime || 0))
              .slice(0, 3)
              .map((a) => ({ id: a.id, uri: a.uri }));
            if (alive) setSessionPreview(thumbs.length ? { thumbs } : null);
          } catch (e) {
            if (alive) setSessionPreview(null);
          }
        })();
      }, DEFER_MS);
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }, [albumId, settings.order, mediaType, reviewScope])
  );

  // Exact progress for the album currently shown. Reviewed ids are global,
  // so intersect them with this album's ids; this is what keeps All Photos,
  // QQ, Camera and every other overlapping collection in sync.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const timer = setTimeout(async () => {
        try {
          const albumScope = reviewedStore.albumScopeFor(mediaType, albumId);
          await reviewedStore.primeReviewed([reviewScope, albumScope]);
          if (!alive) return;
          const assets =
            (await getCachedAssetList(albumId, mediaType)) ||
            (await getAssets(albumId, mediaType));
          if (!alive) return;
          reviewedStore.rememberAlbumMembership(mediaType, albumId, assets);
          const progress = reviewedStore.getAlbumProgressSync(
            mediaType,
            albumId,
            assets
          );
          setProgressByAlbum((p) => ({ ...p, [albumId]: progress }));
        } catch (e) {
          // Progress is best-effort; the album itself remains usable.
        }
      }, DEFER_MS);
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }, [albumId, mediaType, reviewScope, summary?.count, totalCounts])
  );

  // Time-scoped preview. createdAfter/createdBefore let the media store do
  // the filtering, so picking a month is one query instead of paging the
  // whole library — that walk is why the cards used to sit empty for
  // seconds after switching the time.
  useEffect(() => {
    if (!timeFilter) {
      setRangeThumbs(null);
      return undefined;
    }
    let alive = true;
    setRangeThumbs([]); // clear immediately: never show another range's items
    getRangeThumbs(albumId, mediaType, timeFilter, 3)
      .then((list) => alive && setRangeThumbs(list))
      .catch(() => alive && setRangeThumbs([]));
    return () => {
      alive = false;
    };
  }, [albumId, timeFilter, mediaType]);

  // Summary: cached-first, rescan ONLY when the album actually changed.
  // Runs on EVERY focus (not just album switches): coming back from a
  // cleaning session re-checks the fingerprint, so the three preview
  // thumbs always reflect the album's latest state. Unchanged album =
  // zero scanning, still instant.
  useFocusEffect(
    useCallback(() => {
    let alive = true;
    (async () => {
      try {
        const cached = await getAlbumSummary(albumId, mediaType);
        if (alive && cached) {
          setSummary(cached.summary);
          if (!firstThumbLogged.current && cached.summary?.thumbs?.length) {
            firstThumbLogged.current = true;
            log(
              'perf',
              `home first-thumbnails ${Date.now() - focusStartedAt.current}ms ` +
                `screen=${mediaType}s source=cache count=${cached.summary.thumbs.length}`
            );
          }
        }
        else if (alive && !cached) setSummary(null);

        // Cached content is already paintable. Give the first frame and
        // thumbnails a short head start before any freshness work.
        if (cached) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          if (!alive) return;
        }

        // On a first visit there is no summary to show, so fetch the
        // fingerprint and first page together. The first page can paint while
        // the fingerprint decides whether a full refresh is needed.
        const fpPromise = getAlbumFingerprint(albumId, mediaType);
        const firstPagePromise = cached
          ? null
          : getAssetsPage(albumId, mediaType);
        const fp = await fpPromise;
        if (!alive) return;
        if (
          cached &&
          cached.fingerprint &&
          cached.fingerprint.assetCount === fp.assetCount &&
          cached.fingerprint.latestModificationTime === fp.latestModificationTime &&
          cached.fingerprint.newestId === fp.newestId &&
          cached.fingerprint.oldestId === fp.oldestId &&
          cached.fingerprint.edgeIds === fp.edgeIds
        ) {
          return; // unchanged — ZERO scanning this visit
        }

        // Album changed (or first visit): stream pages, show early.
        // `all` is appended IN PLACE. `all = [...all, ...page.assets]` meant
        // re-copying everything accumulated so far on each of ~66 pages —
        // roughly 440k element copies on a 13k-photo library, on the JS
        // thread, right after returning from a cleaning session (a deletion
        // always changes the fingerprint, so this path always runs).
        const all = [];
        let after;
        let hasNext = true;
        let first = true;
        if (firstPagePromise) {
          const page = await firstPagePromise;
          if (!alive) return;
          for (const a of page.assets) all.push(a);
          hasNext = page.hasNext;
          after = page.endCursor;
          setSummary((s) => ({
            count: fp.assetCount || all.length,
            thumbs: all.slice(0, THUMB_POOL).map((a) => ({ id: a.id, uri: a.uri })),
            years: s ? s.years : [],
          }));
          if (!firstThumbLogged.current && all.length > 0) {
            firstThumbLogged.current = true;
            log(
              'perf',
              `home first-thumbnails ${Date.now() - focusStartedAt.current}ms ` +
                `screen=${mediaType}s source=media-library count=${Math.min(3, all.length)}`
            );
          }
          first = false;
        }
        while (hasNext && all.length < 20000) {
          const page = await getAssetsPage(albumId, mediaType, after);
          if (!alive) return;
          for (const a of page.assets) all.push(a);
          hasNext = page.hasNext;
          after = page.endCursor;
          if (first) {
            setSummary((s) => ({
              count: fp.assetCount || all.length,
              thumbs: all.slice(0, THUMB_POOL).map((a) => ({ id: a.id, uri: a.uri })),
              years: s ? s.years : [],
            }));
            if (!firstThumbLogged.current && all.length > 0) {
              firstThumbLogged.current = true;
              log(
                'perf',
                `home first-thumbnails ${Date.now() - focusStartedAt.current}ms ` +
                  `screen=${mediaType}s source=media-library count=${Math.min(3, all.length)}`
              );
            }
            first = false;
          }
        }
        const fresh = {
          // REAL total from the media store — never the scan cap.
          count: fp.assetCount || all.length,
          thumbs: all.slice(0, THUMB_POOL).map((a) => ({ id: a.id, uri: a.uri })),
          years: buildYearHistogram(all),
        };
        if (!alive) return;
        setSummary(fresh);
        saveAlbumSummary(albumId, { fingerprint: fp, summary: fresh }, mediaType);
      } catch (e) {
        if (alive) setSummary({ count: 0, thumbs: [], years: [] });
      }
    })();
    return () => {
      alive = false;
    };
    }, [albumId, mediaType])
  );

  useEffect(() => analyzer.subscribe(setAnalysisState), []);

  // Missing/stale analysis: SILENT, delayed, incremental background refresh.
  // checkCache() itself is the expensive part — it JSON.parses the whole
  // analysis cache — so even the CHECK waits for the cards to paint.
  // Videos have no pixel-analysis pipeline, so this is photos only.
  useEffect(() => {
    if (isVideo || !settings.similarDetection) return undefined;
    let alive = true;
    let startTimer;
    const checkTimer = setTimeout(() => {
      (async () => {
        const { cache, stale } = await analyzer.checkCache(albumId, 'photo');
        if (!alive) return;
        if (!cache || stale) {
          startTimer = setTimeout(() => {
            if (alive)
              analyzer.analyzeAlbum(albumId, { mediaType: 'photo', force: true });
          }, 2500);
        }
      })();
    }, DEFER_MS);
    return () => {
      alive = false;
      clearTimeout(checkTimer);
      if (startTimer) clearTimeout(startTimer);
    };
  }, [albumId, settings.similarDetection, isVideo]);

  // Scoped count straight from the cached histogram — no asset scanning.
  const filteredCount = useMemo(() => {
    if (!summary) return 0;
    if (!timeFilter) return summary.count;
    const yearEntry = summary.years.find((y) => y.year === timeFilter.year);
    if (!yearEntry) return 0;
    if (timeFilter.month === null || timeFilter.month === undefined)
      return yearEntry.count;
    const m = yearEntry.months.find(([mm]) => mm === timeFilter.month);
    return m ? m[1] : 0;
  }, [summary, timeFilter]);

  const startCleaning = async () => {
    if (filteredCount === 0) return;
    // Check the pending session DIRECTLY (not via sessionPreview state) so
    // a quick tap right after opening the app still resumes the same group
    // with the same random order.
    let resume = false;
    if (!timeFilter) {
      try {
        // Same invalidation as the preview effect — a session built for the
        // other order mode must not be resumed just because the tap beat the
        // effect to it.
        await sessionManager.dropSessionIfOrderChanged(settings.order, mediaType);
        const pending = await sessionManager.getPendingSession(mediaType);
        resume = !!(
          pending &&
          pending.type === mediaType &&
          pending.albumId === albumId
        );
      } catch (e) {
        resume = false;
      }
    }
    const timeRange = timeFilter
      ? { start: timeFilter.start, end: timeFilter.end }
      : null;
    // Cleaning decisions feed one shared progress ledger, but the pool that
    // decides when to auto-reset is independent per album/time scope.
    reviewedStore.activateRound(mediaType, albumId, timeRange);
    navigation.navigate(cleaningRoute, {
      albumId,
      albumTitle: timeFilter ? `${albumTitle} · ${timeFilter.label}` : albumTitle,
      mediaType,
      groupSize,
      timeRange,
      resume,
    });
  };

  // Preview precedence: an explicit time scope wins, then the paused
  // session's real group, then a plain album preview.
  //
  // The plain preview follows the ORDER setting: date mode shows the newest
  // three, random mode picks three out of the cached pool. Without that the
  // cards looked identical in both modes and switching the setting seemed
  // to do nothing at all.
  const poolThumbs = summary ? summary.thumbs || [] : [];
  const previewThumbs = useMemo(() => {
    if (settings.order !== 'random' || poolThumbs.length <= 3) {
      return poolThumbs.slice(0, 3);
    }
    const pool = [...poolThumbs];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, 3);
    // Re-picked when the album, the pool or the mode changes — NOT on every
    // render, or the cards would reshuffle while the user looks at them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumId, settings.order, poolThumbs.length, poolThumbs[0]?.id]);

  const thumbs = timeFilter
    ? rangeThumbs || []
    : sessionPreview
      ? sessionPreview.thumbs
      : previewThumbs;
  // Front card is the hero; the fan needs ~1.4x this much width around it.
  const cardW = Math.min(Math.round(width * 0.58), 250);

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: colors.background }]}>
      <Text style={[styles.header, { color: colors.text }]}>
        {t(isVideo ? 'clean_videos' : 'clean_photos')}
      </Text>

      <View style={styles.controls}>
        <AlbumPicker
          albums={albums}
          selected={albumId}
          progressByAlbum={progressByAlbum}
          totalCounts={totalCounts}
          onSelect={(a) => {
            if (a.id !== albumId) setSummary(null); // don't show stale thumbs
            setAlbumId(a.id);
            setTimeFilter(null);
          }}
        />
        <TimePicker
          years={summary ? summary.years : []}
          value={timeFilter}
          onSelect={setTimeFilter}
        />
        <GroupSizeStepper
          value={groupSize}
          onChange={(v) => setSetting(groupSizeKey, v)}
        />
      </View>

      <View style={styles.centerArea}>
        <StackedCards
          items={thumbs}
          cardWidth={cardW}
          isVideo={isVideo}
          onPress={startCleaning}
        />
        <Text style={[styles.count, { color: colors.subtext }]}>
          {filteredCount === 0
            ? t(isVideo ? 'no_videos' : 'no_photos')
            : t(isVideo ? 'video_count' : 'photo_count', { count: filteredCount })}
        </Text>
        {filteredCount > 0 && (
          <Text style={[styles.hint, { color: colors.subtext }]}>
            {t('start_hint')}
          </Text>
        )}
      </View>

      <AnalysisProgress
        state={analysisState}
        mediaType={mediaType}
        onCancel={() => analyzer.cancel(albumId)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16 },
  header: { fontSize: 30, fontWeight: '800', marginTop: 12, marginBottom: 14 },
  controls: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'center',
    // Three controls of identical height (see pickerButtonStyle). They wrap
    // rather than squeeze on narrow screens; the card area below simply gets
    // whatever height is left, so both tabs still agree with each other.
    flexWrap: 'wrap',
    gap: 8,
  },
  centerArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 90,
    marginTop: 4,
  },
  count: { marginTop: 26, fontSize: 15, fontWeight: '700' },
  hint: { marginTop: 6, fontSize: 12, textAlign: 'center' },
});
