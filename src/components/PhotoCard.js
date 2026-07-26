import React from 'react';
import { View, Image, StyleSheet, Text } from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

/**
 * Full-bleed media display for the cleaning flow. Renders an inline video
 * player when the asset is a video (e.g. in the "Largest Files" flow).
 */
export default function PhotoCard({ asset, isFavorite, marked }) {
  const { colors, t } = useSettings();
  if (!asset) return null;
  const isVideo = asset.mediaType === 'video';
  return (
    <View style={[styles.card, { backgroundColor: colors.card }]}>
      {isVideo ? (
        <Video
          source={{ uri: asset.uri }}
          style={styles.image}
          resizeMode={ResizeMode.CONTAIN}
          useNativeControls
        />
      ) : (
        <Image
          source={{ uri: asset.uri }}
          style={styles.image}
          resizeMode="contain"
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
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 24,
    overflow: 'hidden',
  },
  image: { flex: 1 },
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
});
