import React from 'react';
import { StyleSheet, View } from 'react-native';
import { NativeGlassSource, androidLiquidGlassAvailable } from '../../modules/liquid-glass';

/** Wrap only the scene, never its floating glass overlay (no self-sampling). */
export default function GlassBackdrop({ sourceKey, style, contentStyle, children }) {
  const Source = androidLiquidGlassAvailable && NativeGlassSource ? NativeGlassSource : View;
  return (
    <Source
      style={[styles.fill, style]}
      {...(Source === NativeGlassSource ? { sourceKey } : {})}
      collapsable={false}
    >
      <View style={[styles.fill, contentStyle]}>{children}</View>
    </Source>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
