import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';
import GlassSurface from './GlassSurface';
import { formatDate } from '../utils/albumHelpers';

/**
 * Floating info bar shown on cleaning screens (replaces the tab bar).
 * Liquid Glass on iOS 26, blur fallback elsewhere.
 * Left: favorite · Center: date (+optional subtitle, opens EXIF) · Right: undo.
 *
 * `floating` mode (video feed): NO bar at all — just the date/address text
 * floating over the video with a shadow, nothing on either side.
 */
export default function BottomInfoBar({
  asset,
  subtitle,
  address,
  isFavorite,
  onToggleFavorite,
  onPressDate,
  undoCount = 0,
  onUndo,
  hideFavorite = false,
  floating = false,
}) {
  const { colors, language, t } = useSettings();
  const insets = useSafeAreaInsets();

  if (floating) {
    return (
      <View
        style={[styles.wrap, { bottom: Math.max(insets.bottom, 12) }]}
        pointerEvents="box-none"
      >
        <Pressable onPress={onPressDate} hitSlop={8} style={styles.floatingCenter}>
          <View style={styles.dateRow}>
            <Text style={[styles.date, styles.floatingText]} numberOfLines={1}>
              {asset ? formatDate(asset.creationTime, language) : '—'}
              {subtitle ? ` · ${subtitle}` : ''}
            </Text>
            <Ionicons
              name="information-circle-outline"
              size={15}
              color="rgba(255,255,255,0.8)"
            />
          </View>
          {!!address && (
            <View style={styles.addressRow}>
              <Ionicons
                name="location-outline"
                size={11}
                color="rgba(255,255,255,0.8)"
              />
              <Text
                style={[styles.address, styles.floatingText]}
                numberOfLines={1}
              >
                {address}
              </Text>
            </View>
          )}
        </Pressable>
      </View>
    );
  }

  return (
    <View
      style={[styles.wrap, { bottom: Math.max(insets.bottom, 12) }]}
      pointerEvents="box-none"
    >
      <GlassSurface
        style={[styles.bar, { borderColor: colors.border }]}
        overlayColor={colors.barOverlay}
      >
        <View style={styles.row}>
          {hideFavorite ? (
            <View style={styles.side} />
          ) : (
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
          )}

          <Pressable onPress={onPressDate} style={styles.center} hitSlop={6}>
            <View style={styles.centerText}>
              <View style={styles.dateRow}>
                <Text style={[styles.date, { color: colors.text }]} numberOfLines={1}>
                  {asset ? formatDate(asset.creationTime, language) : '—'}
                  {subtitle ? ` · ${subtitle}` : ''}
                </Text>
                <Ionicons
                  name="information-circle-outline"
                  size={15}
                  color={colors.subtext}
                />
              </View>
              {!!address && (
                <View style={styles.addressRow}>
                  <Ionicons name="location-outline" size={11} color={colors.subtext} />
                  <Text
                    style={[styles.address, { color: colors.subtext }]}
                    numberOfLines={1}
                  >
                    {address}
                  </Text>
                </View>
              )}
            </View>
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
        </View>
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  bar: {
    borderRadius: 28,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  side: { width: 44, alignItems: 'center', justifyContent: 'center' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerText: { alignItems: 'center' },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 2,
    maxWidth: 220,
  },
  date: { fontSize: 14, fontWeight: '600' },
  address: { fontSize: 11 },
  floatingCenter: { alignItems: 'center' },
  floatingText: {
    color: '#fff',
    textShadowColor: 'rgba(0,0,0,0.65)',
    textShadowRadius: 4,
  },
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
