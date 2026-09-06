import React, { useEffect, useRef } from 'react';
import { Platform, View, Pressable, Text, StyleSheet, PanResponder, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';
import { useGlassEffects } from '../context/GlassEffectsContext';
import { getTabBarLayout } from '../utils/tabBarLayout';
import { surfaceShapes } from '../theme/shapes';
import GlassSurface from './GlassSurface';

const HIDDEN_ROUTES = [
  'Cleaning', 'SmartCleaning', 'VideoCleaning', 'Favorites', 'BurstClean',
  'RecycleBin', 'Compress', 'Insights',
];
const ICONS = {
  PhotosTab: ['images-outline', 'images'],
  VideosTab: ['videocam-outline', 'videocam'],
  ProfileTab: ['person-circle-outline', 'person-circle'],
};
const SPRING = { damping: 28, stiffness: 260, overshootClamping: true };

/** Same app-owned controls on both platforms; only the native material differs. */
export default function LiquidTabBar({ state, descriptors, navigation }) {
  const { colors, t } = useSettings();
  const { reduceMotion, effectsEnabled } = useGlassEffects();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const layout = getTabBarLayout(dimensions, insets, state.routes.length);
  const barRadius = layout.height / 2;
  const innerRadius = Math.max(0, barRadius - layout.padding);
  const pillX = useSharedValue(state.index * layout.tabWidth);
  const animateSelection = !reduceMotion && effectsEnabled;
  const barRef = useRef(null);
  const barX = useRef(null);
  const dragIndex = useRef(null);
  const stateRef = useRef({});

  const selectPill = (index) => {
    const value = index * layout.tabWidth;
    pillX.value = animateSelection ? withSpring(value, SPRING) : value;
  };
  const pressRoute = (index) => {
    const route = state.routes[index];
    if (!route) return;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (index !== state.index && !event.defaultPrevented) navigation.navigate(route.name);
    // A prevented navigation must not leave the pill on the wrong tab.
    if (index === state.index || event.defaultPrevented) selectPill(state.index);
  };
  stateRef.current = { index: state.index, count: state.routes.length, layout, pressRoute, selectPill, animateSelection };

  useEffect(() => {
    const value = state.index * layout.tabWidth;
    pillX.value = animateSelection ? withSpring(value, SPRING) : value;
  }, [state.index, layout.tabWidth, animateSelection, pillX]);

  const pillStyle = useAnimatedStyle(() => ({ transform: [{ translateX: pillX.value }] }));
  const slidePan = useRef(null);
  if (!slidePan.current) slidePan.current = PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) =>
      Platform.OS === 'ios' && stateRef.current.animateSelection && barX.current !== null &&
      Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderMove: (event) => {
      const current = stateRef.current;
      // locationX can be relative to a nested icon/label. Window coordinates
      // keep the finger aligned with the capsule after rotations/resizing.
      const x = event.nativeEvent.pageX - barX.current - current.layout.padding;
      const index = Math.max(0, Math.min(current.count - 1, Math.floor(x / current.layout.tabWidth)));
      if (dragIndex.current !== index) {
        dragIndex.current = index;
        current.selectPill(index);
      }
    },
    onPanResponderRelease: () => {
      const current = stateRef.current;
      const index = dragIndex.current;
      dragIndex.current = null;
      if (index !== null) current.pressRoute(index);
      else current.selectPill(current.index);
    },
    onPanResponderTerminate: () => {
      dragIndex.current = null;
      stateRef.current.selectPill(stateRef.current.index);
    },
  });

  const focusedRoute = state.routes[state.index];
  const nested = focusedRoute.state;
  const nestedName = nested?.routes?.[nested.index ?? nested.routes.length - 1]?.name;
  if (HIDDEN_ROUTES.includes(nestedName)) return null;

  const labels = { PhotosTab: t('tab_photos'), VideosTab: t('tab_videos'), ProfileTab: t('tab_profile') };
  return (
    <View pointerEvents="box-none" onLayout={() => barRef.current?.measureInWindow((x) => { barX.current = x; })} style={[styles.wrap, {
      left: insets.left, right: insets.right, bottom: layout.bottom,
    }]}>
      <GlassSurface
        androidSource={focusedRoute.name}
        style={[styles.capsule, { width: layout.width, borderRadius: barRadius, borderColor: colors.border }]}
      >
        <View
          ref={barRef}
          collapsable={false}
          onLayout={() => barRef.current?.measureInWindow((x) => { barX.current = x; })}
          style={[styles.row, { minHeight: layout.height, padding: layout.padding }]}
          {...slidePan.current.panHandlers}
        >
          <Animated.View pointerEvents="none" style={[
            styles.pill,
            { left: layout.padding, top: layout.padding, bottom: layout.padding,
              width: layout.tabWidth, borderRadius: innerRadius, backgroundColor: colors.accentSoft },
            pillStyle,
          ]} />
          {state.routes.map((route, index) => {
            const focused = state.index === index;
            const [outline, filled] = ICONS[route.name] || ICONS.PhotosTab;
            const options = descriptors[route.key]?.options || {};
            const foreground = focused ? colors.glassAccent : colors.glassSubtext;
            return (
              <Pressable
                key={route.key}
                onPress={() => pressRoute(index)}
                onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
                android_ripple={{ color: colors.accentSoft }}
                style={({ pressed }) => [styles.tab, { width: layout.tabWidth, borderRadius: innerRadius }, pressed && { backgroundColor: colors.elevated }]}
                accessibilityRole="tab"
                accessibilityLabel={options.tabBarAccessibilityLabel || labels[route.name]}
                accessibilityState={{ selected: focused }}
                testID={options.tabBarTestID}
              >
                <Ionicons name={focused ? filled : outline} size={24} color={foreground} accessible={false} importantForAccessibility="no" />
                <Text style={[styles.label, { color: foreground, fontWeight: focused ? '700' : '500' }]}>
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
  wrap: { position: 'absolute', alignItems: 'center' },
  capsule: { ...surfaceShapes.control, borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row' },
  pill: { position: 'absolute', ...surfaceShapes.control },
  tab: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingVertical: 4, paddingHorizontal: 4, ...surfaceShapes.control, overflow: 'hidden' },
  label: { fontSize: 12, lineHeight: 16, marginTop: 3, textAlign: 'center' },
});
