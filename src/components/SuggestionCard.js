import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

/**
 * Horizontal smart-suggestion card with thumbnail, description and CTA.
 */
export default function SuggestionCard({
  icon,
  title,
  description,
  thumbnailUri,
  count,
  onClean,
  progress = null,
}) {
  const { colors, t } = useSettings();
  const progressPercent = progress?.total
    ? Math.min(100, Math.round((progress.done / progress.total) * 100))
    : 0;
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
      {progress && progress.total > 0 && (
        <View
          style={styles.progressWrap}
          accessibilityRole="progressbar"
          accessibilityLabel={`${title}, ${progress.label}`}
          accessibilityValue={{
            min: 0,
            max: 100,
            now: progressPercent,
            text: `${progressPercent}%`,
          }}
        >
          <View style={styles.progressRow}>
            <Text style={[styles.progressText, { color: colors.subtext }]} numberOfLines={1}>
              {progress.label}
            </Text>
            <Text style={[styles.progressValue, { color: colors.accent }]}>
              {progressPercent}%
            </Text>
          </View>
          <View style={[styles.progressTrack, { backgroundColor: colors.chartTrack }]}>
            <View
              style={[
                styles.progressFill,
                { width: `${progressPercent}%`, backgroundColor: colors.accent },
              ]}
            />
          </View>
        </View>
      )}
      <Pressable
        onPress={onClean}
        disabled={count === 0}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${
          count === 0 ? t('nothing_found') : t('clean_now')
        }`}
        accessibilityState={{ disabled: count === 0 }}
        style={({ pressed }) => [
          styles.cta,
          { backgroundColor: count === 0 ? colors.chartTrack : colors.accent },
          pressed && styles.ctaPressed,
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
    borderRadius: 8,
    padding: 14,
    marginRight: 12,
    minHeight: 244,
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
  progressWrap: { marginTop: 8 },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  progressText: { flex: 1, fontSize: 10 },
  progressValue: { fontSize: 10, fontWeight: '800' },
  progressTrack: { height: 4, borderRadius: 2, marginTop: 5, overflow: 'hidden' },
  progressFill: { height: 4, borderRadius: 2 },
  cta: {
    marginTop: 10,
    borderRadius: 12,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaPressed: { opacity: 0.72 },
  ctaText: { fontSize: 13, fontWeight: '700' },
});
