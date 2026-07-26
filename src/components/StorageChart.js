import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSettings } from '../context/SettingsContext';
import { formatBytes } from '../utils/albumHelpers';

/**
 * Horizontal bar comparing space saved against the original gallery size.
 */
export default function StorageChart({ savedBytes, originalBytes }) {
  const { colors, t } = useSettings();
  const total = Math.max(originalBytes, savedBytes, 1);
  const pct = Math.min(1, savedBytes / total);

  return (
    <View style={[styles.card, { backgroundColor: colors.card }]}>
      <Text style={[styles.saved, { color: colors.text }]}>
        {t('space_saved', { size: formatBytes(savedBytes) })}
      </Text>
      <View style={[styles.track, { backgroundColor: colors.chartTrack }]}>
        <View
          style={[
            styles.fill,
            {
              backgroundColor: colors.success,
              width: `${Math.max(2, Math.round(pct * 100))}%`,
            },
          ]}
        />
      </View>
      <Text style={[styles.original, { color: colors.subtext }]}>
        {t('original_size', { size: formatBytes(originalBytes) })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, padding: 16 },
  saved: { fontSize: 16, fontWeight: '700', marginBottom: 10 },
  track: { height: 14, borderRadius: 7, overflow: 'hidden' },
  fill: { height: 14, borderRadius: 7 },
  original: { fontSize: 12, marginTop: 8 },
});
