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
 * - Older iOS: expo-blur frosted-glass simulation with a translucent overlay.
 * - Android: an opaque app-owned elevated surface; OEM blur is intentionally
 *   avoided so the visual language stays stable across manufacturers.
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
  interactive = false, // iOS 26: press/long-press glass response
}) {
  const { colors } = useSettings();

  // Android uses the app's own solid surface. OEM blur implementations vary
  // heavily in colour, clipping and performance, which made the same control
  // look unrelated across Xiaomi, vivo and stock Android devices.
  if (Platform.OS === 'android') {
    return (
      <View style={[style, { backgroundColor: colors.elevated }]}>
        {children}
      </View>
    );
  }

  if (GlassView && liquidGlassAvailable) {
    return (
      <GlassView
        style={style}
        glassEffectStyle={glassEffectStyle}
        tintColor={tintColor}
        isInteractive={interactive}
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
