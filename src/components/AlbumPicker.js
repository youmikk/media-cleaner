import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
  Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import ProgressRing from './ProgressRing';

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
  totalCounts = {},
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

  return (
    <>
      <Pressable
        style={[styles.button, { backgroundColor: colors.card, borderColor: colors.border }]}
        onPress={() => setOpen(true)}
      >
        <Ionicons name="albums-outline" size={18} color={colors.accent} />
        <Text style={[styles.buttonText, { color: colors.text }]} numberOfLines={1}>
          {current ? current.title : '…'}
        </Text>
        {currentCount !== undefined && currentCount !== null && (
          <Text style={[styles.buttonCount, { color: colors.subtext }]}>
            {currentCount}
          </Text>
        )}
        {currentProgress && (
          <ProgressRing
            percent={currentProgress.percent}
            color={colors.accent}
            trackColor={colors.chartTrack}
            textColor={colors.subtext}
          />
        )}
        <Ionicons name="chevron-down" size={16} color={colors.subtext} />
      </Pressable>

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
            >
              <Text style={[styles.title, { color: colors.text }]}>
                {t('choose_album')}
              </Text>
              <FlatList
                data={albums}
                keyExtractor={(item) => item.id}
                style={{ maxHeight: 420 }}
                renderItem={({ item }) => (
                  <Pressable
                    style={styles.row}
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
                    {progressByAlbum[item.id] && (
                      <ProgressRing
                        percent={progressByAlbum[item.id].percent}
                        size={28}
                        color={colors.accent}
                        trackColor={colors.chartTrack}
                        textColor={colors.subtext}
                      />
                    )}
                    {item.id === selected && (
                      <Ionicons name="checkmark" size={18} color={colors.accent} />
                    )}
                  </Pressable>
                )}
              />
            </Pressable>
          </Animated.View>
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
    maxWidth: 200,
  },
  buttonText: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
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
