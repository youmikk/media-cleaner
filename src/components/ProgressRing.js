import React, { useMemo } from 'react';
import { PixelRatio, View, Text, StyleSheet } from 'react-native';

/** Compact segmented ring that works in Expo Go and older binaries. */
function ProgressRing({
  percent = 0,
  size = 30,
  color,
  trackColor,
  textColor,
}) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const dots = useMemo(() => {
    // Native circles are antialiased. Aligning their geometry to physical
    // pixels removes the uneven blur seen on mdpi Android, while a small
    // overlap keeps the arc continuous without 48 child views per ring.
    const count = Math.max(32, Math.round(size * 1.1));
    const radiusEstimate = size / 2 - size * 0.075;
    const dotSize = PixelRatio.roundToNearestPixel(
      Math.max(1.5, (2 * Math.PI * radiusEstimate * 1.18) / count)
    );
    const radius = size / 2 - dotSize;
    const center = size / 2;
    return Array.from({ length: count }, (_, index) => {
      const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
      return {
        left: PixelRatio.roundToNearestPixel(
          center + Math.cos(angle) * radius - dotSize / 2
        ),
        top: PixelRatio.roundToNearestPixel(
          center + Math.sin(angle) * radius - dotSize / 2
        ),
        size: dotSize,
      };
    });
  }, [size]);
  const filled = Math.round((safePercent / 100) * dots.length);

  return (
    <View
      style={{ width: size, height: size }}
      accessibilityRole="progressbar"
      accessibilityValue={{
        min: 0,
        max: 100,
        now: Math.round(safePercent),
        text: `${Math.round(safePercent)}%`,
      }}
    >
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

export default React.memo(ProgressRing);

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
