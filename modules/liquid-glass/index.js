import { Platform } from 'react-native';

let NativeGlassView = null;
let NativeGlassSource = null;

// Expo Go, iOS and binaries built before this module must never attempt to
// mount an unknown native view. Availability is fixed for this app process.
try {
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    const { requireNativeModule, requireNativeViewManager } = require('expo-modules-core');
    const native = requireNativeModule('MediaCleanerLiquidGlass');
    if (typeof native.isSupported === 'function' && native.isSupported()) {
      NativeGlassView = requireNativeViewManager('MediaCleanerLiquidGlass', 'GlassView');
      NativeGlassSource = requireNativeViewManager('MediaCleanerLiquidGlass', 'GlassSource');
    }
  }
} catch (e) {
  // Optional visual enhancement: the app-owned solid surface remains usable.
  NativeGlassView = null;
  NativeGlassSource = null;
}

export { NativeGlassView, NativeGlassSource };
export const androidLiquidGlassAvailable = !!(NativeGlassView && NativeGlassSource);
