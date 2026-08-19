import React, { useEffect, useRef } from 'react';
import {
  Platform,
  View,
  Pressable,
  Text,
  StyleSheet,
  PanResponder,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';
import GlassSurface from './GlassSurface';

const HIDDEN_ROUTES = [
  'Cleaning',
  'SmartCleaning',
  'VideoCleaning',
  'Favorites',
  'BurstClean',
  'RecycleBin',
  'Compress',
  'Insights',
];

const ICONS = {
  PhotosTab: ['images-outline', 'images'],
  VideosTab: ['videocam-outline', 'videocam'],
  ProfileTab: ['person-circle-outline', 'person-circle'],
};

const TAB_W = 92; // fixed tab width so the sliding pill lines up exactly
const PILL_INSET = 6;

/**
 * Floating capsule tab bar. On iOS 26 the surface is REAL Liquid Glass;
 * a translucent selection pill SLIDES (spring) to the active tab on every
 * switch — the iOS 26 tab-bar interaction. Hides on cleaning screens.
 */
export default function LiquidTabBar({ state, descriptors, navigation }) {
  const { colors, t } = useSettings();
  const insets = useSafeAreaInsets();

  // Sliding selection pill.
  const pillX = useSharedValue(state.index * TAB_W);
  useEffect(() => {
    pillX.value = withSpring(state.index * TAB_W, {
      damping: 28,
      stiffness: 260,
      overshootClamping: true, // slide fast, but never past the target tab
    });
  }, [state.index, pillX]);
  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pillX.value }],
  }));

  // iOS 26 tab-bar slide interaction: drag a finger ACROSS the capsule —
  // the pill follows live, and releasing switches to the hovered tab.
  const barStateRef = useRef({});
  barStateRef.current = { index: state.index, routes: state.routes, navigation };
  const dragIndexRef = useRef(null);
  const slidePan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (e) => {
        const { routes } = barStateRef.current;
        const x = e.nativeEvent.locationX - 10; // row's horizontal padding
        const idx = Math.min(
          routes.length - 1,
          Math.max(0, Math.floor(x / TAB_W))
        );
        if (dragIndexRef.current !== idx) {
          dragIndexRef.current = idx;
          pillX.value = withSpring(idx * TAB_W, {
            damping: 28,
            stiffness: 320,
            overshootClamping: true,
          });
        }
      },
      onPanResponderRelease: () => {
        const { index, routes, navigation: nav } = barStateRef.current;
        const idx = dragIndexRef.current;
        dragIndexRef.current = null;
        if (idx !== null && idx !== index && routes[idx]) {
          nav.navigate(routes[idx].name);
        } else {
          pillX.value = withSpring(index * TAB_W, {
            damping: 28,
            stiffness: 260,
            overshootClamping: true,
          });
        }
      },
      onPanResponderTerminate: () => {
        const { index } = barStateRef.current;
        dragIndexRef.current = null;
        pillX.value = withSpring(index * TAB_W, {
          damping: 28,
          stiffness: 260,
          overshootClamping: true,
        });
      },
    })
  ).current;

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

  const pressRoute = (route, focused) => {
    const event = navigation.emit({
      type: 'tabPress',
      target: route.key,
      canPreventDefault: true,
    });
    if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
  };

  if (Platform.OS === 'android') {
    return (
      <View
        pointerEvents="box-none"
        style={[styles.androidWrap, { bottom: Math.max(insets.bottom, 8) }]}
      >
        <View
          style={[
            styles.androidBar,
            {
              backgroundColor: colors.elevated,
              borderColor: colors.border,
            },
          ]}
        >
          {state.routes.map((route, index) => {
            const focused = state.index === index;
            const [outline, filled] = ICONS[route.name] || ICONS.PhotosTab;
            return (
              <Pressable
                key={route.key}
                onPress={() => pressRoute(route, focused)}
                android_ripple={{ color: colors.accentSoft }}
                style={styles.androidTab}
                accessibilityRole="tab"
                accessibilityLabel={labels[route.name]}
                accessibilityState={{ selected: focused }}
              >
                <View
                  style={[
                    styles.androidIndicator,
                    focused && { backgroundColor: colors.accentSoft },
                  ]}
                >
                  <Ionicons
                    name={focused ? filled : outline}
                    size={24}
                    color={focused ? colors.accent : colors.subtext}
                  />
                </View>
                <Text
                  style={[
                    styles.androidLabel,
                    {
                      color: focused ? colors.accent : colors.subtext,
                      fontWeight: focused ? '700' : '500',
                    },
                  ]}
                >
                  {labels[route.name]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: Math.max(insets.bottom, 12) }]}
    >
      <GlassSurface
        style={[styles.capsule, { borderColor: colors.border }]}
        interactive // iOS 26: press / long-press glass response
      >
        <View style={styles.row} {...slidePan.panHandlers}>
          {/* Sliding selection pill (under the icons) */}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.pill,
              { backgroundColor: colors.accentSoft },
              pillStyle,
            ]}
          />
          {state.routes.map((route, index) => {
            const focused = state.index === index;
            const [outline, filled] = ICONS[route.name] || ICONS.PhotosTab;
            return (
              <Pressable
                key={route.key}
                onPress={() => pressRoute(route, focused)}
                style={({ pressed }) => [
                  styles.tab,
                  pressed && styles.tabPressed,
                ]}
                accessibilityRole="tab"
                accessibilityLabel={labels[route.name]}
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
  androidWrap: {
    position: 'absolute',
    left: 16,
    right: 16,
  },
  androidBar: {
    minHeight: 72,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    elevation: 6,
    flexDirection: 'row',
  },
  androidTab: {
    minWidth: 0,
    minHeight: 72,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  androidIndicator: {
    width: 56,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  androidLabel: { fontSize: 11, marginTop: 2 },
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
  pill: {
    position: 'absolute',
    left: 10,
    top: PILL_INSET,
    bottom: PILL_INSET,
    width: TAB_W,
    borderRadius: 24,
  },
  tab: {
    width: TAB_W,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  tabPressed: { opacity: 0.62 },
  label: {
    fontSize: 11,
    marginTop: 2,
    fontWeight: '600',
  },
});
