import React, { useRef } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';
import GlassSurface from './GlassSurface';
import { getTabBarLayout } from '../utils/tabBarLayout';

/**
 * Non-blocking analysis overlay pinned above the tab bar.
 * Shows progress, an ETA (photoo-style, from the live scan rate),
 * low-power state and a cancel button.
 */
export default function AnalysisProgress({
  state, mediaType = 'photo', onCancel, androidSource, effectEnabled = true, onLayout,
}) {
  const { colors, t } = useSettings();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const tabBarLayout = getTabBarLayout(dimensions, insets);
  const maxLabelHeight = Math.max(48, Math.min(112, dimensions.height - insets.top - tabBarLayout.clearance - 84));

  // ETA from the observed rate. Keyed by total so a new run resets it.
  const etaRef = useRef({ total: 0, startTime: 0, startDone: 0 });
  let etaLabel = null;
  if (state && state.running && state.total) {
    const now = Date.now();
    const e = etaRef.current;
    if (e.total !== state.total) {
      etaRef.current = { total: state.total, startTime: now, startDone: state.done || 0 };
    } else {
      const elapsed = (now - e.startTime) / 1000;
      const processed = (state.done || 0) - e.startDone;
      if (elapsed > 3 && processed > 5) {
        const rate = processed / elapsed; // items per second
        const remaining = Math.max(0, state.total - state.done) / rate;
        etaLabel =
          remaining >= 60
            ? t('eta_minutes', { min: Math.ceil(remaining / 60) })
            : t('eta_seconds', { sec: Math.max(1, Math.round(remaining)) });
      }
    }
  }

  // Hide entirely for zero-work refreshes (all photos already analyzed).
  if (!state || !state.running || !state.total) return null;

  const pct = Math.min(1, Math.max(0, (Number(state.done) || 0) / state.total));
  let label = t(mediaType === 'video' ? 'analyzing_videos' : 'analyzing', {
    done: state.done,
    total: state.total,
  });
  if (state.memoryPaused) label = t('analysis_paused_low_power');
  else if (state.lowPower) label = `${label} · ${t('analysis_low_power_chunk')}`;
  else if (etaLabel) label = `${label} · ${etaLabel}`;

  return (
    <View
      // Shares the actual bar geometry, including safe areas and text scaling.
      style={[styles.wrap, { bottom: tabBarLayout.clearance - 8 }]}
      pointerEvents="box-none"
      onLayout={onLayout}
    >
      <GlassSurface androidSource={androidSource} effectEnabled={effectEnabled} style={[styles.card, { borderColor: colors.border }]}>
        <View style={styles.inner}>
          <View style={styles.row}>
            <ScrollView style={[styles.labelViewport, { maxHeight: maxLabelHeight }]} nestedScrollEnabled>
              <Text style={[styles.text, { color: colors.text }]}>{label}</Text>
            </ScrollView>
            <Pressable
              onPress={onCancel}
              hitSlop={4}
              style={({ pressed }) => [styles.cancel, pressed && { backgroundColor: colors.elevated }]}
              accessibilityRole="button"
              accessibilityLabel={t('cancel')}
            >
              <Ionicons name="close-circle" size={22} color={colors.glassSubtext} accessible={false} />
            </Pressable>
          </View>
          <View style={[styles.track, { backgroundColor: colors.chartTrack }]}>
            <View
              style={[
                styles.fill,
                { backgroundColor: colors.accent, width: `${Math.round(pct * 100)}%` },
              ]}
            />
          </View>
        </View>
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  card: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  inner: { padding: 12 },
  row: { flexDirection: 'row', alignItems: 'center' },
  labelViewport: { flex: 1, minWidth: 0 },
  text: { fontSize: 13, fontWeight: '600' },
  cancel: { marginLeft: 8, minWidth: 48, minHeight: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, marginTop: 8, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
});
