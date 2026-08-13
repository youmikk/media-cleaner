import * as Battery from 'expo-battery';
import { AppState, Platform } from 'react-native';
import { log } from './logger';

export const NORMAL_CHUNK = 50;
export const LOW_POWER_CHUNK = 10;

let lastLowPower = null;
let memoryWarningCount = 0;

/**
 * Subscribe to power-state changes. Calls `onChange(isLowPower)` immediately
 * with the current state and on every change. Returns an unsubscribe fn.
 */
export function subscribeLowPower(onChange) {
  let sub;
  const report = (lowPower, source) => {
    if (lastLowPower !== lowPower) {
      lastLowPower = lowPower;
      Battery.getPowerStateAsync()
        .then((state) => {
          log(
            'perf',
            `power-state lowPower=${lowPower} battery=${
              state.batteryLevel == null ? '?' : Math.round(state.batteryLevel * 100)
            }% source=${source}`
          );
        })
        .catch(() => log('perf', `power-state lowPower=${lowPower} source=${source}`));
    }
    onChange(lowPower);
  };
  (async () => {
    try {
      const state = await Battery.getPowerStateAsync();
      report(!!state.lowPowerMode, 'initial');
    } catch (e) {
      report(false, 'initial-failed');
    }
  })();
  try {
    sub = Battery.addLowPowerModeListener(({ lowPowerMode }) => {
      report(!!lowPowerMode, 'change');
    });
  } catch (e) {
    sub = null;
  }
  return () => {
    if (sub && sub.remove) sub.remove();
  };
}

/**
 * Subscribe to memory warnings. Android may not emit this event on every
 * device, but registering it costs nothing and gives us a field signal when
 * the platform does report pressure.
 * Returns an unsubscribe fn.
 */
export function subscribeMemoryWarning(onWarning) {
  try {
    const sub = AppState.addEventListener('memoryWarning', () => {
      memoryWarningCount += 1;
      log('perf', `memory-warning count=${memoryWarningCount} platform=${Platform.OS}`);
      onWarning();
    });
    return () => sub && sub.remove && sub.remove();
  } catch (e) {
    return () => {};
  }
}

export function chunkSizeFor(lowPower) {
  return lowPower ? LOW_POWER_CHUNK : NORMAL_CHUNK;
}
