import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useSettings } from '../context/SettingsContext';

/**
 * Dots indicating position within the current group.
 */
export default function PageIndicator({ total, index }) {
  const { colors } = useSettings();
  if (total <= 1) return null;
  return (
    <View style={styles.row}>
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          style={[
            styles.dot,
            {
              backgroundColor: i === index ? colors.accent : colors.chartTrack,
              width: i === index ? 18 : 6,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 5,
  },
  dot: { height: 6, borderRadius: 3 },
});
