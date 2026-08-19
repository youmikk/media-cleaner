import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

/** Shared row geometry for tools, destinations and settings. */
export default function SettingsRow({
  icon,
  iconColor,
  iconBackgroundColor,
  title,
  subtitle,
  value,
  onPress,
  disabled = false,
  divider = true,
  accessory = 'chevron',
  trailing = null,
  accessibilityLabel,
  compact = false,
}) {
  const { colors } = useSettings();
  const content = (
    <>
      {!!icon && (
        <View
          style={[
            styles.iconWell,
            { backgroundColor: iconBackgroundColor || colors.accentSoft },
          ]}
          importantForAccessibility="no-hide-descendants"
        >
          <Ionicons
            name={icon}
            size={21}
            color={iconColor || colors.accent}
          />
        </View>
      )}
      <View style={styles.copy}>
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        {!!subtitle && (
          <Text style={[styles.subtitle, { color: colors.subtext }]}>
            {subtitle}
          </Text>
        )}
      </View>
      {!!value && (
        <Text
          style={[styles.value, { color: colors.subtext }]}
          numberOfLines={1}
        >
          {value}
        </Text>
      )}
      {trailing}
      {accessory === 'chevron' && (
        <Ionicons name="chevron-forward" size={18} color={colors.subtext} />
      )}
      {accessory === 'share' && (
        <Ionicons name="share-outline" size={19} color={colors.subtext} />
      )}
    </>
  );
  const rowStyle = [
    styles.row,
    compact && styles.compactRow,
    divider && {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
  ];

  if (!onPress) return <View style={rowStyle}>{content}</View>;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || title}
      accessibilityState={{ disabled }}
      android_ripple={{ color: colors.accentSoft }}
      style={({ pressed }) => [
        rowStyle,
        pressed && Platform.OS !== 'android' && {
          backgroundColor: colors.chartTrack,
        },
        disabled && styles.disabled,
      ]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 60,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    overflow: 'hidden',
  },
  compactRow: { minHeight: 56, paddingHorizontal: 2 },
  iconWell: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '600' },
  subtitle: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  value: { maxWidth: 92, fontSize: 13, fontVariant: ['tabular-nums'] },
  disabled: { opacity: 0.45 },
});
