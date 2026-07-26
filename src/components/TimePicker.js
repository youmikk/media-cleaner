import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  SectionList,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

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

  return (
    <>
      <Pressable
        style={[styles.button, { backgroundColor: colors.card, borderColor: colors.border }]}
        onPress={() => setOpen(true)}
      >
        <Ionicons name="calendar-outline" size={18} color={colors.accent} />
        <Text style={[styles.buttonText, { color: colors.text }]} numberOfLines={1}>
          {value ? value.label : t('time_all')}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.subtext} />
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
            <Text style={[styles.title, { color: colors.text }]}>
              {t('time_title')}
            </Text>
            <SectionList
              style={{ maxHeight: 440 }}
              sections={[{ data: years }]}
              keyExtractor={(item) => String(item.year)}
              ListHeaderComponent={
                <Pressable style={styles.row} onPress={() => pick(null)}>
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
                      style={{ flex: 1 }}
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
                      hitSlop={10}
                      onPress={() =>
                        setExpandedYear(
                          expandedYear === item.year ? null : item.year
                        )
                      }
                    >
                      <Ionicons
                        name={
                          expandedYear === item.year
                            ? 'chevron-up'
                            : 'chevron-down'
                        }
                        size={18}
                        color={colors.subtext}
                      />
                    </Pressable>
                  </View>
                  {expandedYear === item.year &&
                    item.months.map(([m, count]) => (
                      <Pressable
                        key={m}
                        style={[styles.row, styles.monthRow]}
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
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 170,
  },
  buttonText: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
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
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    gap: 10,
  },
  monthRow: { paddingLeft: 22, paddingVertical: 10 },
  rowText: { fontSize: 15 },
});
