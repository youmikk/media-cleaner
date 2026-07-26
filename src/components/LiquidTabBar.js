import React from 'react';
import { View, Pressable, Text, StyleSheet, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';

const HIDDEN_ROUTES = ['Cleaning', 'VideoCleaning', 'BurstClean', 'RecycleBin'];

const ICONS = {
  PhotosTab: ['images-outline', 'images'],
  VideosTab: ['videocam-outline', 'videocam'],
  ProfileTab: ['person-circle-outline', 'person-circle'],
};

/**
 * Floating "liquid glass" capsule tab bar. Hides itself while a cleaning
 * screen (which shows its own floating info bar) is focused.
 */
export default function LiquidTabBar({ state, descriptors, navigation }) {
  const { colors, t } = useSettings();
  const insets = useSafeAreaInsets();

  const focusedRoute = state.routes[state.index];
  const nestedState = focusedRoute.state;
  const nestedName =
    nestedState && nestedState.routes
      ? nestedState.routes[nestedState.index ?? nestedState.routes.length - 1]
          ?.name
      : null;
  if (HIDDEN_ROUTES.includes(nestedName)) return null;

  const labels = {
    PhotosTab: t('tab_photos'),
    VideosTab: t('tab_videos'),
    ProfileTab: t('tab_profile'),
  };

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: Math.max(insets.bottom, 12) }]}
    >
      <BlurView
        intensity={Platform.OS === 'ios' ? 60 : 100}
        tint={colors.glassTint}
        style={[styles.capsule, { borderColor: colors.border }]}
      >
        <View
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.glassOverlay }]}
        />
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const [outline, filled] = ICONS[route.name] || ICONS.PhotosTab;
          return (
            <Pressable
              key={route.key}
              onPress={() => {
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!focused && !event.defaultPrevented) {
                  navigation.navigate(route.name);
                }
              }}
              style={styles.tab}
              accessibilityRole="button"
              accessibilityState={focused ? { selected: true } : {}}
            >
              <Ionicons
                name={focused ? filled : outline}
                size={24}
                color={focused ? colors.accent : colors.subtext}
              />
              <Text
                style={[
                  styles.label,
                  { color: focused ? colors.accent : colors.subtext },
                ]}
              >
                {labels[route.name]}
              </Text>
            </Pressable>
          );
        })}
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  capsule: {
    flexDirection: 'row',
    borderRadius: 32,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  tab: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
    paddingVertical: 4,
  },
  label: {
    fontSize: 11,
    marginTop: 2,
    fontWeight: '600',
  },
});
