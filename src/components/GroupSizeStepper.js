import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import { pickerStyles } from './pickerButtonStyle';

export const MIN_GROUP = 2;
export const MAX_GROUP = 20;

/**
 * How many items one cleaning group holds — chosen right where the cleaning
 * starts rather than buried in Settings, because it is a per-run decision
 * (a quick five-photo pass vs. a twenty-photo sweep). The value is still
 * persisted, so it survives leaving the screen.
 *
 * Shares its geometry with the album and time pickers next to it.
 */
export default function GroupSizeStepper({ value, onChange }) {
  const { colors, t } = useSettings();
  const clamp = (n) => Math.max(MIN_GROUP, Math.min(MAX_GROUP, n));

  return (
    <View
      style={[
        pickerStyles.button,
        styles.stepper,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <Pressable
        hitSlop={6}
        disabled={value <= MIN_GROUP}
        accessibilityRole="button"
        accessibilityLabel={t('decrease_group_size')}
        accessibilityState={{ disabled: value <= MIN_GROUP }}
        android_ripple={{
          color: colors.accentSoft,
          borderless: true,
          radius: 20,
        }}
        onPress={() => onChange(clamp(value - 1))}
        style={({ pressed }) => [
          styles.stepButton,
          pressed && { backgroundColor: colors.chartTrack },
          value <= MIN_GROUP && styles.disabled,
        ]}
      >
        <Ionicons name="remove" size={20} color={colors.accent} />
      </Pressable>
      <View style={styles.center}>
        <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
        <Text style={[styles.label, { color: colors.subtext }]}>
          {t('group_size')}
        </Text>
      </View>
      <Pressable
        hitSlop={6}
        disabled={value >= MAX_GROUP}
        accessibilityRole="button"
        accessibilityLabel={t('increase_group_size')}
        accessibilityState={{ disabled: value >= MAX_GROUP }}
        android_ripple={{
          color: colors.accentSoft,
          borderless: true,
          radius: 20,
        }}
        onPress={() => onChange(clamp(value + 1))}
        style={({ pressed }) => [
          styles.stepButton,
          pressed && { backgroundColor: colors.chartTrack },
          value >= MAX_GROUP && styles.disabled,
        ]}
      >
        <Ionicons name="add" size={20} color={colors.accent} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  stepper: { gap: 10 },
  center: { alignItems: 'center', minWidth: 40 },
  value: { fontSize: 16, fontWeight: '800' },
  label: { fontSize: 9 },
  stepButton: {
    width: 28,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.35 },
});
