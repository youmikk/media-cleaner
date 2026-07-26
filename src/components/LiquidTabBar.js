import React from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';
import GlassSurface from './GlassSurface';

const HIDDEN_ROUTES = ['Cleaning', 'VideoCleaning', 'BurstClean', 'RecycleBin'];

const ICONS = {
  PhotosTab: ['images-outline', 'images'],
  VideosTab: ['videocam-outline', 'videocam'],
  ProfileTab: ['person-circle-outline', 'person-circle'],
};

/**
 * Floating capsule tab bar. On iOS 26 this is REAL Liquid Glass
 * (expo-glass-effect); elsewhere it falls back to an expo-blur frosted
 * capsule. Hides itself while a cleaning screen is focused.
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
  // The Videos tab IS a cleaning screen (direct access) — hide the tab bar
  // there too; its own floating info bar takes over.
  if (focusedRoute.name === 'VideosTab' || HIDDEN_ROUTES.includes(nestedName))
    return null;

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
      <GlassSurface style={[styles.capsule, { borderColor: colors.border }]}>
        <View style={styles.row}>
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
        </View>
      </GlassSurface>
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
    borderRadius: 32,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
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
