import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, AppState, Platform } from 'react-native';
import { subscribeLowPower } from '../utils/batteryUtils';

const GlassEffectsContext = createContext({ effectsEnabled: false, reduceMotion: true });

// One subscription for the whole application, not one battery/a11y listener
// per card. Start conservatively while the system preferences are loading.
export function GlassEffectsProvider({ children }) {
  const [lowPower, setLowPower] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(true);
  const [reduceTransparency, setReduceTransparency] = useState(Platform.OS === 'ios');
  const [active, setActive] = useState(AppState.currentState === 'active');
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
      Promise.all([
        Promise.resolve().then(() => AccessibilityInfo.isReduceMotionEnabled()),
        Platform.OS === 'ios'
          ? Promise.resolve().then(() => AccessibilityInfo.isReduceTransparencyEnabled())
          : Promise.resolve(false),
      ]).then(([motion, transparency]) => {
        if (live && read === preferenceRead) {
          setReduceMotion(!!motion);
          setReduceTransparency(!!transparency);
        }
      }).catch(() => {
        // Include synchronous throws/missing methods from older binaries, and
        // stop effects if the preferences can no longer be read on foreground.
        if (live && read === preferenceRead) {
          setReduceMotion(true);
          setReduceTransparency(Platform.OS === 'ios');
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
