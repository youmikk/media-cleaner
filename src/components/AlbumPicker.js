import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  ActivityIndicator,
  Pressable,
  FlatList,
  Platform,
  StyleSheet,
  Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import ProgressRing from './ProgressRing';
import { pickerStyles } from './pickerButtonStyle';
import AppBottomSheet from './AppBottomSheet';

/**
 * Button + modal list to pick a source album.
 * The backdrop FADES in while the sheet springs up separately — avoids the
 * ugly "black sheet sliding up" artifact of animationType="slide".
 */
export default function AlbumPicker({
  albums,
  selected,
  onSelect,
  progressByAlbum = {},
  progressLoadingByAlbum = {},
  totalCounts = {},
  onVisibleAlbums,
}) {
  const { colors, t } = useSettings();
  const [open, setOpen] = useState(false);
  const slide = useRef(new Animated.Value(80)).current;
  const current = albums.find((a) => a.id === selected);
  const currentProgress = progressByAlbum[selected];
  const countFor = (album) => {
    if (!album) return null;
    const override = totalCounts[album.id];
    return override !== undefined && override !== null
      ? override
      : album.assetCount;
  };
  const currentCount = countFor(current);
  const visibleCallbackRef = useRef(onVisibleAlbums);
  visibleCallbackRef.current = onVisibleAlbums;
  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    const visible = viewableItems.map((entry) => entry.item).filter(Boolean);
    if (visible.length > 0) visibleCallbackRef.current?.(visible);
  }).current;

  useEffect(() => {
    if (open) {
      slide.setValue(80);
      Animated.spring(slide, {
        toValue: 0,
        useNativeDriver: true,
        friction: 10,
        tension: 60,
      }).start();
    }
  }, [open, slide]);

  const albumList = (
    <FlatList
      data={albums}
      keyExtractor={(item) => item.id}
      style={styles.list}
      onViewableItemsChanged={onViewableItemsChanged}
      renderItem={({ item }) => (
        <Pressable
          style={({ pressed }) => [
            styles.row,
            pressed && Platform.OS !== 'android' && {
              backgroundColor: colors.chartTrack,
            },
          ]}
          android_ripple={{ color: colors.accentSoft }}
          accessibilityRole="button"
          accessibilityLabel={`${item.title}, ${countFor(item) ?? 0}`}
          accessibilityState={{ selected: item.id === selected }}
          onPress={() => {
            setOpen(false);
            onSelect(item);
          }}
        >
          <Text
            style={[
              styles.rowText,
              {
                color: item.id === selected ? colors.accent : colors.text,
                fontWeight: item.id === selected ? '700' : '400',
              },
            ]}
            numberOfLines={1}
          >
            {item.title}
          </Text>
          {countFor(item) !== undefined && countFor(item) !== null && (
            <Text style={[styles.count, { color: colors.subtext }]}>
              {countFor(item)}
            </Text>
          )}
          {progressLoadingByAlbum[item.id] ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : progressByAlbum[item.id] ? (
            <ProgressRing
              percent={progressByAlbum[item.id].percent}
              size={28}
              color={colors.accent}
              trackColor={colors.chartTrack}
              textColor={colors.subtext}
            />
          ) : null}
          {item.id === selected && (
            <Ionicons name="checkmark" size={18} color={colors.accent} />
          )}
        </Pressable>
      )}
    />
  );

  return (
    <>
      <Pressable
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
        accessibilityRole="button"
        accessibilityLabel={current ? current.title : t('choose_album')}
        accessibilityState={{ expanded: open }}
      >
        <Ionicons name="albums-outline" size={18} color={colors.accent} />
        <Text
          style={[pickerStyles.text, { color: colors.text }]}
          numberOfLines={1}
        >
          {current ? current.title : '…'}
        </Text>
        {currentCount !== undefined && currentCount !== null && (
          <Text style={[styles.buttonCount, { color: colors.subtext }]}>
            {currentCount}
          </Text>
        )}
        {progressLoadingByAlbum[selected] ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : currentProgress ? (
          <ProgressRing
            percent={currentProgress.percent}
            // Small enough to sit INSIDE the shared control height — the
            // default 30px ring is what used to make this button taller
            // than the time picker next to it.
            size={24}
            color={colors.accent}
            trackColor={colors.chartTrack}
            textColor={colors.subtext}
          />
        ) : null}
        <Ionicons name="chevron-down" size={16} color={colors.subtext} />
      </Pressable>

      {Platform.OS === 'android' ? (
        <AppBottomSheet
          visible={open}
          title={t('choose_album')}
          onClose={() => setOpen(false)}
        >
          {albumList}
        </AppBottomSheet>
      ) : (
        <Modal
          visible={open}
          transparent
          animationType="fade"
          onRequestClose={() => setOpen(false)}
        >
          <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
            <Animated.View style={{ transform: [{ translateY: slide }] }}>
              <Pressable
                style={[styles.sheet, { backgroundColor: colors.card }]}
                onPress={() => {}}
                accessibilityViewIsModal
              >
                <Text style={[styles.title, { color: colors.text }]}>
                  {t('choose_album')}
                </Text>
                {albumList}
              </Pressable>
            </Animated.View>
          </Pressable>
        </Modal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // Geometry comes from pickerStyles.button — only the flex behaviour is
  // local, so the album name gets the room it needs without pushing the
  // other controls out of the row.
  button: { flex: 1, minWidth: 0 },
  list: { maxHeight: 420 },
  buttonCount: { fontSize: 11, fontWeight: '700' },
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
  title: { fontSize: 17, fontWeight: '700', marginBottom: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    gap: 10,
  },
  rowText: { flex: 1, fontSize: 15 },
  count: { fontSize: 13 },
});
