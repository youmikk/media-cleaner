import React from 'react';
import { Pressable, Text, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

/**
 * Standalone undo pill (used on the video screen).
 */
export default function UndoButton({ count, onPress, style }) {
  const { colors, t } = useSettings();
  if (!count) return null;
  return (
    <Pressable
      onPress={onPress}
      style={[styles.pill, { backgroundColor: colors.accent }, style]}
    >
      <Ionicons name="arrow-undo" size={16} color="#fff" />
      <Text style={styles.text}>
        {t('undo')} ({count})
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  text: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
