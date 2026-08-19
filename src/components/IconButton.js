import React from 'react';
import { Platform, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

const TOUCH_SIZE = 48;

/** Standard icon-only control with a platform-sized touch target. */
export default function IconButton({
  name,
  label,
  onPress,
  color,
  iconSize = 24,
  disabled = false,
  selected = false,
  backgroundColor = 'transparent',
  pressedColor,
  style,
}) {
  const { colors } = useSettings();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      hitSlop={4}
      android_ripple={{
        color: pressedColor || colors.accentSoft,
        borderless: true,
        radius: TOUCH_SIZE / 2,
      }}
      style={({ pressed }) => [
        styles.button,
        {
          width: TOUCH_SIZE,
          height: TOUCH_SIZE,
          backgroundColor: pressed && Platform.OS !== 'android'
            ? pressedColor || colors.chartTrack
            : backgroundColor,
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      <Ionicons name={name} size={iconSize} color={color || colors.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    overflow: 'hidden',
  },
});
