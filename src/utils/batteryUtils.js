import * as Battery from 'expo-battery';
import { AppState, Platform } from 'react-native';

export const NORMAL_CHUNK = 50;
export const LOW_POWER_CHUNK = 10;

/**
 * Subscribe to power-state changes. Calls `onChange(isLowPower)` immediately
 * with the current state and on every change. Returns an unsubscribe fn.
 */
export function subscribeLowPower(onChange) {
  let sub;
  (async () => {
    try {
      const state = await Battery.getPowerStateAsync();
      onChange(!!state.lowPowerMode);
    } catch (e) {
      onChange(false);
    }
  })();
  try {
    sub = Battery.addLowPowerModeListener(({ lowPowerMode }) => {
      onChange(!!lowPowerMode);
    });
  } catch (e) {
    sub = null;
  }
  return () => {
    if (sub && sub.remove) sub.remove();
  };
}

/**
 * Subscribe to iOS memory warnings (no-op elsewhere).
 * Returns an unsubscribe fn.
 */
export function subscribeMemoryWarning(onWarning) {
  if (Platform.OS !== 'ios') return () => {};
  try {
    const sub = AppState.addEventListener('memoryWarning', onWarning);
    return () => sub && sub.remove && sub.remove();
  } catch (e) {
    return () => {};
  }
}

export function chunkSizeFor(lowPower) {
  return lowPower ? LOW_POWER_CHUNK : NORMAL_CHUNK;
}
