import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';
import { formatDate } from '../utils/albumHelpers';

/**
 * Floating info bar shown on cleaning screens (replaces the tab bar).
 * Left: favorite · Center: date (opens EXIF modal) · Right: undo.
 */
export default function BottomInfoBar({
  asset,
  isFavorite,
  onToggleFavorite,
  onPressDate,
  undoCount,
  onUndo,
}) {
  const { colors, language, t } = useSettings();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[styles.wrap, { bottom: Math.max(insets.bottom, 12) }]}
      pointerEvents="box-none"
    >
      <BlurView
        intensity={Platform.OS === 'ios' ? 60 : 100}
        tint={colors.glassTint}
        style={[styles.bar, { borderColor: colors.border }]}
      >
        <View
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.barOverlay }]}
        />
        <Pressable
          onPress={onToggleFavorite}
          hitSlop={10}
          style={styles.side}
          accessibilityLabel={t('favorite')}
        >
          <Ionicons
            name={isFavorite ? 'heart' : 'heart-outline'}
            size={24}
            color={isFavorite ? colors.heart : colors.subtext}
          />
        </Pressable>

        <Pressable onPress={onPressDate} style={styles.center} hitSlop={6}>
          <Text style={[styles.date, { color: colors.text }]} numberOfLines={1}>
            {asset ? formatDate(asset.creationTime, language) : '—'}
          </Text>
          <Ionicons
            name="information-circle-outline"
            size={15}
            color={colors.subtext}
          />
        </Pressable>

        <Pressable
          onPress={onUndo}
          disabled={undoCount === 0}
          hitSlop={10}
          style={[styles.side, { opacity: undoCount === 0 ? 0.35 : 1 }]}
          accessibilityLabel={t('undo')}
        >
          <Ionicons name="arrow-undo" size={22} color={colors.accent} />
          {undoCount > 0 && (
            <View style={[styles.badge, { backgroundColor: colors.danger }]}>
              <Text style={styles.badgeText}>{undoCount}</Text>
            </View>
          )}
        </Pressable>
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 28,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 18,
    paddingVertical: 12,
    alignSelf: 'stretch',
  },
  side: { width: 44, alignItems: 'center', justifyContent: 'center' },
  center: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  date: { fontSize: 14, fontWeight: '600' },
  badge: {
    position: 'absolute',
    top: -4,
    right: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
});
