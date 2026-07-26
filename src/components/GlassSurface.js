import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSettings } from '../context/SettingsContext';

let GlassView = null;
let liquidGlassAvailable = false;
try {
  // Native iOS 26 Liquid Glass (expo-glass-effect, SDK 54+).
  // eslint-disable-next-line global-require
  const glass = require('expo-glass-effect');
  GlassView = glass.GlassView;
  liquidGlassAvailable =
    typeof glass.isLiquidGlassAvailable === 'function' &&
    glass.isLiquidGlassAvailable();
} catch (e) {
  GlassView = null;
  liquidGlassAvailable = false;
}

/**
 * Adaptive glass surface:
 * - iOS 26+: real Liquid Glass via expo-glass-effect (refraction, specular
 *   highlights, adaptive tint — the system material).
 * - Older iOS / Android: expo-blur frosted-glass simulation with a
 *   translucent overlay, visually consistent with the native variant.
 *
 * Children are rendered on top in both branches; pass `style` for the
 * capsule/bar shape (borderRadius etc.) and `overlayColor` for the
 * fallback's tint wash.
 */
export default function GlassSurface({
  style,
  children,
  intensity = 60,
  overlayColor,
  glassEffectStyle = 'regular',
  tintColor,
}) {
  const { colors } = useSettings();

  if (GlassView && liquidGlassAvailable) {
    return (
      <GlassView
        style={style}
        glassEffectStyle={glassEffectStyle}
        tintColor={tintColor}
        isInteractive={false}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <BlurView
      intensity={Platform.OS === 'ios' ? intensity : Math.min(100, intensity + 40)}
      tint={colors.glassTint}
      style={style}
    >
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: overlayColor || colors.glassOverlay },
        ]}
      />
      {children}
    </BlurView>
  );
}

export { liquidGlassAvailable };
