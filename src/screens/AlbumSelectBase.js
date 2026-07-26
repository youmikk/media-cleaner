import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Image,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';
import AlbumPicker from '../components/AlbumPicker';
import AnalysisProgress from '../components/AnalysisProgress';
import CacheStalePrompt from '../components/CacheStalePrompt';
import analyzer from '../utils/chunkedAnalyzer';
import { getAlbums, getAssets, ALL_ALBUM_ID } from '../utils/albumHelpers';

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

  // Thumbnails for the three preview cards.
  useEffect(() => {
    let alive = true;
    getAssets(albumId, mediaType)
      .then((assets) => alive && setThumbs(assets.slice(0, 3)))
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

  const cardW = (width - 16 * 2 - 12 * 2) / 3;
  const cardHeights = [cardW * 1.5, cardW * 1.9, cardW * 1.5];

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
              <Image source={{ uri: thumbs[i].uri }} style={styles.cardImage} />
            ) : (
              <View style={styles.cardEmpty}>
                <Ionicons
                  name={isVideo ? 'videocam-outline' : 'image-outline'}
                  size={28}
                  color={colors.subtext}
                />
              </View>
            )}
            {isVideo && thumbs[i] && (
              <View style={styles.playBadge}>
                <Ionicons name="play" size={18} color="#fff" />
              </View>
            )}
          </Pressable>
        ))}
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexGrow: 0,
    minHeight: 260,
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
  playBadge: {
    position: 'absolute',
    alignSelf: 'center',
    top: '42%',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 20,
    padding: 8,
  },
  hint: { textAlign: 'center', marginTop: 24, fontSize: 13 },
});
