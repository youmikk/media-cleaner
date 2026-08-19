import React, { useMemo, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  Platform,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import GlassSurface from './GlassSurface';
import AppBottomSheet from './AppBottomSheet';

// Native system menu is an iOS-only enhancement. Android always uses the
// app-owned bottom sheet so OEM PopupMenu styling cannot leak into the UI.
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
export default function OptionPicker({
  label,
  value,
  options,
  onChange,
  divider = true,
}) {
  const { colors } = useSettings();
  const { height: SCREEN_H } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null); // {top} | {bottom} | null
  const rowRef = useRef(null);
  const current = options.find((o) => o.value === value);

  // Memoized: a fresh array on every render makes the bridge push new props
  // to the native view, and iOS rebuilds the whole UIMenu each time. Only a
  // real change of options or selection should touch the native menu.
  const menuActions = useMemo(
    () =>
      options.map((o) => ({
        id: String(o.value),
        title: o.label,
        state: o.value === value ? 'on' : 'off',
      })),
    [options, value]
  );

  const openMenu = (pressEvent) => {
    if (Platform.OS === 'android') {
      setAnchor(null);
      setOpen(true);
      return;
    }
    // Press-point fallback: measureInWindow can fail silently, but pageY still
    // lets the iOS fallback menu anchor instead of jumping to screen center.
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
    if (opt.value === value) return;
    try {
      Haptics.selectionAsync();
    } catch (e) {
      // haptics unavailable
    }
    // Commit IMMEDIATELY and let UIKit's own menu-dismissal animation cover
    // the swap. This used to be deferred by 220ms to dodge a repaint, which
    // only traded one artefact for a worse one: the menu closed, the row sat
    // on the OLD value for a fifth of a second, then snapped — read by the
    // user as the value "flashing" after every change.
    onChange(opt.value);
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

  // iOS builds WITH the native module use a real UIMenu, so the
  // open/dismiss animation is UIKit's own — nothing is hand-rolled.
  //
  // Layering matters: the MenuView is an INVISIBLE tap target rendered FIRST,
  // and the value label sits on top of it with pointerEvents="none" (touches
  // fall straight through). When iOS rebuilds the menu's host view it can
  // repaint underneath the text but never over it, which is what used to
  // show up as a flash in the selected value.
  if (Platform.OS === 'ios' && MenuView) {
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
        <View style={styles.valueWrap}>
          <MenuView
            style={styles.menuOverlay}
            title={label}
            accessibilityRole="button"
            accessibilityLabel={`${label}, ${current ? current.label : ''}`}
            accessibilityState={{ expanded: false }}
            onPressAction={({ nativeEvent }) => {
              const opt = options.find(
                (o) => String(o.value) === nativeEvent.event
              );
              if (opt) select(opt);
            }}
            actions={menuActions}
            shouldOpenOnLongPress={false}
          >
            <View style={StyleSheet.absoluteFill} />
          </MenuView>
          <View style={styles.valueContent} pointerEvents="none">
            <Text
              style={[styles.value, { color: colors.subtext }]}
              numberOfLines={1}
            >
              {current ? current.label : '—'}
            </Text>
            <Ionicons name="chevron-expand" size={15} color={colors.subtext} />
          </View>
        </View>
      </View>
    );
  }

  if (Platform.OS === 'android') {
    return (
      <>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}, ${current ? current.label : ''}`}
          accessibilityState={{ expanded: open }}
          android_ripple={{ color: colors.accentSoft }}
          style={[
            styles.row,
            divider && {
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: colors.border,
            },
          ]}
          onPress={openMenu}
        >
          {rowContent}
        </Pressable>

        <AppBottomSheet
          visible={open}
          title={label}
          onClose={() => setOpen(false)}
        >
          <View style={styles.androidOptions}>
            {options.map((opt) => {
              const selected = opt.value === value;
              return (
                <Pressable
                  key={String(opt.value)}
                  onPress={() => select(opt)}
                  android_ripple={{ color: colors.accentSoft }}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  style={[
                    styles.androidOption,
                    {
                      backgroundColor: selected
                        ? colors.accentSoft
                        : 'transparent',
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.androidOptionText,
                      {
                        color: selected ? colors.accent : colors.text,
                        fontWeight: selected ? '700' : '500',
                      },
                    ]}
                  >
                    {opt.label}
                  </Text>
                  <Ionicons
                    name={selected ? 'radio-button-on' : 'radio-button-off'}
                    size={24}
                    color={selected ? colors.accent : colors.subtext}
                  />
                </Pressable>
              );
            })}
          </View>
        </AppBottomSheet>
      </>
    );
  }

  return (
    <>
      <Pressable
        ref={rowRef}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${current ? current.label : ''}`}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [
          styles.row,
          divider && {
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.border,
          },
          pressed && { backgroundColor: colors.chartTrack },
        ]}
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
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
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
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
    paddingVertical: 10,
    gap: 10,
  },
  label: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  valueWrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  // The label row that paints ON TOP of the invisible native menu view.
  valueContent: { flexDirection: 'row', alignItems: 'center', gap: 4 },
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
  androidOptions: { gap: 4, paddingBottom: 4 },
  androidOption: {
    minHeight: 56,
    borderRadius: 8,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  androidOptionText: { flex: 1, minWidth: 0, fontSize: 16 },
});
