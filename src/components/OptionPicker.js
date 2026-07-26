import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import GlassSurface from './GlassSurface';

/**
 * Settings row that opens an iOS 26-style MENU:
 * - Liquid Glass surface (real glass on iOS 26, frosted blur elsewhere)
 * - centered popup with 26pt corners and hairline separators
 * - leading checkmark on the selected row (SF menu layout)
 * NOTE: real Liquid Glass views must NOT be transform-animated (borders
 * drop and the surface "flies") — the Modal's own fade is the appearance.
 */
export default function OptionPicker({ label, value, options, onChange }) {
  const { colors } = useSettings();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  const select = (opt) => {
    setOpen(false);
    if (opt.value !== value) {
      try {
        Haptics.selectionAsync();
      } catch (e) {
        // haptics unavailable
      }
      onChange(opt.value);
    }
  };

  return (
    <>
      <Pressable
        style={[styles.row, { borderColor: colors.border }]}
        onPress={() => setOpen(true)}
      >
        <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
        <View style={styles.valueWrap}>
          <Text style={[styles.value, { color: colors.subtext }]} numberOfLines={1}>
            {current ? current.label : '—'}
          </Text>
          <Ionicons name="chevron-expand" size={15} color={colors.subtext} />
        </View>
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          {/* Border + clipping live on a PLAIN view — stable around glass */}
          <View style={[styles.menuWrap, { borderColor: colors.border }]}>
            <Pressable onPress={() => {}}>
              <GlassSurface style={styles.menu} intensity={70}>
                {/* Small gray header, like an SF menu section title */}
                <View
                  style={[styles.headerRow, { borderBottomColor: colors.border }]}
                >
                  <Text
                    style={[styles.headerText, { color: colors.subtext }]}
                    numberOfLines={1}
                  >
                    {label}
                  </Text>
                </View>

                {options.map((opt, i) => {
                  const selected = opt.value === value;
                  return (
                    <Pressable
                      key={String(opt.value)}
                      onPress={() => select(opt)}
                      style={({ pressed }) => [
                        styles.option,
                        i > 0 && {
                          borderTopWidth: StyleSheet.hairlineWidth,
                          borderTopColor: colors.border,
                        },
                        pressed && { backgroundColor: colors.chartTrack },
                      ]}
                    >
                      {/* Leading checkmark slot (reserved even when empty) */}
                      <View style={styles.checkSlot}>
                        {selected && (
                          <Ionicons
                            name="checkmark"
                            size={17}
                            color={colors.text}
                          />
                        )}
                      </View>
                      <Text
                        style={[
                          styles.optionText,
                          {
                            color: colors.text,
                            fontWeight: selected ? '600' : '400',
                          },
                        ]}
                        numberOfLines={1}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </GlassSurface>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  label: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  valueWrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  value: { fontSize: 13, maxWidth: 140 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  menuWrap: {
    width: 270,
    maxWidth: '100%',
    borderRadius: 26, // iOS 26 menu corner radius
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  menu: {},
  headerRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerText: { fontSize: 12, fontWeight: '600' },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44, // iOS standard row height
    paddingHorizontal: 16,
    gap: 8,
  },
  checkSlot: { width: 20, alignItems: 'center' },
  optionText: { fontSize: 16, flexShrink: 1 },
});
