import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useSettings } from '../context/SettingsContext';

/**
 * Thin determinate progress bar used by the loading states of the cleaning
 * flows. `done`/`total` rather than a fraction, because that is what every
 * caller (analyzer, burst verification, suggestion scan) already tracks.
 */
export default function ProgressBar({ done = 0, total = 0, style }) {
  const { colors } = useSettings();
  const percent =
    total > 0 ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : 0;
  return (
    <View
      style={[styles.track, { backgroundColor: colors.chartTrack }, style]}
    >
      <View
        style={[
          styles.fill,
          { width: `${percent}%`, backgroundColor: colors.accent },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 4, borderRadius: 2, overflow: 'hidden', width: '100%' },
  fill: { height: 4, borderRadius: 2 },
});
