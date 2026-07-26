import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, Linking } from 'react-native';
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
  useEffect(() => {
    trashManager.purgeExpired().catch(() => {});
    AsyncStorage.getItem(TUTORIAL_KEY)
      .then((seen) => {
        if (!seen) setShowTutorial(true);
      })
      .catch(() => {});
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
