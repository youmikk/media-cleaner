import React, { useRef } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';
import GlassSurface from './GlassSurface';

/**
 * Non-blocking analysis overlay pinned above the tab bar.
 * Shows progress, an ETA (photoo-style, from the live scan rate),
 * low-power state and a cancel button.
 */
export default function AnalysisProgress({ state, mediaType = 'photo', onCancel }) {
  const { colors, t } = useSettings();
  const insets = useSafeAreaInsets();

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

  const pct = state.total > 0 ? state.done / state.total : 0;
  let label = t(mediaType === 'video' ? 'analyzing_videos' : 'analyzing', {
    done: state.done,
    total: state.total,
  });
  if (state.memoryPaused) label = t('analysis_paused_low_power');
  else if (state.lowPower) label = `${label} · ${t('analysis_low_power_chunk')}`;
  else if (etaLabel) label = `${label} · ${etaLabel}`;

  return (
    <View
      // Sits ABOVE the floating tab bar (capsule ≈64px + its bottom offset).
      style={[styles.wrap, { bottom: Math.max(insets.bottom, 12) + 80 }]}
      pointerEvents="box-none"
    >
      <GlassSurface style={[styles.card, { borderColor: colors.border }]}>
        <View style={styles.inner}>
        <View style={styles.row}>
          <Text style={[styles.text, { color: colors.text }]} numberOfLines={1}>
            {label}
          </Text>
          <Pressable onPress={onCancel} hitSlop={8} style={styles.cancel}>
            <Ionicons name="close-circle" size={22} color={colors.subtext} />
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
    left: 16,
    right: 16,
  },
  card: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  inner: { padding: 12 },
  row: { flexDirection: 'row', alignItems: 'center' },
  text: { flex: 1, fontSize: 13, fontWeight: '600' },
  cancel: { marginLeft: 8 },
  track: { height: 4, borderRadius: 2, marginTop: 8, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
});
