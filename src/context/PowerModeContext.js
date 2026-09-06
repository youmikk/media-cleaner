import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { useSettings } from './SettingsContext';
import { subscribeLowPower } from '../utils/batteryUtils';
import analyzer from '../utils/chunkedAnalyzer';

const PowerModeContext = createContext({
  lowPower: false, adaptiveLowPower: false, active: true,
});

export function PowerModeProvider({ children }) {
  const { settings } = useSettings();
  const [lowPower, setLowPower] = useState(false);
  const [active, setActive] = useState(AppState.currentState == null || AppState.currentState === 'active');

  useEffect(() => {
    let live = true;
    let generation = 0;
    let stopPower = () => {};
    const refresh = () => {
      const read = ++generation;
      stopPower();
      // Preserve the last known state while refreshing. A temporary reset on
      // every foreground would show duplicate notices and switch quality twice.
      stopPower = subscribeLowPower((value) => {
        if (live && read === generation) setLowPower(value);
      });
    };
    refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      setActive(state === 'active');
      if (state === 'active') refresh();
    });
    return () => {
      live = false;
      stopPower();
      subscription.remove();
    };
  }, []);

  const adaptiveLowPower = lowPower && settings.adaptiveLowPower !== false;
  useEffect(() => {
    analyzer.setLowPowerMode(adaptiveLowPower);
  }, [adaptiveLowPower]);

  const value = useMemo(() => ({ lowPower, adaptiveLowPower, active }), [lowPower, adaptiveLowPower, active]);
  return <PowerModeContext.Provider value={value}>{children}</PowerModeContext.Provider>;
}

export function usePowerMode() {
  return useContext(PowerModeContext);
}
