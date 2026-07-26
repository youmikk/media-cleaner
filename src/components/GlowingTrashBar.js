import React from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  interpolate,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Softly glowing red bar with a trash icon, pinned to the very top of the
 * screen. Slides down and brightens proportionally to the swipe-up gesture:
 * `progress` is a Reanimated shared value in [0, 1].
 */
export default function GlowingTrashBar({ progress }) {
  const insets = useSafeAreaInsets();

  const style = useAnimatedStyle(() => {
    const p = progress.value;
    return {
      opacity: interpolate(p, [0, 0.15, 1], [0, 0.65, 1]),
      transform: [{ translateY: interpolate(p, [0, 1], [-110, 0]) }],
      shadowOpacity: 0.35 + 0.55 * p,
      shadowRadius: 10 + 16 * p,
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.bar, { paddingTop: insets.top + 10 }, style]}
    >
      <Ionicons name="trash" size={26} color="#fff" />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    alignItems: 'center',
    paddingBottom: 16,
    borderBottomLeftRadius: 26,
    borderBottomRightRadius: 26,
    backgroundColor: 'rgba(255, 59, 48, 0.92)',
    shadowColor: '#FF3B30',
    shadowOffset: { width: 0, height: 6 },
    elevation: 16,
  },
});
