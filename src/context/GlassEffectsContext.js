import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, AppState, Platform } from 'react-native';
import { subscribeLowPower } from '../utils/batteryUtils';

const GlassEffectsContext = createContext({ effectsEnabled: false, reduceMotion: true });

// One subscription for the whole application, not one battery/a11y listener
// per card. The first frame remains visible while system preferences load.
export function GlassEffectsProvider({ children }) {
  // Start with effects on. The async system preference reads below may turn
  // them off, but a missing API in Expo Go/older binaries must not leave the
  // entire app permanently opaque.
  const [lowPower, setLowPower] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(true);
  const [reduceTransparency, setReduceTransparency] = useState(false);
  // AppState.currentState can be null during bridge startup even though the
  // app is already visible. Treat that startup window as active.
  const [active, setActive] = useState(AppState.currentState == null || AppState.currentState === 'active');
  const [memoryLimited, setMemoryLimited] = useState(false);

  useEffect(() => {
    let live = true;
    let preferenceRead = 0;
    let powerRead = 0;
    let stopPower = () => {};
    const subscriptions = [];
    const refreshPower = () => {
      const read = ++powerRead;
      setLowPower(true);
      stopPower();
      stopPower = subscribeLowPower((value) => {
        if (live && read === powerRead) setLowPower(value);
      });
    };
    const readPreferences = () => {
      const read = ++preferenceRead;
      Promise.allSettled([
        typeof AccessibilityInfo.isReduceMotionEnabled === 'function'
          ? Promise.resolve().then(() => AccessibilityInfo.isReduceMotionEnabled())
          : Promise.resolve(false),
        Platform.OS === 'ios' && typeof AccessibilityInfo.isReduceTransparencyEnabled === 'function'
          ? Promise.resolve().then(() => AccessibilityInfo.isReduceTransparencyEnabled())
          : Promise.resolve(false),
      ]).then(([motion, transparency]) => {
        if (live && read === preferenceRead) {
          // Read independently: a failed motion query must not overwrite a
          // successfully read Reduce Transparency preference (or vice versa).
          // Failed reads keep the last known value until the next refresh.
          if (motion.status === 'fulfilled') setReduceMotion(!!motion.value);
          if (transparency.status === 'fulfilled') setReduceTransparency(!!transparency.value);
        }
      });
    };
    const listen = (emitter, event, handler) => {
      try {
        subscriptions.push(emitter.addEventListener(event, handler));
      } catch (e) {
        // Some accessibility notifications are not implemented on Android.
      }
    };
    readPreferences();
    refreshPower();
    listen(AccessibilityInfo, 'reduceMotionChanged', () => readPreferences());
    if (Platform.OS === 'ios') {
      listen(AccessibilityInfo, 'reduceTransparencyChanged', () => readPreferences());
    }
    listen(AppState, 'change', (state) => {
      setActive(state === 'active');
      if (state === 'active') {
        setMemoryLimited(false);
        readPreferences();
        refreshPower();
      }
    });
    listen(AppState, 'memoryWarning', () => setMemoryLimited(true));
    return () => {
      live = false;
      stopPower();
      subscriptions.forEach((subscription) => {
        try {
          subscription?.remove();
        } catch (e) {
          // A torn-down native emitter must not turn visual cleanup into a crash.
        }
      });
    };
  }, []);

  const value = useMemo(() => ({
    effectsEnabled: active && !lowPower && !reduceTransparency && !memoryLimited,
    reduceMotion,
  }), [active, lowPower, reduceTransparency, memoryLimited, reduceMotion]);

  return <GlassEffectsContext.Provider value={value}>{children}</GlassEffectsContext.Provider>;
}

export function useGlassEffects() {
  return useContext(GlassEffectsContext);
}
