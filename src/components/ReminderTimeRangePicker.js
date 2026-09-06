import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

const STEP = 30;

function normalize(value) {
  return ((value % 1440) + 1440) % 1440;
}

function formatTime(value) {
  const minute = normalize(value);
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(
    minute % 60
  ).padStart(2, '0')}`;
}

function TimeRow({ label, value, settingKey, onChange, divider }) {
  const { colors, t } = useSettings();
  return (
    <View
      style={[
        styles.row,
        divider && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
      ]}
    >
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <View style={styles.controls}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}, ${t('decrease_reminder_time')}`}
          android_ripple={{ color: colors.accentSoft, borderless: true, radius: 24 }}
          style={({ pressed }) => [
            styles.button,
            pressed && { backgroundColor: colors.chartTrack },
          ]}
          onPress={() => onChange(settingKey, normalize(value - STEP))}
        >
          <Ionicons name="remove" size={20} color={colors.accent} />
        </Pressable>
        <Text style={[styles.value, { color: colors.text }]}>{formatTime(value)}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}, ${t('increase_reminder_time')}`}
          android_ripple={{ color: colors.accentSoft, borderless: true, radius: 24 }}
          style={({ pressed }) => [
            styles.button,
            pressed && { backgroundColor: colors.chartTrack },
          ]}
          onPress={() => onChange(settingKey, normalize(value + STEP))}
        >
          <Ionicons name="add" size={20} color={colors.accent} />
        </Pressable>
      </View>
    </View>
  );
}

export default function ReminderTimeRangePicker({ start, end, onChange }) {
  const { t } = useSettings();
  return (
    <View>
      <TimeRow
        label={t('reminder_start_time')}
        value={start}
        settingKey="reminderStartMinute"
        onChange={onChange}
        divider
      />
      <TimeRow
        label={t('reminder_end_time')}
        value={end}
        settingKey="reminderEndMinute"
        onChange={onChange}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  label: { flex: 1, fontSize: 16 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  button: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  value: {
    width: 54,
    textAlign: 'center',
    fontSize: 15,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
});
