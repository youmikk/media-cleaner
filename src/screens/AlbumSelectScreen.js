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
import StackedCards from '../components/StackedCards';
import AnalysisProgress from '../components/AnalysisProgress';
import analyzer from '../utils/chunkedAnalyzer';
import * as sessionManager from '../utils/sessionManager';
import * as reviewedStore from '../utils/reviewedStore';
import {
  getAlbums,
  getAssetsPage,
  getAssetsByIds,
  getRangeThumbs,
  getAlbumFingerprint,
  getAlbumSummary,
  peekAlbumSummary,
  saveAlbumSummary,
          buildYearHistogram,
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
 * Photos tab entry. Renders INSTANTLY from a cached album summary (count,
 * preview thumbs, time histogram) — the album is only re-scanned when its
 * fingerprint (count + latest modification) changed. Stale analysis
 * refreshes SILENTLY and incrementally in the background (no prompt: old
 * photos are already in the global metric store, only new ones get decoded).
 */
export default function AlbumSelectScreen({ navigation }) {
  const { colors, t, settings } = useSettings();
  const { width } = useWindowDimensions();

  const [albums, setAlbums] = useState([]);
  const [albumId, setAlbumId] = useState(ALL_ALBUM_ID);
  const [summary, setSummary] = useState(
    () => peekAlbumSummary(ALL_ALBUM_ID)?.summary || null
  ); // {count, thumbs, years}
  const [timeFilter, setTimeFilter] = useState(null);
  const [analysisState, setAnalysisState] = useState(null);
  // When an unfinished photo session exists for this album, the three
  // preview cards show the CURRENT GROUP's photos (and tapping resumes).
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
      log('perf', 'home focus-start screen=photos');
      const frame = requestAnimationFrame(() => {
        log('perf', `home first-frame ${Date.now() - startedAt}ms screen=photos`);
      });
      const interactive = InteractionManager.runAfterInteractions(() => {
        log(
          'perf',
          `home first-interactive ${Date.now() - startedAt}ms screen=photos`
        );
      });
      return () => {
        cancelAnimationFrame(frame);
        interactive.cancel();
      };
    }, [])
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
        allTotal = (await getAlbumFingerprint(ALL_ALBUM_ID, 'photo')).assetCount;
        if (!alive) return;
      }
      await reviewedStore.primeReviewed(albums.map((a) => a.id));
      if (!alive) return;
      const out = {};
      const totals = {};
      for (const album of albums) {
        const total = album.id === ALL_ALBUM_ID ? allTotal : album.assetCount;
        if (total !== undefined && total !== null) totals[album.id] = total;
        if (!total) continue;
        out[album.id] = reviewedStore.getProgressSync(album.id, total);
      }
      setTotalCounts(totals);
      setProgressByAlbum(out);
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [albums]);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      // Album names are secondary to the first paint. Android's album query
      // can compete with the first thumbnail query on the MediaStore bridge.
      const timer = setTimeout(() => getAlbums('photo', t('all_photos'))
        .then((list) => alive && setAlbums(list))
        .catch(() => {}), 350);
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }, [t])
  );

  // Follow the cleaning progress: show the current group's photos on the
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
            await sessionManager.dropSessionIfOrderChanged(settings.order);
            const pending = await sessionManager.getPendingSession();
            if (
              !pending ||
              pending.type !== 'photo' ||
              pending.albumId !== albumId
            ) {
              if (alive) setSessionPreview(null);
              return;
            }
            const order = (await sessionManager.getOrder()) || [];
            const gs = pending.groupSize || 5;
            // SAME rule as resume: confirmed (reviewed) ids are dropped, the
            // interrupted group is the first gs unreviewed ids — the cards
            // show exactly what re-entering will show.
            const reviewed = await reviewedStore.getReviewed(pending.albumId);
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
    }, [albumId, settings.order])
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
    setRangeThumbs([]); // clear immediately: never show another range's photos
    getRangeThumbs(albumId, 'photo', timeFilter, 3)
      .then((list) => alive && setRangeThumbs(list))
      .catch(() => alive && setRangeThumbs([]));
    return () => {
      alive = false;
    };
  }, [albumId, timeFilter]);

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
        const cached = await getAlbumSummary(albumId);
        if (alive && cached) {
          setSummary(cached.summary);
          if (!firstThumbLogged.current && cached.summary?.thumbs?.length) {
            firstThumbLogged.current = true;
            log(
              'perf',
              `home first-thumbnails ${Date.now() - focusStartedAt.current}ms ` +
                `screen=photos source=cache count=${cached.summary.thumbs.length}`
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
        const fpPromise = getAlbumFingerprint(albumId, 'photo');
        const firstPagePromise = cached
          ? null
          : getAssetsPage(albumId, 'photo');
        const fp = await fpPromise;
        if (!alive) return;
        if (
          cached &&
          cached.fingerprint &&
          cached.fingerprint.assetCount === fp.assetCount &&
          cached.fingerprint.latestModificationTime === fp.latestModificationTime
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
                `screen=photos source=media-library count=${Math.min(3, all.length)}`
            );
          }
          first = false;
        }
        while (hasNext && all.length < 20000) {
          const page = await getAssetsPage(albumId, 'photo', after);
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
                  `screen=photos source=media-library count=${Math.min(3, all.length)}`
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
        saveAlbumSummary(albumId, { fingerprint: fp, summary: fresh });
      } catch (e) {
        if (alive) setSummary({ count: 0, thumbs: [], years: [] });
      }
    })();
    return () => {
      alive = false;
    };
    }, [albumId])
  );

  useEffect(() => analyzer.subscribe(setAnalysisState), []);

  // Missing/stale analysis: SILENT, delayed, incremental background refresh.
  // checkCache() itself is the expensive part — it JSON.parses the whole
  // analysis cache — so even the CHECK waits for the cards to paint.
  useEffect(() => {
    if (!settings.similarDetection) return undefined;
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
  }, [albumId, settings.similarDetection]);

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
        await sessionManager.dropSessionIfOrderChanged(settings.order);
        const pending = await sessionManager.getPendingSession();
        resume = !!(
          pending &&
          pending.type === 'photo' &&
          pending.albumId === albumId
        );
      } catch (e) {
        resume = false;
      }
    }
    navigation.navigate('Cleaning', {
      albumId,
      albumTitle: timeFilter ? `${albumTitle} · ${timeFilter.label}` : albumTitle,
      timeRange: timeFilter
        ? { start: timeFilter.start, end: timeFilter.end }
        : null,
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
        {t('clean_photos')}
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
      </View>

      <View style={styles.centerArea}>
        <StackedCards
          items={thumbs}
          cardWidth={cardW}
          onPress={startCleaning}
        />
        <Text style={[styles.count, { color: colors.subtext }]}>
          {filteredCount === 0
            ? t('no_photos')
            : t('photo_count', { count: filteredCount })}
        </Text>
        {filteredCount > 0 && (
          <Text style={[styles.hint, { color: colors.subtext }]}>
            {t('start_hint')}
          </Text>
        )}
      </View>

      <AnalysisProgress
        state={analysisState}
        mediaType="photo"
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
    gap: 10,
    // Kept in sync with AlbumSelectBase's CONTROLS_HEIGHT so the photo and
    // video tabs centre their card stack at the same height.
    minHeight: 46,
  },
  centerArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 90,
  },
  count: { marginTop: 26, fontSize: 15, fontWeight: '700' },
  hint: { marginTop: 6, fontSize: 12 },
});
