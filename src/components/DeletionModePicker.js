import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import SettingsRow from './SettingsRow';
import AppBottomSheet from './AppBottomSheet';

/** Android deletion-mode row and its compact, theme-aware choice sheet. */
export default function DeletionModePicker({ value, onChange }) {
  const { colors, t } = useSettings();
  const [open, setOpen] = useState(false);

  const choose = (next) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <>
      <SettingsRow
        icon={value ? 'trash-bin-outline' : 'trash-outline'}
        iconColor={value ? colors.accent : colors.danger}
        iconBackgroundColor={value ? colors.accentSoft : colors.dangerSoft}
        title={t('setting_delete_mode')}
        subtitle={t(value ? 'delete_mode_recycle' : 'delete_mode_direct')}
        onPress={() => setOpen(true)}
        divider={false}
        compact
      />

      <AppBottomSheet
        visible={open}
        title={t('delete_mode_title')}
        onClose={() => setOpen(false)}
      >
        <View
          style={[
            styles.recommendation,
            { backgroundColor: colors.accentSoft },
          ]}
        >
          <Ionicons name="bulb-outline" size={20} color={colors.accent} />
          <View style={styles.recommendationCopy}>
            <Text style={[styles.recommendationTitle, { color: colors.text }]}>
              {t('delete_mode_tip_title')}
            </Text>
            <Text style={[styles.description, { color: colors.subtext }]}>
              {t('delete_mode_tip_desc')}
            </Text>
          </View>
        </View>

        <View style={styles.options}>
          <ModeOption
            icon="trash-outline"
            title={t('delete_mode_direct')}
            description={t('delete_mode_direct_desc')}
            selected={!value}
            recommended
            colors={colors}
            t={t}
            onPress={() => choose(false)}
          />
          <ModeOption
            icon="archive-outline"
            title={t('delete_mode_recycle')}
            description={t('delete_mode_recycle_desc')}
            selected={value}
            colors={colors}
            t={t}
            onPress={() => choose(true)}
          />
        </View>
      </AppBottomSheet>
    </>
  );
}

function ModeOption({
  icon,
  title,
  description,
  selected,
  recommended = false,
  colors,
  t,
  onPress,
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      android_ripple={{ color: colors.accentSoft }}
      style={({ pressed }) => [
        styles.option,
        {
          backgroundColor: selected ? colors.accentSoft : colors.elevated,
          borderColor: selected ? colors.accent : colors.border,
        },
        pressed && { opacity: 0.92 },
      ]}
      onPress={onPress}
    >
      <Ionicons
        name={icon}
        size={22}
        color={selected ? colors.accent : colors.subtext}
      />
      <View style={styles.optionCopy}>
        <View style={styles.optionTitleRow}>
          <Text style={[styles.optionTitle, { color: colors.text }]}>{title}</Text>
          {recommended && (
            <View style={[styles.badge, { backgroundColor: colors.accentSoft }]}>
              <Text style={[styles.badgeText, { color: colors.accent }]}>
                {t('delete_mode_recommended')}
              </Text>
            </View>
          )}
        </View>
        <Text style={[styles.description, { color: colors.subtext }]}>
          {description}
        </Text>
      </View>
      <Ionicons
        name={selected ? 'checkmark-circle' : 'ellipse-outline'}
        size={23}
        color={selected ? colors.accent : colors.subtext}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  options: { gap: 8, paddingBottom: 4 },
  recommendation: {
    flexDirection: 'row',
    gap: 10,
    borderRadius: 8,
    padding: 12,
    marginBottom: 2,
  },
  recommendationCopy: { flex: 1 },
  recommendationTitle: { fontSize: 14, fontWeight: '700', marginBottom: 3 },
  option: {
    minHeight: 78,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    padding: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  optionCopy: { flex: 1 },
  optionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  optionTitle: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  description: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  badge: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { fontSize: 10, fontWeight: '700' },
});
