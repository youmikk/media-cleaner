import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';

/** Compact segmented ring that works in Expo Go and older binaries. */
export default function ProgressRing({
  percent = 0,
  size = 30,
  color,
  trackColor,
  textColor,
}) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const segments = useMemo(() => {
    const count = 24;
    const radius = size / 2 - 4;
    const center = size / 2;
    const filled = Math.round((safePercent / 100) * count);
    return Array.from({ length: count }, (_, index) => {
      const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
      return {
        left: center + Math.cos(angle) * radius - 1.5,
        top: center + Math.sin(angle) * radius - 2.5,
        rotate: `${(index / count) * 360 + 90}deg`,
        filled: index < filled,
      };
    });
  }, [safePercent, size]);

  return (
    <View style={{ width: size, height: size }}>
      {segments.map((segment, index) => (
        <View
          key={index}
          style={[
            styles.segment,
            {
              left: segment.left,
              top: segment.top,
              height: Math.max(4, size * 0.17),
              backgroundColor: segment.filled ? color : trackColor,
              transform: [{ rotate: segment.rotate }],
            },
          ]}
        />
      ))}
      <View style={styles.center} pointerEvents="none">
        <Text style={[styles.text, { color: textColor }]}>
          {Math.round(safePercent)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  segment: {
    position: 'absolute',
    width: 3,
    borderRadius: 2,
  },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { fontSize: 8, fontWeight: '800' },
});
