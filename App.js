import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
  Linking,
  Platform,
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
import TutorialOverlay from './src/components/TutorialOverlay';
import { ensureMediaPermission } from './src/utils/permissions';
import * as trashManager from './src/utils/trashManager';
import * as sessionManager from './src/utils/sessionManager';
import { autoCheckDaily } from './src/utils/updateChecker';

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
  const [showTutorial, setShowTutorial] = useState(false);

  // App init: purge expired recycle-bin items, drop stale soft-delete
  // bookkeeping, and decide whether the first-launch tutorial should show.
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
      .then((seen) => {
        if (!seen) setShowTutorial(true);
      })
      .catch(() => {});
    // FIRST LAUNCH (Android, native build): ask for "All files access" up
    // front — categorizing moves photos in place and needs it. Delayed so
    // it never fights the media-permission dialog; asked only once.
    if (Platform.OS === 'android' && PhotoMove.isAvailable()) {
      setTimeout(async () => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismissTutorial = () => {
    setShowTutorial(false);
    AsyncStorage.setItem(TUTORIAL_KEY, '1').catch(() => {});
  };

  // Unfinished-session prompt: resume restores the cleaning flow at the last
  // group; discard clears the snapshot.
  const checkPendingSession = async () => {
    if (resumeChecked.current) return;
    resumeChecked.current = true;
    const session = await sessionManager.getPendingSession();
    if (!session) return;
    // Paused PHOTO sessions are normal now (exit = pause): the home cards
    // show the current group and resume silently — no launch prompt.
    if (session.type === 'photo') return;
    Alert.alert(t('resume_title'), t('resume_message'), [
      {
        text: t('discard'),
        style: 'destructive',
        onPress: () => sessionManager.discardSession(),
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

  if (!loaded) return null;

  return (
    <PermissionGate>
      <NavigationContainer
        ref={navigationRef}
        theme={navTheme}
        onReady={checkPendingSession}
      >
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <RootNavigator />
        <TutorialOverlay visible={showTutorial} onDone={dismissTutorial} />
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
