import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
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
import { ensureMediaPermission } from './src/utils/permissions';
import * as trashManager from './src/utils/trashManager';
import * as sessionManager from './src/utils/sessionManager';
import { recoverPending } from './src/utils/deletionManager';

const navigationRef = createNavigationContainerRef();

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

  // App init: purge expired recycle-bin items, drop stale soft-delete
  // bookkeeping from a killed session.
  useEffect(() => {
    trashManager.purgeExpired().catch(() => {});
    recoverPending();
  }, []);

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
          const params = {
            albumId: session.albumId,
            albumTitle: session.albumTitle,
            groupSize: session.groupSize,
            assetIds: session.assetIds || null,
            resumeGroupIndex: session.groupIndex || 0,
          };
          if (session.type === 'video') {
            navigationRef.navigate('VideosTab', {
              screen: 'VideoCleaning',
              params,
            });
          } else {
            navigationRef.navigate('PhotosTab', {
              screen: 'Cleaning',
              params,
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
      </NavigationContainer>
    </PermissionGate>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <AppProvider>
          <AppInner />
        </AppProvider>
      </SettingsProvider>
    </SafeAreaProvider>
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
