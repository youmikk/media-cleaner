import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  InteractionManager,
  View,
  Text,
  Pressable,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';
import AlbumPicker from '../components/AlbumPicker';
import StackedCards from '../components/StackedCards';
import AnalysisProgress from '../components/AnalysisProgress';
import CacheStalePrompt from '../components/CacheStalePrompt';
import analyzer from '../utils/chunkedAnalyzer';
import * as reviewedStore from '../utils/reviewedStore';
import {
  getAlbums,
  getAssetsPage,
  getCachedPreview,
  saveCachedPreview,
  getAlbumFingerprint,
  ALL_ALBUM_ID,
} from '../utils/albumHelpers';
import { log } from '../utils/logger';

const MIN_GROUP = 2;
const MAX_GROUP = 20;
const DEFAULT_GROUP = 5;

/**
 * Shared album-select layout for Photos and Videos tabs:
 * album picker (left) · group-size stepper (right) · three thumbnail cards
 * (middle taller). Kicks off / reuses chunked analysis for the selected album.
 */
export default function AlbumSelectBase({ mediaType, cleaningRoute, navigation }) {
  const { colors, t, settings } = useSettings();
  const { width } = useWindowDimensions();
  const isVideo = mediaType === 'video';

  const [albums, setAlbums] = useState([]);
  const [albumId, setAlbumId] = useState(ALL_ALBUM_ID);
  const [groupSize, setGroupSize] = useState(DEFAULT_GROUP);
  const [thumbs, setThumbs] = useState([]);
  const [analysisState, setAnalysisState] = useState(null);
  const [progressByAlbum, setProgressByAlbum] = useState({});
  const [stalePrompt, setStalePrompt] = useState(false);
  const focusStartedAt = useRef(0);
  const firstThumbLogged = useRef(false);

  useFocusEffect(
    useCallback(() => {
      const startedAt = Date.now();
      focusStartedAt.current = startedAt;
      firstThumbLogged.current = false;
      log(
        'perf',
        `home focus-start screen=${isVideo ? 'videos' : 'photos-base'}`
      );
      const frame = requestAnimationFrame(() => {
        log(
          'perf',
          `home first-frame ${Date.now() - startedAt}ms ` +
            `screen=${isVideo ? 'videos' : 'photos-base'}`
        );
      });
      const interactive = InteractionManager.runAfterInteractions(() => {
        log(
          'perf',
          `home first-interactive ${Date.now() - startedAt}ms ` +
            `screen=${isVideo ? 'videos' : 'photos-base'}`
        );
      });
      return () => {
        cancelAnimationFrame(frame);
        interactive.cancel();
      };
    }, [isVideo])
  );

  // Per-album cleaning progress for the picker — ONE batched storage read.
  // See the same effect in AlbumSelectScreen: a per-album getItem meant 150+
  // storage round trips on every focus, and BOTH tabs stay mounted.
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
      await reviewedStore.primeReviewed(albums.map((a) => a.id));
      if (!alive) return;
      const out = {};
      for (const album of albums) {
        const total = album.id === ALL_ALBUM_ID ? allTotal : album.assetCount;
        if (!total) continue;
        out[album.id] = reviewedStore.getProgressSync(album.id, total);
      }
      setProgressByAlbum(out);
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [albums, mediaType]);

  const albumTitle = useMemo(() => {
    const a = albums.find((x) => x.id === albumId);
    return a ? a.title : '';
  }, [albums, albumId]);

  // Load album list on focus (library may have changed).
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const timer = setTimeout(() => getAlbums(
        mediaType,
        t(isVideo ? 'all_videos' : 'all_photos')
      )
        .then((list) => alive && setAlbums(list))
        .catch(() => {}), 350);
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }, [mediaType, t, isVideo])
  );

  // Thumbnails for the three preview cards. ONE page — this used to page the
  // whole library (up to 20k assets, 200 at a time) just to keep the first
  // three, which is why the cards took seconds to appear.
  useEffect(() => {
    let alive = true;
    (async () => {
      const cached = await getCachedPreview(albumId, mediaType);
      if (!alive) return;
      if (cached?.length) {
        setThumbs(cached);
        if (!firstThumbLogged.current) {
          firstThumbLogged.current = true;
          log(
            'perf',
            `home first-thumbnails ${Date.now() - focusStartedAt.current}ms ` +
              `screen=${isVideo ? 'videos' : 'photos-base'} source=cache count=${cached.length}`
          );
        }
        // Let the cached cards paint before asking MediaStore for freshness.
        await new Promise((resolve) => setTimeout(resolve, 350));
        if (!alive) return;
      }
      const page = await getAssetsPage(albumId, mediaType);
      if (!alive) return;
      const first = page.assets.slice(0, 3);
      saveCachedPreview(albumId, mediaType, first);
      setThumbs(first);
      if (!firstThumbLogged.current && first.length > 0) {
        firstThumbLogged.current = true;
        log(
          'perf',
          `home first-thumbnails ${Date.now() - focusStartedAt.current}ms ` +
            `screen=${isVideo ? 'videos' : 'photos-base'} source=media-library ` +
            `count=${first.length}`
        );
      }
    })().catch(() => alive && setThumbs([]));
    return () => {
      alive = false;
    };
  }, [albumId, mediaType]);

  // Global analyzer state for the progress overlay.
  useEffect(() => analyzer.subscribe(setAnalysisState), []);

  // Kick off analysis when the album changes and the cache is missing/stale.
  useEffect(() => {
    if (isVideo || !settings.similarDetection) return;
    let alive = true;
    const timer = setTimeout(() => {
      (async () => {
        const { cache, stale } = await analyzer.checkCache(albumId, mediaType);
        if (!alive) return;
        if (cache && stale) {
          setStalePrompt(true); // let the user decide
        } else if (!cache) {
          analyzer.analyzeAlbum(albumId, { mediaType });
        }
      })();
    }, 450);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [albumId, mediaType, isVideo, settings.similarDetection]);

  const startCleaning = () => {
    if (thumbs.length === 0) return;
    navigation.navigate(cleaningRoute, {
      albumId,
      albumTitle,
      groupSize,
    });
  };

  const cardW = Math.min(Math.round(width * 0.58), 250);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <Text style={[styles.header, { color: colors.text }]}>
        {t(isVideo ? 'clean_videos' : 'clean_photos')}
      </Text>

      <View style={styles.controls}>
        <AlbumPicker
          albums={albums}
          selected={albumId}
          progressByAlbum={progressByAlbum}
          onSelect={(a) => setAlbumId(a.id)}
        />
        <View
          style={[
            styles.stepper,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Pressable
            hitSlop={8}
            onPress={() => setGroupSize((g) => Math.max(MIN_GROUP, g - 1))}
          >
            <Ionicons name="remove" size={20} color={colors.accent} />
          </Pressable>
          <View style={styles.stepperCenter}>
            <Text style={[styles.stepperValue, { color: colors.text }]}>
              {groupSize}
            </Text>
            <Text style={[styles.stepperLabel, { color: colors.subtext }]}>
              {t('group_size')}
            </Text>
          </View>
          <Pressable
            hitSlop={8}
            onPress={() => setGroupSize((g) => Math.min(MAX_GROUP, g + 1))}
          >
            <Ionicons name="add" size={20} color={colors.accent} />
          </Pressable>
        </View>
      </View>

      <View style={styles.cards}>
        <StackedCards
          items={thumbs}
          cardWidth={cardW}
          isVideo={isVideo}
          onPress={startCleaning}
        />
      </View>

      <Text style={[styles.hint, { color: colors.subtext }]}>
        {thumbs.length === 0
          ? t(isVideo ? 'no_videos' : 'no_photos')
          : t('start_hint')}
      </Text>

      <AnalysisProgress
        state={analysisState}
        mediaType={mediaType}
        onCancel={() => analyzer.cancel(albumId)}
      />
      <CacheStalePrompt
        visible={stalePrompt}
        onReanalyze={() => {
          setStalePrompt(false);
          analyzer.analyzeAlbum(albumId, { mediaType, force: true });
        }}
        onUseStale={() => setStalePrompt(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16 },
  header: { fontSize: 30, fontWeight: '800', marginTop: 12, marginBottom: 18 },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginBottom: 26,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  stepperCenter: { alignItems: 'center', minWidth: 56 },
  stepperValue: { fontSize: 17, fontWeight: '800' },
  stepperLabel: { fontSize: 10 },
  cards: {
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 0,
    minHeight: 260,
  },
  hint: { textAlign: 'center', marginTop: 24, fontSize: 13 },
});
