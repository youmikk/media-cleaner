import React from 'react';
import { View, Text, Pressable, Image, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

/**
 * Horizontal smart-suggestion card with thumbnail, description and CTA.
 */
export default function SuggestionCard({ icon, title, description, thumbnailUri, count, onClean }) {
  const { colors, t } = useSettings();
  return (
    <View style={[styles.card, { backgroundColor: colors.card }]}>
      <View style={styles.thumbWrap}>
        {thumbnailUri ? (
          <Image source={{ uri: thumbnailUri }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback, { backgroundColor: colors.accentSoft }]}>
            <Ionicons name={icon} size={30} color={colors.accent} />
          </View>
        )}
        {count > 0 && (
          <View style={[styles.badge, { backgroundColor: colors.accent }]}>
            <Text style={styles.badgeText}>{count}</Text>
          </View>
        )}
      </View>
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
        {title}
      </Text>
      <Text style={[styles.desc, { color: colors.subtext }]} numberOfLines={2}>
        {description}
      </Text>
      <Pressable
        onPress={onClean}
        disabled={count === 0}
        style={[
          styles.cta,
          { backgroundColor: count === 0 ? colors.chartTrack : colors.accent },
        ]}
      >
        <Text
          style={[styles.ctaText, { color: count === 0 ? colors.subtext : '#fff' }]}
        >
          {count === 0 ? t('nothing_found') : t('clean_now')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 190,
    borderRadius: 18,
    padding: 14,
    marginRight: 12,
  },
  thumbWrap: { marginBottom: 10 },
  thumb: { width: '100%', height: 96, borderRadius: 12 },
  thumbFallback: { alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    top: 8,
    right: 8,
    borderRadius: 11,
    minWidth: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  title: { fontSize: 15, fontWeight: '700' },
  desc: { fontSize: 12, marginTop: 3, minHeight: 32 },
  cta: {
    marginTop: 10,
    borderRadius: 12,
    paddingVertical: 9,
    alignItems: 'center',
  },
  ctaText: { fontSize: 13, fontWeight: '700' },
});
