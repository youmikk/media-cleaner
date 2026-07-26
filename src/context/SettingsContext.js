import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Platform, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { palettes } from '../theme';
import { translate } from '../i18n';

const STORAGE_KEY = '@mediacleaner/settings';

export const DEFAULT_SETTINGS = {
  groupSize: 5, // global group size: 5 | 10 | 15 | 20
  order: 'random', // 'random' | 'date' (default: random)
  similarDetection: true,
  recycleBin: true, // Android only
  dailyReminder: false,
  theme: 'system', // 'system' | 'light' | 'dark'
  language: null, // null -> 中文 (default)
};

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
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
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const language = settings.language || 'zh'; // default 中文
  const isDark =
    settings.theme === 'dark' ||
    (settings.theme === 'system' && systemScheme === 'dark');
  const colors = isDark ? palettes.dark : palettes.light;

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
