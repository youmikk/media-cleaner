import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
  Linking,
  Platform,
  InteractionManager,
} from 'react-native';
import * as PhotoMove from './modules/photo-move';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  NavigationContainer,
  DefaultTheme,
  DarkTheme,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { subscribeMemoryWarning } from './src/utils/batteryUtils';
import { SettingsProvider, useSettings } from './src/context/SettingsContext';
import { AppProvider } from './src/context/AppContext';
import RootNavigator from './src/navigation';
import OnboardingScreen from './src/screens/OnboardingScreen';
import { ensureMediaPermission, getMediaPermission } from './src/utils/permissions';
import * as trashManager from './src/utils/trashManager';
import * as sessionManager from './src/utils/sessionManager';
import { pruneOrphanAlbumKeys } from './src/utils/storageGC';
import {
  autoCheckDaily,
  consumeUpdateApplied,
  APP_VERSION,
} from './src/utils/updateChecker';
import { installLogger } from './src/utils/logger';

// Capture crashes and console errors from the very first frame.
installLogger(APP_VERSION);

const navigationRef = createNavigationContainerRef();
const TUTORIAL_KEY = '@mediacleaner/tutorial_seen';
const ALLFILES_PROMPTED_KEY = '@mediacleaner/allfiles_prompted';

/**
 * Blocks the app behind the media-library permission with a retry prompt.
 */
function PermissionGate({ children }) {
  const { colors, t } = useSettings();
  const [status, setStatus] = useState('pending');

  const request = async () => {
    const result = await ensureMediaPermission();
    setStatus(result);
  };

  useEffect(() => {
    request();
  }, []);

  if (status === 'granted' || status === 'limited') return children;
  // While the check is still in flight, show a blank background — rendering
  // the denial copy here flashes "permission needed" at every launch and
  // right after onboarding hands over.
  if (status === 'pending') {
    return <View style={[styles.gate, { backgroundColor: colors.background }]} />;
  }

  return (
    <View style={[styles.gate, { backgroundColor: colors.background }]}>
      <Ionicons name="images" size={56} color={colors.accent} />
      <Text style={[styles.gateTitle, { color: colors.text }]}>
        {t('permission_title')}
      </Text>
      <Text style={[styles.gateMessage, { color: colors.subtext }]}>
        {status === 'denied' ? t('permission_denied') : t('permission_message')}
      </Text>
      <Pressable
        style={[styles.gateBtn, { backgroundColor: colors.accent }]}
        onPress={request}
      >
        <Text style={styles.gateBtnText}>{t('permission_retry')}</Text>
      </Pressable>
    </View>
  );
}

function AppInner() {
  const { colors, isDark, t, loaded } = useSettings();
  const resumeChecked = useRef(false);
  // null = still reading the flag; true = show the onboarding page.
  const [onboarding, setOnboarding] = useState(null);
  // Post-update permission repair page (permissions-only onboarding).
  const [permRepair, setPermRepair] = useState(false);

  // App init: purge expired recycle-bin items, drop stale soft-delete
  // bookkeeping, and decide whether the first-launch onboarding should show.
  // Low-memory pressure valve: drop expo-image's decoded-bitmap cache the
  // moment the OS warns, instead of letting it OOM-kill the app while the
  // user swipes through a huge library.
  useEffect(() => {
    const unsub = subscribeMemoryWarning(() => {
      ExpoImage.clearMemoryCache().catch(() => {});
    });
    return unsub;
  }, []);

  useEffect(() => {
    trashManager.purgeExpired().catch(() => {});
    AsyncStorage.getItem(TUTORIAL_KEY)
      .then((seen) => setOnboarding(!seen))
      .catch(() => setOnboarding(false));
  }, []);

  // Everything that can pop a dialog waits until onboarding is out of the
  // way — an Alert over the permission/gesture page would be unusable.
  useEffect(() => {
    if (onboarding !== false) return undefined;
    let timer = null;
    // Android, native build: users who upgraded past the onboarding page
    // never saw the "All files access" step — ask them once, here.
    if (Platform.OS === 'android' && PhotoMove.isAvailable()) {
      timer = setTimeout(async () => {
        try {
          if (PhotoMove.hasAllFilesPermission()) return;
          const prompted = await AsyncStorage.getItem(ALLFILES_PROMPTED_KEY);
          if (prompted) return;
          await AsyncStorage.setItem(ALLFILES_PROMPTED_KEY, '1');
          Alert.alert(t('native_move_title'), t('native_move_message'), [
            { text: t('cancel'), style: 'cancel' },
            {
              text: t('native_move_enable'),
              onPress: () => PhotoMove.requestAllFilesPermission(),
            },
          ]);
        } catch (e) {
          // best effort
        }
      }, 3000);
    }
    // Silent once-a-day new-APK check against GitHub Releases.
    autoCheckDaily((info) => {
      Alert.alert(t('update_available', { version: info.version }), '', [
        { text: t('cancel'), style: 'cancel' },
        { text: t('update_download'), onPress: () => Linking.openURL(info.url) },
      ]);
    });
    // Reclaim per-album cache entries for albums that no longer exist.
    // Idle-time only: it walks every storage key.
    const gc = InteractionManager.runAfterInteractions(() => {
      pruneOrphanAlbumKeys().catch(() => {});
    });
    return () => {
      if (timer) clearTimeout(timer);
      if (gc && gc.cancel) gc.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarding]);

  // The onboarding page already asked for "All files access", so mark it as
  // prompted — the legacy Alert above must never double-ask.
  const finishOnboarding = () => {
    setOnboarding(false);
    AsyncStorage.multiSet([
      [TUTORIAL_KEY, '1'],
      [ALLFILES_PROMPTED_KEY, '1'],
    ]).catch(() => {});
  };

  // An OTA update can land at any time, including while the app sits in the
  // background — and a user may well have revoked access in the meantime.
  // The first launch on a new bundle therefore audits permissions once and,
  // if anything is missing, reopens the onboarding page in permissions-only
  // mode. consumeUpdateApplied() is true exactly once per update, so this
  // never turns into a recurring nag.
  useEffect(() => {
    if (onboarding !== false) return;
    let alive = true;
    (async () => {
      try {
        if (!(await consumeUpdateApplied())) return;
        const media = await getMediaPermission();
        const filesOk =
          Platform.OS !== 'android' ||
          !PhotoMove.isAvailable() ||
          PhotoMove.hasAllFilesPermission();
        const mediaOk = media === 'granted' || media === 'limited';
        if (alive && (!mediaOk || !filesOk)) setPermRepair(true);
      } catch (e) {
        // never block startup on the audit
      }
    })();
    return () => {
      alive = false;
    };
  }, [onboarding]);

  // Unfinished-session prompt: resume restores the cleaning flow at the last
  // group; discard clears the snapshot.
  const checkPendingSession = async () => {
    if (resumeChecked.current) return;
    resumeChecked.current = true;
    const session = await sessionManager.getPendingSession('video');
    if (!session) return;
    // Paused PHOTO sessions are normal now (exit = pause): the home cards
    // show the current group and resume silently — no launch prompt.
    if (session.type === 'photo') return;
    Alert.alert(t('resume_title'), t('resume_message'), [
      {
        text: t('discard'),
        style: 'destructive',
        onPress: () => sessionManager.discardSession('video'),
      },
      {
        text: t('resume'),
        onPress: () => {
          if (!navigationRef.isReady()) return;
          if (session.type === 'video') {
            navigationRef.navigate('VideosTab');
          } else {
            navigationRef.navigate('PhotosTab', {
              screen: 'Cleaning',
              params: {
                albumId: session.albumId,
                albumTitle: session.albumTitle,
                assetIds: session.assetIds || null,
                timeRange: session.timeRange || null,
                resume: true, // restore exact order, group, position & marks
              },
            });
          }
        },
      },
    ]);
  };

  const navTheme = {
    ...(isDark ? DarkTheme : DefaultTheme),
    colors: {
      ...(isDark ? DarkTheme.colors : DefaultTheme.colors),
      background: colors.background,
      card: colors.card,
      text: colors.text,
      primary: colors.accent,
    },
  };

  if (!loaded || onboarding === null) return null;

  // Onboarding replaces the whole app shell: permission first, gestures
  // after — no navigator, no background dialogs behind it.
  if (onboarding) {
    return (
      <>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <OnboardingScreen onDone={finishOnboarding} />
      </>
    );
  }

  // Same page, permissions step only — shown once after an OTA update if
  // access has gone missing.
  if (permRepair) {
    return (
      <>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <OnboardingScreen mode="permissions" onDone={() => setPermRepair(false)} />
      </>
    );
  }

  return (
    <PermissionGate>
      <NavigationContainer
        ref={navigationRef}
        theme={navTheme}
        onReady={checkPendingSession}
      >
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <RootNavigator />
      </NavigationContainer>
    </PermissionGate>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SettingsProvider>
          <AppProvider>
            <AppInner />
          </AppProvider>
        </SettingsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  gate: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  gateTitle: { fontSize: 22, fontWeight: '800', marginTop: 18 },
  gateMessage: {
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: 10,
  },
  gateBtn: {
    marginTop: 24,
    borderRadius: 14,
    paddingHorizontal: 32,
    paddingVertical: 13,
  },
  gateBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
