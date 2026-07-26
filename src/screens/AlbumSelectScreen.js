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
import CacheStalePrompt from '../components/CacheStalePrompt';
import analyzer from '../utils/chunkedAnalyzer';
import { getAlbums, getAssets, ALL_ALBUM_ID } from '../utils/albumHelpers';

/**
 * Photos tab entry: album picker top-left, three preview cards centered
 * (middle taller), photo count below. Group size comes from the global
 * setting (Profile → Settings). Kicks off / reuses chunked analysis.
 */
export default function AlbumSelectScreen({ navigation }) {
  const { colors, t, settings } = useSettings();
  const { width } = useWindowDimensions();

  const [albums, setAlbums] = useState([]);
  const [albumId, setAlbumId] = useState(ALL_ALBUM_ID);
  const [assets, setAssets] = useState([]);
  const [timeFilter, setTimeFilter] = useState(null); // {label, start, end}
  const [analysisState, setAnalysisState] = useState(null);
  const [stalePrompt, setStalePrompt] = useState(false);

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

  useEffect(() => {
    let alive = true;
    getAssets(albumId, 'photo')
      .then((list) => alive && setAssets(list))
      .catch(() => alive && setAssets([]));
    return () => {
      alive = false;
    };
  }, [albumId]);

  useEffect(() => analyzer.subscribe(setAnalysisState), []);

  // Analysis when cache is missing/stale (similar detection enabled).
  useEffect(() => {
    if (!settings.similarDetection) return;
    let alive = true;
    (async () => {
      const { cache, stale } = await analyzer.checkCache(albumId, 'photo');
      if (!alive) return;
      if (cache && stale) setStalePrompt(true);
      else if (!cache) analyzer.analyzeAlbum(albumId, { mediaType: 'photo' });
    })();
    return () => {
      alive = false;
    };
  }, [albumId, settings.similarDetection]);

  // Apply the year / year-month scope.
  const filteredAssets = useMemo(() => {
    if (!timeFilter) return assets;
    return assets.filter(
      (a) =>
        a.creationTime &&
        a.creationTime >= timeFilter.start &&
        a.creationTime < timeFilter.end
    );
  }, [assets, timeFilter]);

  const startCleaning = () => {
    if (filteredAssets.length === 0) return;
    navigation.navigate('Cleaning', {
      albumId,
      albumTitle: timeFilter ? `${albumTitle} · ${timeFilter.label}` : albumTitle,
      timeRange: timeFilter
        ? { start: timeFilter.start, end: timeFilter.end }
        : null,
    });
  };

  const thumbs = filteredAssets.slice(0, 3);
  const cardW = (width - 16 * 2 - 12 * 2) / 3;
  const cardHeights = [cardW * 1.5, cardW * 1.9, cardW * 1.5];

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <Text style={[styles.header, { color: colors.text }]}>
        {t('clean_photos')}
      </Text>

      {/* Top-left: album picker + time scope (year / year-month) */}
      <View style={styles.controls}>
        <AlbumPicker
          albums={albums}
          selected={albumId}
          onSelect={(a) => {
            setAlbumId(a.id);
            setTimeFilter(null);
          }}
        />
        <TimePicker
          assets={assets}
          value={timeFilter}
          onSelect={setTimeFilter}
        />
      </View>

      {/* Centered preview cards */}
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
                <Image source={{ uri: thumbs[i].uri }} style={styles.cardImage} />
              ) : (
                <View style={styles.cardEmpty}>
                  <Ionicons name="image-outline" size={28} color={colors.subtext} />
                </View>
              )}
            </Pressable>
          ))}
        </View>
        <Text style={[styles.count, { color: colors.subtext }]}>
          {filteredAssets.length === 0
            ? t('no_photos')
            : t('photo_count', { count: filteredAssets.length })}
        </Text>
        {filteredAssets.length > 0 && (
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
      <CacheStalePrompt
        visible={stalePrompt}
        onReanalyze={() => {
          setStalePrompt(false);
          analyzer.analyzeAlbum(albumId, { mediaType: 'photo', force: true });
        }}
        onUseStale={() => setStalePrompt(false)}
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
    marginBottom: 90, // keep visually centered above the floating tab bar
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
