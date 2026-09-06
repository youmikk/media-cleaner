import * as Battery from 'expo-battery';
import { AppState, Platform } from 'react-native';
import { log } from './logger';

export const NORMAL_CHUNK = 50;
export const LOW_POWER_CHUNK = 10;

let lastLowPower = null;
let memoryWarningCount = 0;

/**
 * Report the initial power state once resolved, unless a newer system event
 * has already arrived, then report changes until unsubscribed.
 */
export function subscribeLowPower(onChange) {
  let sub;
  let active = true;
  let receivedChange = false;
  const report = (lowPower, source) => {
    if (!active) return;
    if (lastLowPower !== lowPower) {
      lastLowPower = lowPower;
      Promise.resolve().then(() => Battery.getPowerStateAsync())
        .then((state) => {
          if (!active) return;
          log(
            'perf',
            `power-state lowPower=${lowPower} battery=${
              state.batteryLevel == null ? '?' : Math.round(state.batteryLevel * 100)
            }% source=${source}`
          );
        })
        .catch(() => {
          if (active) log('perf', `power-state lowPower=${lowPower} source=${source}`);
        });
    }
    onChange(lowPower);
  };
  try {
    sub = Battery.addLowPowerModeListener(({ lowPowerMode }) => {
      receivedChange = true;
      report(!!lowPowerMode, 'change');
    });
  } catch (e) {
    sub = null;
  }
  (async () => {
    try {
      const state = await Battery.getPowerStateAsync();
      // A live system event is newer than this asynchronous startup query.
      if (!receivedChange) report(!!state.lowPowerMode, 'initial');
    } catch (e) {
      if (!receivedChange) report(false, 'initial-failed');
    }
  })();
  return () => {
    active = false;
    try {
      if (sub && sub.remove) sub.remove();
    } catch (e) {
      // A disposed native emitter must not break foreground refresh/cleanup.
    }
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
