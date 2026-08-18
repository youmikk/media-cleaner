import React, { useState } from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

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
      <Pressable
        style={[styles.settingRow, { borderColor: colors.border }]}
        onPress={() => setOpen(true)}
      >
        <View
          style={[
            styles.settingIcon,
            { backgroundColor: value ? colors.accentSoft : colors.dangerSoft },
          ]}
        >
          <Ionicons
            name={value ? 'trash-bin-outline' : 'trash-outline'}
            size={19}
            color={value ? colors.accent : colors.danger}
          />
        </View>
        <View style={styles.settingCopy}>
          <Text style={[styles.settingLabel, { color: colors.text }]}>
            {t('setting_delete_mode')}
          </Text>
          <Text style={[styles.settingValue, { color: colors.subtext }]}>
            {t(value ? 'delete_mode_recycle' : 'delete_mode_direct')}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.subtext} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable
            style={[styles.sheet, { backgroundColor: colors.card }]}
            onPress={() => {}}
          >
            <View style={[styles.handle, { backgroundColor: colors.chartTrack }]} />
            <Text style={[styles.title, { color: colors.text }]}>
              {t('delete_mode_title')}
            </Text>

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
          </Pressable>
        </Pressable>
      </Modal>
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
      style={[
        styles.option,
        {
          backgroundColor: selected ? colors.accentSoft : colors.elevated,
          borderColor: selected ? colors.accent : colors.border,
        },
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
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  settingIcon: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingCopy: { flex: 1 },
  settingLabel: { fontSize: 14, fontWeight: '600' },
  settingValue: { fontSize: 12, marginTop: 2 },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 34,
    gap: 10,
  },
  handle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 4,
  },
  title: { fontSize: 18, fontWeight: '800', textAlign: 'center' },
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
