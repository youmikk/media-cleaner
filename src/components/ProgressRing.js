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
  const dots = useMemo(() => {
    // Fractional positions let the compositor antialias the curve. Dot size
    // is derived from the circumference so neighbours overlap slightly and
    // produce a continuous ring even at the 24px picker size.
    const count = 48;
    const radiusEstimate = size / 2 - size * 0.075;
    const dotSize = Math.max(1.5, (2 * Math.PI * radiusEstimate * 1.15) / count);
    const radius = size / 2 - dotSize;
    const center = size / 2;
    return Array.from({ length: count }, (_, index) => {
      const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
      return {
        left: center + Math.cos(angle) * radius - dotSize / 2,
        top: center + Math.sin(angle) * radius - dotSize / 2,
        size: dotSize,
      };
    });
  }, [size]);
  const filled = Math.round((safePercent / 100) * dots.length);

  return (
    <View style={{ width: size, height: size }}>
      {dots.map((dot, index) => (
        <View
          key={index}
          style={[
            styles.dot,
            {
              left: dot.left,
              top: dot.top,
              width: dot.size,
              height: dot.size,
              borderRadius: dot.size / 2,
              backgroundColor: index < filled ? color : trackColor,
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
  dot: {
    position: 'absolute',
  },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { fontSize: 8, fontWeight: '800' },
});
