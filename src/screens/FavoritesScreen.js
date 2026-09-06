import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import { surfaceShapes } from '../theme/shapes';
import { useFavorites } from '../context/AppContext';
import { getAssetsByIds } from '../utils/albumHelpers';
import { getVideoThumbnail } from '../utils/thumbCache';
import IconButton from '../components/IconButton';
import GlassBackdrop from '../components/GlassBackdrop';
import GlassSurface from '../components/GlassSurface';

const GAP = 6;
const RESOLVE_CHUNK = 600;
const THUMB_CONCURRENCY = 3;

export default function FavoritesScreen({ navigation }) {
  const { colors, t, settings, setSetting } = useSettings();
  const { favorites, toggleFavorite } = useFavorites();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const glassSource = useId();
  const [headerHeight, setHeaderHeight] = useState(56);
  const [assets, setAssets] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [loading, setLoading] = useState(true);
  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;
  const isGrid = settings.favoriteView !== 'list';
  const columns = Math.max(2, Math.min(4, settings.favoriteColumns || 3));
  const tileSize = Math.floor((width - insets.left - insets.right - 32 - GAP * (columns - 1)) / columns);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      setLoading(true);
      (async () => {
        const ids = Object.keys(favoritesRef.current || {});
        const resolved = [];
        for (let i = 0; i < ids.length; i += RESOLVE_CHUNK) {
          // eslint-disable-next-line no-await-in-loop
          const part = await getAssetsByIds(ids.slice(i, i + RESOLVE_CHUNK));
          resolved.push(...part);
        }
        if (alive) {
          setAssets(resolved);
          setLoading(false);
        }
        const videos = resolved.filter((asset) => asset.mediaType === 'video');
        for (let i = 0; i < videos.length && alive; i += THUMB_CONCURRENCY) {
          // A video poster requires a native decode. Keep the batch small so
          // a large favorites collection cannot start hundreds at once.
          // eslint-disable-next-line no-await-in-loop
          const batch = await Promise.all(
            videos.slice(i, i + THUMB_CONCURRENCY).map(async (asset) => {
              try {
                return [asset.id, await getVideoThumbnail(asset)];
              } catch (e) {
                return [asset.id, null];
              }
            })
          );
          if (!alive) return;
          const next = Object.fromEntries(batch.filter(([, uri]) => !!uri));
          if (Object.keys(next).length > 0) {
            setThumbs((prev) => ({ ...prev, ...next }));
          }
        }
      })().catch(() => alive && setLoading(false));
      return () => {
        alive = false;
      };
    }, [])
  );

  const visibleAssets = useMemo(
    () => assets.filter((asset) => favorites[asset.id]),
    [assets, favorites]
  );

  const cycleColumns = () =>
    setSetting('favoriteColumns', columns >= 4 ? 2 : columns + 1);

  const renderHeart = (asset, floating = false) => (
    <Pressable
      accessibilityLabel={t('remove_favorite')}
      hitSlop={8}
      onPress={() => toggleFavorite(asset.id)}
      style={[styles.heart, floating && styles.floatingHeart, { backgroundColor: colors.card }]}
    >
      <Ionicons name="heart" size={17} color={colors.heart} />
    </Pressable>
  );

  const renderTile = (asset) => (
    <View
      style={[
        styles.tile,
        { width: tileSize, height: tileSize, backgroundColor: colors.card },
      ]}
    >
      {asset.mediaType !== 'video' || thumbs[asset.id] ? (
        <Image
          source={{ uri: thumbs[asset.id] || asset.uri }}
          style={styles.image}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      ) : (
        <View style={[styles.image, styles.placeholder]}>
          <Ionicons name="videocam" size={24} color={colors.subtext} />
        </View>
      )}
      {asset.mediaType === 'video' && (
        <View style={styles.videoBadge}>
          <Ionicons name="play" size={11} color="#fff" />
        </View>
      )}
      {renderHeart(asset, true)}
    </View>
  );

  const renderRow = (asset) => (
    <View style={[styles.row, { backgroundColor: colors.card }]}>
      {asset.mediaType !== 'video' || thumbs[asset.id] ? (
        <Image
          source={{ uri: thumbs[asset.id] || asset.uri }}
          style={styles.rowThumb}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      ) : (
        <View style={[styles.rowThumb, styles.placeholder]}>
          <Ionicons name="videocam" size={22} color={colors.subtext} />
        </View>
      )}
      <View style={styles.rowInfo}>
        <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
          {asset.filename || t(asset.mediaType === 'video' ? 'clean_videos' : 'clean_photos')}
        </Text>
        <Text style={[styles.rowMeta, { color: colors.subtext }]}>
          {asset.width || 0} x {asset.height || 0}
        </Text>
      </View>
      {renderHeart(asset)}
    </View>
  );

  const listToolbar = isGrid && visibleAssets.length > 0 ? (
    <View style={styles.toolbar}>
      <Text style={[styles.count, { color: colors.subtext }]}>
        {t('favorite_count', { count: visibleAssets.length })}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('recycle_columns', { count: columns })}
        style={({ pressed }) => [styles.columnChip, pressed && { backgroundColor: colors.elevated }]}
        onPress={cycleColumns}
      >
        <Ionicons name="apps-outline" size={18} color={colors.accent} accessible={false} />
        <Text style={[styles.columnLabel, { color: colors.text }]}>
          {t('recycle_columns', { count: columns })}
        </Text>
      </Pressable>
    </View>
  ) : null;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.screen, { backgroundColor: colors.background }]}
    >
      <View style={styles.content}>
        {/* The header is outside its source and stays first in accessibility order. */}
        <GlassSurface
          androidSource={glassSource}
          effectEnabled={focused && !loading && visibleAssets.length > 0}
          onLayout={({ nativeEvent }) => setHeaderHeight(Math.ceil(nativeEvent.layout.height))}
          style={[styles.header, { borderColor: colors.border }]}
        >
          <View style={styles.topBar}>
            <IconButton
              name="chevron-back"
              label={t('back')}
              onPress={() => navigation.goBack()}
              color={colors.text}
              iconSize={26}
            />
            <Text style={[styles.title, { color: colors.text }]}>{t('my_favorites')}</Text>
            <IconButton
              name={isGrid ? 'list-outline' : 'grid-outline'}
              label={t(isGrid ? 'recycle_view_list' : 'recycle_view_grid')}
              onPress={() => setSetting('favoriteView', isGrid ? 'list' : 'grid')}
              color={colors.glassAccent}
            />
          </View>
        </GlassSurface>

        <GlassBackdrop sourceKey={glassSource} style={{ backgroundColor: colors.background }}>
          {loading ? (
            <View style={[styles.empty, { paddingTop: headerHeight, paddingBottom: insets.bottom }]}>
              <ActivityIndicator size="large" color={colors.accent} />
            </View>
          ) : visibleAssets.length === 0 ? (
            <View style={[styles.empty, { paddingTop: headerHeight, paddingBottom: insets.bottom }]}>
              <Ionicons name="heart-outline" size={48} color={colors.subtext} />
              <Text style={{ color: colors.subtext }}>{t('favorites_empty')}</Text>
            </View>
          ) : (
            <FlatList
              key={isGrid ? `grid-${columns}` : 'list'}
              data={visibleAssets}
              keyExtractor={(item) => item.id}
              numColumns={isGrid ? columns : 1}
              columnWrapperStyle={isGrid ? styles.gridRow : undefined}
              ListHeaderComponent={listToolbar}
              contentContainerStyle={{ paddingTop: headerHeight + 12, paddingBottom: Math.max(insets.bottom, 16) }}
              scrollIndicatorInsets={{ top: headerHeight, bottom: insets.bottom }}
              initialNumToRender={18}
              maxToRenderPerBatch={18}
              windowSize={7}
              renderItem={({ item }) => (isGrid ? renderTile(item) : renderRow(item))}
            />
          )}
        </GlassBackdrop>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16 },
  content: { flex: 1 },
  header: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1,
    borderRadius: 16, borderWidth: StyleSheet.hairlineWidth,
    ...surfaceShapes.toolbar,
  },
  topBar: {
    minHeight: 56,
    paddingHorizontal: 4,
    paddingVertical: 4,
    gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '800' },
  toolbar: {
    minHeight: 48,
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  columnChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  count: { flexShrink: 1, fontSize: 13 },
  columnLabel: { flexShrink: 1, fontSize: 12, fontWeight: '700' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  gridRow: { gap: GAP, marginBottom: GAP },
  tile: { borderRadius: 8, overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  videoBadge: {
    position: 'absolute',
    left: 6,
    top: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.48)',
  },
  heart: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  floatingHeart: { position: 'absolute', right: 6, top: 6 },
  row: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 8,
    padding: 9,
    marginBottom: 8,
  },
  rowThumb: { width: 58, height: 58, borderRadius: 8 },
  rowInfo: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 14, fontWeight: '700' },
  rowMeta: { fontSize: 12, marginTop: 3 },
});
