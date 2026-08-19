import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { palettes } from '../theme';
import { translate, detectDeviceLanguage } from '../i18n';

const STORAGE_KEY = '@mediacleaner/settings';

export const DEFAULT_SETTINGS = {
  groupSize: 5, // PHOTOS per group: 5 | 10 | 15 | 20
  videoGroupSize: 5, // VIDEOS per group: 5 | 10 | 15 | 20
  order: 'random', // 'random' | 'date' (default: random)
  similarDetection: true,
  liveAutoplay: true, // iOS: auto-play Live Photos in the cleaning flow
  liveMuted: true, // iOS: mute Live Photo playback
  recycleBin: false, // Android only; direct deletion is the default
  dailyReminder: false,
  reminderHour: 19,
  // Recycle-bin browsing: 'list' is the detailed row layout, 'grid' the
  // thumbnail wall. Persisted so the choice survives leaving the screen.
  recycleView: 'list',
  recycleColumns: 3,
  favoriteView: 'grid',
  favoriteColumns: 3,
  theme: 'system', // 'system' | 'light' | 'dark'
  language: 'system', // 'system' (follow device) | 'zh' | 'en'
};

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const writeChainRef = useRef(Promise.resolve());
  const systemScheme = useColorScheme();

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
      } catch (e) {
        // corrupted settings -> fall back to defaults
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const setSetting = useCallback((key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const payload = JSON.stringify(settings);
    // Preserve call order: rapid toggles must not let an older AsyncStorage
    // write finish last and become the state seen after a process restart.
    writeChainRef.current = writeChainRef.current
      .catch(() => {})
      .then(() => AsyncStorage.setItem(STORAGE_KEY, payload));
  }, [loaded, settings]);

  const language =
    settings.language && settings.language !== 'system'
      ? settings.language
      : detectDeviceLanguage(); // default: follow the system language
  const isDark =
    settings.theme === 'dark' ||
    (settings.theme === 'system' && systemScheme === 'dark');
  const colors =
    Platform.OS === 'android'
      ? isDark
        ? palettes.androidDark
        : palettes.androidLight
      : isDark
        ? palettes.dark
        : palettes.light;

  const t = useCallback(
    (key, params) => translate(language, key, params),
    [language]
  );

  const value = useMemo(
    () => ({
      settings,
      setSetting,
      loaded,
      colors,
      isDark,
      language,
      t,
      isAndroid: Platform.OS === 'android',
      recycleBinActive: Platform.OS === 'android' && settings.recycleBin,
    }),
    [settings, setSetting, loaded, colors, isDark, language, t]
  );

  return (
    <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
