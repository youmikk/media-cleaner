import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { useSettings } from '../context/SettingsContext';

/** iOS keeps its native switch; Android gets one app-owned visual language. */
export default function AppSwitch({
  value,
  onValueChange,
  label,
  disabled = false,
}) {
  const { colors } = useSettings();
  const progress = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: value ? 1 : 0,
      duration: 160,
      useNativeDriver: true,
    }).start();
  }, [progress, value]);

  if (Platform.OS !== 'android') {
    return (
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ true: colors.accent }}
        accessibilityLabel={label}
      />
    );
  }

  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      android_ripple={{ color: colors.accentSoft, borderless: true, radius: 28 }}
      style={[styles.target, disabled && styles.disabled]}
    >
      <View
        style={[
          styles.track,
          {
            backgroundColor: value ? colors.accent : colors.chartTrack,
            borderColor: value ? colors.accent : colors.border,
          },
        ]}
      >
        <Animated.View
          style={[
            styles.thumb,
            {
              backgroundColor: value ? '#FFFFFF' : colors.subtext,
              transform: [
                {
                  translateX: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, 20],
                  }),
                },
              ],
            },
          ]}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  target: {
    width: 56,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  track: {
    width: 52,
    height: 32,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 3,
    justifyContent: 'center',
  },
  thumb: {
    width: 24,
    height: 24,
    borderRadius: 12,
    elevation: 2,
  },
  disabled: { opacity: 0.4 },
});
