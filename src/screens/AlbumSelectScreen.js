import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';
import AlbumPicker from '../components/AlbumPicker';
import TimePicker from '../components/TimePicker';
import AnalysisProgress from '../components/AnalysisProgress';
import analyzer from '../utils/chunkedAnalyzer';
import * as sessionManager from '../utils/sessionManager';
import * as reviewedStore from '../utils/reviewedStore';
import {
  getAlbums,
  getAssetsPage,
  getAssetsByIds,
  getAlbumFingerprint,
  getAlbumSummary,
  saveAlbumSummary,
  buildYearHistogram,
  ALL_ALBUM_ID,
} from '../utils/albumHelpers';

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
  const [summary, setSummary] = useState(null); // {count, thumbs, years}
  const [timeFilter, setTimeFilter] = useState(null);
  const [analysisState, setAnalysisState] = useState(null);
  // When an unfinished photo session exists for this album, the three
  // preview cards show the CURRENT GROUP's photos (and tapping resumes).
  const [sessionPreview, setSessionPreview] = useState(null); // {thumbs} | null

  const albumTitle = useMemo(() => {
    const a = albums.find((x) => x.id === albumId);
    return a ? a.title : '';
  }, [albums, albumId]);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      getAlbums('photo', t('all_photos'))
        .then((list) => alive && setAlbums(list))
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, [t])
  );

  // Follow the cleaning progress: show the current group's photos on the
  // three cards whenever an unfinished session matches this album.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        try {
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
      return () => {
        alive = false;
      };
    }, [albumId])
  );

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
        if (alive && cached) setSummary(cached.summary);
        else if (alive && !cached) setSummary(null);

        const fp = await getAlbumFingerprint(albumId, 'photo');
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
        let all = [];
        let after;
        let hasNext = true;
        let first = true;
        while (hasNext && all.length < 20000) {
          const page = await getAssetsPage(albumId, 'photo', after);
          if (!alive) return;
          all = [...all, ...page.assets];
          hasNext = page.hasNext;
          after = page.endCursor;
          if (first) {
            setSummary((s) => ({
              count: fp.assetCount || all.length,
              thumbs: all.slice(0, 3).map((a) => ({ id: a.id, uri: a.uri })),
              years: s ? s.years : [],
            }));
            first = false;
          }
        }
        const fresh = {
          // REAL total from the media store — never the scan cap.
          count: fp.assetCount || all.length,
          thumbs: all.slice(0, 3).map((a) => ({ id: a.id, uri: a.uri })),
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
  useEffect(() => {
    if (!settings.similarDetection) return;
    let alive = true;
    let timer;
    (async () => {
      const { cache, stale } = await analyzer.checkCache(albumId, 'photo');
      if (!alive) return;
      if (!cache || stale) {
        timer = setTimeout(() => {
          if (alive)
            analyzer.analyzeAlbum(albumId, { mediaType: 'photo', force: true });
        }, 2500);
      }
    })();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
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

  const thumbs = sessionPreview
    ? sessionPreview.thumbs
    : summary
    ? summary.thumbs
    : [];
  const cardW = (width - 16 * 2 - 12 * 2) / 3;
  const cardHeights = [cardW * 1.5, cardW * 1.9, cardW * 1.5];

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: colors.background }]}>
      <Text style={[styles.header, { color: colors.text }]}>
        {t('clean_photos')}
      </Text>

      <View style={styles.controls}>
        <AlbumPicker
          albums={albums}
          selected={albumId}
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
        <View style={styles.cards}>
          {[0, 1, 2].map((i) => (
            <Pressable
              key={i}
              onPress={startCleaning}
              style={[
                styles.card,
                {
                  width: cardW,
                  height: cardHeights[i],
                  backgroundColor: colors.card,
                },
              ]}
            >
              {thumbs[i] ? (
                <Image
                  source={{ uri: thumbs[i].uri }}
                  style={styles.cardImage}
                  cachePolicy="memory-disk"
                  recyclingKey={thumbs[i].id}
                />
              ) : (
                <View style={styles.cardEmpty}>
                  <Ionicons name="image-outline" size={28} color={colors.subtext} />
                </View>
              )}
            </Pressable>
          ))}
        </View>
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
  },
  centerArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 90,
  },
  cards: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  card: {
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  cardImage: { width: '100%', height: '100%' },
  cardEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  count: { marginTop: 18, fontSize: 15, fontWeight: '700' },
  hint: { marginTop: 6, fontSize: 12 },
});
