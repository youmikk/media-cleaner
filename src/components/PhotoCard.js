import React from 'react';
import { View, StyleSheet, Text } from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

/**
 * Full-bleed media display for the cleaning flow. The photo keeps its
 * ORIGINAL aspect ratio (like iOS Photos), centered on a theme-adaptive
 * background. Renders an inline video player (expo-video) when the asset
 * is a video (e.g. in the "Largest Files" flow).
 */
export default function PhotoCard({ asset, isFavorite, marked, sizeLabel }) {
  const { colors, t } = useSettings();
  const isVideo = asset ? asset.mediaType === 'video' : false;
  const player = useVideoPlayer(isVideo ? asset.uri : null);

  if (!asset) return null;
  const aspectRatio =
    asset.width && asset.height ? asset.width / asset.height : 1;

  return (
    <View style={styles.card}>
      {isVideo ? (
        <VideoView
          player={player}
          style={styles.fill}
          contentFit="contain"
          nativeControls
        />
      ) : (
        <Image
          source={{ uri: asset.uri }}
          style={[styles.image, { aspectRatio }]}
          contentFit="contain"
          cachePolicy="memory-disk"
          recyclingKey={asset.id}
          transition={80}
        />
      )}
      {isFavorite && (
        <View style={styles.favBadge}>
          <Ionicons name="heart" size={18} color={colors.heart} />
        </View>
      )}
      {marked && (
        <View style={[styles.markBadge, { backgroundColor: colors.danger }]}>
          <Ionicons name="trash" size={13} color="#fff" />
          <Text style={styles.markText}>{t('marked_for_deletion')}</Text>
        </View>
      )}
      {!!sizeLabel && (
        <View style={styles.sizeBadge}>
          <Ionicons name="server-outline" size={12} color="#fff" />
          <Text style={styles.sizeText}>{sizeLabel}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fill: { ...StyleSheet.absoluteFillObject },
  image: {
    width: '100%',
    maxHeight: '100%',
    borderRadius: 14,
  },
  favBadge: {
    position: 'absolute',
    top: 14,
    left: 14,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 14,
    padding: 6,
  },
  markBadge: {
    position: 'absolute',
    top: 14,
    right: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  markText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  sizeBadge: {
    position: 'absolute',
    bottom: 14,
    left: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  sizeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
