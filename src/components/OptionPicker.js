import React, { useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import GlassSurface from './GlassSurface';

// NATIVE system menu (@react-native-menu/menu → UIMenu / PopupMenu).
// Present only in builds that include the native module — Expo Go and
// older binaries fall back to the JS menu below.
let MenuView = null;
try {
  // eslint-disable-next-line global-require
  MenuView = require('@react-native-menu/menu').MenuView;
} catch (e) {
  MenuView = null;
}

/**
 * Settings row that opens an iOS 26-style MENU anchored to the row itself
 * (like a SwiftUI Menu) — below the row, flipping above when space runs
 * out, trailing-aligned:
 * - Liquid Glass surface (real glass on iOS 26, frosted blur elsewhere)
 * - 26pt corners, hairline separators, leading checkmark (SF menu layout)
 * NOTE: real Liquid Glass views must NOT be transform-animated (borders
 * drop and the surface "flies") — the Modal's own fade is the appearance.
 */
export default function OptionPicker({ label, value, options, onChange }) {
  const { colors } = useSettings();
  const { height: SCREEN_H } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null); // {top} | {bottom} | null
  const rowRef = useRef(null);
  const current = options.find((o) => o.value === value);

  const openMenu = (pressEvent) => {
    // Press-point fallback: measureInWindow can fail silently on some
    // Android versions — pageY always exists, so the menu still anchors
    // to the tapped row instead of jumping to the screen center.
    const pageY =
      pressEvent && pressEvent.nativeEvent ? pressEvent.nativeEvent.pageY : null;
    const est = 34 + options.length * 44 + 6; // header + 44pt per option
    const place = (rowBottomY, rowTopY) => {
      if (rowBottomY + est + 16 < SCREEN_H) {
        setAnchor({ top: rowBottomY + 6 }); // below the row
      } else {
        setAnchor({ bottom: SCREEN_H - rowTopY + 6 }); // above the row
      }
      setOpen(true);
    };
    const node = rowRef.current;
    let measured = false;
    if (node && node.measureInWindow) {
      node.measureInWindow((x, y, w, h) => {
        if (typeof y === 'number' && h > 0) {
          measured = true;
          place(y + h, y);
        }
      });
    }
    // measureInWindow is synchronous in practice; fall back if it didn't fire.
    setTimeout(() => {
      if (measured) return;
      if (pageY !== null) place(pageY + 22, pageY - 22);
      else {
        setAnchor(null); // centered as the last resort
        setOpen(true);
      }
    }, 0);
  };

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

  const rowContent = (
    <>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <View style={styles.valueWrap}>
        <Text style={[styles.value, { color: colors.subtext }]} numberOfLines={1}>
          {current ? current.label : '—'}
        </Text>
        <Ionicons name="chevron-expand" size={15} color={colors.subtext} />
      </View>
    </>
  );

  // Builds WITH the native module: a real system menu (UIMenu / PopupMenu).
  // Two tricks combined:
  // - the visible texts live OUTSIDE the MenuView (its children get
  //   re-attached natively on change, which flashes)
  // - the invisible MenuView overlays ONLY the value area, so UIMenu's
  //   dismiss morph animation is scoped to that small region (like an iOS
  //   Settings pull-down button) and never disturbs the row label.
  if (MenuView) {
    return (
      <View style={[styles.row, { borderColor: colors.border }]}>
        <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
        <View style={styles.valueWrap}>
          <Text
            style={[styles.value, { color: colors.subtext }]}
            numberOfLines={1}
          >
            {current ? current.label : '—'}
          </Text>
          <Ionicons name="chevron-expand" size={15} color={colors.subtext} />
          <MenuView
            style={styles.menuOverlay}
            title={label}
            onPressAction={({ nativeEvent }) => {
              const opt = options.find(
                (o) => String(o.value) === nativeEvent.event
              );
              if (opt) select(opt);
            }}
            actions={options.map((o) => ({
              id: String(o.value),
              title: o.label,
              state: o.value === value ? 'on' : 'off',
            }))}
            shouldOpenOnLongPress={false}
          >
            <View style={StyleSheet.absoluteFill} />
          </MenuView>
        </View>
      </View>
    );
  }

  return (
    <>
      <Pressable
        ref={rowRef}
        style={[styles.row, { borderColor: colors.border }]}
        onPress={(e) => openMenu(e)}
      >
        {rowContent}
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          style={[styles.backdrop, !anchor && styles.backdropCentered]}
          onPress={() => setOpen(false)}
        >
          {/* Border + clipping live on a PLAIN view — stable around glass.
              Anchored to the tapped row (below/above), trailing-aligned. */}
          <View
            style={[
              styles.menuWrap,
              { borderColor: colors.border },
              anchor && styles.menuAnchored,
              anchor,
            ]}
          >
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
  menuOverlay: {
    ...StyleSheet.absoluteFillObject,
    // slightly larger than the value area for a comfortable tap target
    margin: -10,
  },
  value: { fontSize: 13, maxWidth: 140 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.12)', // iOS menus dim only slightly
  },
  backdropCentered: {
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
  menuAnchored: {
    position: 'absolute',
    right: 16, // trailing-aligned with the settings rows
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
