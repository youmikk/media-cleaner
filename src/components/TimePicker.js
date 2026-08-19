import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  SectionList,
  Platform,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import { pickerStyles } from './pickerButtonStyle';
import AppBottomSheet from './AppBottomSheet';

function monthLabel(year, month, language) {
  if (language === 'zh') return `${year}年${month + 1}月`;
  return new Date(year, month, 1).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
}

function yearLabel(year, language) {
  return language === 'zh' ? `${year}年` : String(year);
}

/**
 * Time-scope picker: clean a whole YEAR or a specific YEAR-MONTH.
 * Takes a precomputed `years` histogram (see buildYearHistogram) so it can
 * render from the album-summary cache without any scanning.
 * Emits { label, year, month, start, end } or null for "all time".
 */
export default function TimePicker({ years = [], value, onSelect }) {
  const { colors, t, language } = useSettings();
  const [open, setOpen] = useState(false);
  const [expandedYear, setExpandedYear] = useState(null);

  const pick = (selection) => {
    setOpen(false);
    onSelect(selection);
  };

  const pickYear = (year) =>
    pick({
      label: yearLabel(year, language),
      year,
      month: null,
      start: new Date(year, 0, 1).getTime(),
      end: new Date(year + 1, 0, 1).getTime(),
    });

  const pickMonth = (year, month) =>
    pick({
      label: monthLabel(year, month, language),
      year,
      month,
      start: new Date(year, month, 1).getTime(),
      end: new Date(year, month + 1, 1).getTime(),
    });

  const timeList = (
    <SectionList
      style={styles.list}
      sections={[{ data: years }]}
      keyExtractor={(item) => String(item.year)}
      ListHeaderComponent={
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ checked: !value }}
          android_ripple={{ color: colors.accentSoft }}
          style={({ pressed }) => [
            styles.row,
            pressed && Platform.OS !== 'android' && {
              backgroundColor: colors.chartTrack,
            },
          ]}
          onPress={() => pick(null)}
        >
          <Text
            style={[
              styles.rowText,
              {
                color: !value ? colors.accent : colors.text,
                fontWeight: !value ? '700' : '400',
              },
            ]}
          >
            {t('time_all')}
          </Text>
          {!value && (
            <Ionicons name="checkmark" size={18} color={colors.accent} />
          )}
        </Pressable>
      }
      renderItem={({ item }) => (
        <View>
          <View style={styles.row}>
            <Pressable
              style={styles.yearButton}
              android_ripple={{ color: colors.accentSoft }}
              accessibilityRole="button"
              onPress={() => pickYear(item.year)}
            >
              <Text style={[styles.rowText, { color: colors.text }]}>
                {yearLabel(item.year, language)}
                <Text style={{ color: colors.subtext, fontSize: 13 }}>
                  {'  '}({item.count})
                </Text>
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={yearLabel(item.year, language)}
              accessibilityState={{ expanded: expandedYear === item.year }}
              android_ripple={{
                color: colors.accentSoft,
                borderless: true,
                radius: 24,
              }}
              style={styles.expandButton}
              onPress={() =>
                setExpandedYear(
                  expandedYear === item.year ? null : item.year
                )
              }
            >
              <Ionicons
                name={
                  expandedYear === item.year ? 'chevron-up' : 'chevron-down'
                }
                size={20}
                color={colors.subtext}
              />
            </Pressable>
          </View>
          {expandedYear === item.year &&
            item.months.map(([m, count]) => (
              <Pressable
                key={m}
                accessibilityRole="button"
                android_ripple={{ color: colors.accentSoft }}
                style={({ pressed }) => [
                  styles.row,
                  styles.monthRow,
                  pressed && Platform.OS !== 'android' && {
                    backgroundColor: colors.chartTrack,
                  },
                ]}
                onPress={() => pickMonth(item.year, m)}
              >
                <Text style={[styles.rowText, { color: colors.text }]}>
                  {monthLabel(item.year, m, language)}
                  <Text style={{ color: colors.subtext, fontSize: 13 }}>
                    {'  '}({count})
                  </Text>
                </Text>
              </Pressable>
            ))}
        </View>
      )}
    />
  );

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t('time_title')}, ${
          value ? value.label : t('time_all')
        }`}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [
          pickerStyles.button,
          styles.button,
          {
            backgroundColor:
              pressed && Platform.OS !== 'android'
                ? colors.chartTrack
                : colors.card,
            borderColor: colors.border,
          },
        ]}
        onPress={() => setOpen(true)}
        android_ripple={{ color: colors.accentSoft }}
      >
        <Ionicons name="calendar-outline" size={18} color={colors.accent} />
        <Text
          style={[pickerStyles.text, { color: colors.text }]}
          numberOfLines={1}
        >
          {value ? value.label : t('time_all')}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.subtext} />
      </Pressable>

      {Platform.OS === 'android' ? (
        <AppBottomSheet
          visible={open}
          title={t('time_title')}
          onClose={() => setOpen(false)}
        >
          {timeList}
        </AppBottomSheet>
      ) : (
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
              accessibilityViewIsModal
            >
              <Text style={[styles.title, { color: colors.text }]}>
                {t('time_title')}
              </Text>
              {timeList}
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // Geometry is shared with the album picker (pickerStyles.button); the
  // label is short, so this one only takes the room it needs.
  button: { flexShrink: 1 },
  list: { maxHeight: 440 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 34,
  },
  title: { fontSize: 17, fontWeight: '700', marginBottom: 10 },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    gap: 10,
    overflow: 'hidden',
  },
  yearButton: {
    minHeight: 52,
    flex: 1,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  expandButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  monthRow: { paddingLeft: 22 },
  rowText: { fontSize: 15 },
});
