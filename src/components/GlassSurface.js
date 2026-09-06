import React from 'react';
import { View, StyleSheet, Platform, processColor } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSettings } from '../context/SettingsContext';
import { useGlassEffects } from '../context/GlassEffectsContext';
import { NativeGlassView, androidLiquidGlassAvailable } from '../../modules/liquid-glass';
import { log } from '../utils/logger';

let GlassView = null;
let liquidGlassAvailable = false;
try {
  if (Platform.OS === 'ios') {
    const glass = require('expo-glass-effect');
    GlassView = glass.GlassView;
    // Availability alone is insufficient on some iOS 26 builds. A missing
    // runtime guard in an old binary is also a reason to use the blur fallback.
    liquidGlassAvailable =
      typeof glass.isLiquidGlassAvailable === 'function' &&
      typeof glass.isGlassEffectAPIAvailable === 'function' &&
      glass.isLiquidGlassAvailable() && glass.isGlassEffectAPIAvailable();
  }
} catch (e) {
  GlassView = null;
  liquidGlassAvailable = false;
}

/**
 * Adaptive glass surface:
 * - iOS 26+: real Liquid Glass via expo-glass-effect (refraction, specular
 *   highlights, adaptive tint — the system material).
 * - Older iOS: expo-blur frosted-glass simulation with a translucent overlay.
 * - Android 13+: Kyant0/AndroidLiquidGlass lens + highlight shaders.
 * - Missing Android renderer: bounded expo-blur fallback on explicit sources.
 * - Power adaptation: lower Android capture quality; native iOS material.
 * - Reduced transparency and memory pressure: solid app surface.
 *
 * The root and content never change type when an effect changes. Losing a
 * material must not remount controls, reset scroll or recreate a video player.
 */
export default function GlassSurface({
  style,
  children,
  intensity = 60,
  overlayColor,
  glassEffectStyle = 'regular',
  tintColor,
  androidSource,
  effectEnabled = true,
  onLayout,
}) {
  const { colors, isDark, settings } = useSettings();
  const { effectsEnabled, lowPower } = useGlassEffects();
  const surfaceStyle = StyleSheet.flatten(style);
  const radius = surfaceStyle?.borderRadius || 0;
  const borderCurve = Platform.OS === 'ios' ? surfaceStyle?.borderCurve || 'continuous' : undefined;
  const surfaceTint = tintColor || overlayColor || colors.liquidTint;
  const androidTint = processColor(surfaceTint) ?? processColor(colors.elevated) ?? 0;
  const androidFallback = processColor(colors.elevated) ?? 0;
  const androidHighlight = processColor(colors.glassHighlight) ?? 0;
  const androidShadow = processColor(colors.glassShadow) ?? 0;
  const layerStyle = [StyleSheet.absoluteFill, { borderRadius: radius, borderCurve }];
  const showEffect = effectsEnabled && effectEnabled;
  const nativeIOSGlass = Platform.OS === 'ios' && GlassView && liquidGlassAvailable;
  const nativeAndroidGlass =
    Platform.OS === 'android' && androidSource && androidLiquidGlassAvailable && NativeGlassView;
  let material = null;

  if (nativeAndroidGlass) {
    material = (
      <NativeGlassView
        key="android-glass"
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        style={layerStyle}
        sourceKey={androidSource}
        effectEnabled={showEffect && settings.androidLiquidGlass !== false}
        lowPowerMode={!!lowPower}
        cornerRadius={radius}
        surfaceTint={androidTint}
        fallbackColor={androidFallback}
        highlightColor={androidHighlight}
        shadowColor={androidShadow}
        onStatus={reportAndroidGlassStatus}
      />
    );
  } else if (showEffect && settings.androidLiquidGlass !== false &&
    Platform.OS === 'android' && androidSource) {
    // Expo Go and older installed binaries do not contain the app-owned AGSL
    // module. expo-blur is still available there, so keep the navigation
    // surface visibly translucent until a native build is installed.
    material = (
      <BlurView
        pointerEvents="none"
        intensity={Math.min(lowPower ? 24 : 70, intensity)}
        tint={colors.glassTint}
        experimentalBlurMethod="dimezisBlurView"
        style={layerStyle}
      >
        <View style={[StyleSheet.absoluteFill, { backgroundColor: surfaceTint }]} />
      </BlurView>
    );
  } else if (showEffect && nativeIOSGlass) {
    material = (
      <GlassView
        pointerEvents="none"
        accessible={false}
        accessibilityElementsHidden
        style={layerStyle}
        borderRadius={radius}
        glassEffectStyle={glassEffectStyle}
        // UIGlassEffect supplies its own adaptive tint. Painting the Android
        // surface tint into it made the native material look nearly opaque.
        tintColor={tintColor || overlayColor}
        colorScheme={isDark ? 'dark' : 'light'}
        // The bar contains several independent controls. Stretching its whole
        // material on each press competes with their own selection feedback.
        isInteractive={false}
      />
    );
  } else if (showEffect && Platform.OS === 'ios') {
    material = (
      <BlurView pointerEvents="none" intensity={intensity} tint={colors.glassTint} style={layerStyle}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: surfaceTint }]} />
      </BlurView>
    );
  }

  return (
    <View onLayout={onLayout} style={[style, styles.clip]}>
      {/* Keep the fallback behind the controls only when no material mounted. */}
      {!material && (
        <View key="fallback" pointerEvents="none" style={[layerStyle, { backgroundColor: colors.elevated }]} />
      )}
      {material}
      {children}
    </View>
  );
}

function reportAndroidGlassStatus(event) {
  const { state, reason, sourceKey } = event.nativeEvent || {};
  // Native emits transitions only, never a per-frame log or media information.
  log('glass', `android state=${state} reason=${reason} source=${sourceKey || 'unknown'}`);
}

const styles = StyleSheet.create({ clip: { overflow: 'hidden' } });
export { liquidGlassAvailable };
