import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
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
import { getAlbums, getAssetsPage, ALL_ALBUM_ID } from '../utils/albumHelpers';

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
  const [stalePrompt, setStalePrompt] = useState(false);

  const albumTitle = useMemo(() => {
    const a = albums.find((x) => x.id === albumId);
    return a ? a.title : '';
  }, [albums, albumId]);

  // Load album list on focus (library may have changed).
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      getAlbums(mediaType, t(isVideo ? 'all_videos' : 'all_photos'))
        .then((list) => alive && setAlbums(list))
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, [mediaType, t, isVideo])
  );

  // Thumbnails for the three preview cards. ONE page — this used to page the
  // whole library (up to 20k assets, 200 at a time) just to keep the first
  // three, which is why the cards took seconds to appear.
  useEffect(() => {
    let alive = true;
    getAssetsPage(albumId, mediaType)
      .then((page) => alive && setThumbs(page.assets.slice(0, 3)))
      .catch(() => alive && setThumbs([]));
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
    (async () => {
      const { cache, stale } = await analyzer.checkCache(albumId, mediaType);
      if (!alive) return;
      if (cache && stale) {
        setStalePrompt(true); // let the user decide
      } else if (!cache) {
        analyzer.analyzeAlbum(albumId, { mediaType });
      }
    })();
    return () => {
      alive = false;
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

  const cardW = Math.min(Math.round(width * 0.5), 220);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <Text style={[styles.header, { color: colors.text }]}>
        {t(isVideo ? 'clean_videos' : 'clean_photos')}
      </Text>

      <View style={styles.controls}>
        <AlbumPicker
          albums={albums}
          selected={albumId}
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
