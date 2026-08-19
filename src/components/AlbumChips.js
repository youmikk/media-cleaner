import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  Modal,
  TextInput,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import { getUsage, sortByUsage } from '../utils/albumUsage';

/**
 * Quick-categorize chip row (photoo-style):
 *   [ + ] [ ✓ current album ] [ other albums by usage frequency … ]
 * Tapping a chip moves the CURRENT item into that album; "+" creates a new
 * album. `currentAlbumId` follows the current photo/video.
 *
 * VIRTUALIZED, and memoized on its props. This row lives on the cleaning
 * screen, which re-renders on every swipe, and `currentAlbumId` follows the
 * photo — so with a real phone's album list (150+) a plain ScrollView meant
 * mounting 150 native Pressables and re-sorting all of them once per photo.
 */
function AlbumChips({
  albums,
  currentAlbumId,
  onSelect,
  onCreate,
  onCurrentPress = null, // tap the ✓ chip to UNDO this session's move
  dark = false,
  showCreate = true,
  sortByUsageEnabled = true,
}) {
  const { colors, t } = useSettings();
  const [usage, setUsage] = useState({});
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => {
    if (!sortByUsageEnabled) return;
    getUsage().then(setUsage);
  }, [currentAlbumId, albums.length, sortByUsageEnabled]);

  const currentAlbum = useMemo(
    () => albums.find((a) => a.id === currentAlbumId) || null,
    [albums, currentAlbumId]
  );
  const others = useMemo(
    () => {
      const filtered = albums.filter((a) => a.id !== currentAlbumId);
      return sortByUsageEnabled ? sortByUsage(filtered, usage) : filtered;
    },
    [albums, currentAlbumId, sortByUsageEnabled, usage]
  );

  // Scrim chips: the row floats OVER photos/videos, so theme colors can't
  // guarantee contrast (white card on a white photo is invisible). A dark
  // translucent scrim with white text reads on ANY background.
  const chipBg = 'rgba(0,0,0,0.45)';
  const chipFg = '#fff';

  const renderChip = useCallback(
    ({ item }) => (
      <Pressable
        style={[styles.chip, { backgroundColor: chipBg }]}
        onPress={() => onSelect(item)}
        hitSlop={{ top: 8, bottom: 8 }}
        android_ripple={{ color: 'rgba(255,255,255,0.18)' }}
        accessibilityRole="button"
        accessibilityLabel={item.title}
      >
        <Text style={[styles.chipText, { color: chipFg }]} numberOfLines={1}>
          {item.title}
        </Text>
      </Pressable>
    ),
    [onSelect]
  );

  return (
    <>
      <FlatList
        horizontal
        data={others}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderChip}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={3}
        removeClippedSubviews
        ListHeaderComponent={showCreate || currentAlbum ? (
          <View style={styles.header}>
            {/* 1) fixed: create new album */}
            {showCreate && (
              <Pressable
                style={[styles.chip, { backgroundColor: chipBg }]}
                hitSlop={{ top: 8, bottom: 8 }}
                android_ripple={{
                  color: 'rgba(255,255,255,0.18)',
                }}
                accessibilityRole="button"
                accessibilityLabel={t('new_album')}
                onPress={() => {
                  setName('');
                  setCreating(true);
                }}
              >
                <Ionicons name="add" size={16} color={chipFg} />
              </Pressable>
            )}

            {/* 2) current item's album (follows the item) — solid accent so
                the ✓ chip stands out from the scrim chips on any background.
                When this session moved the item here, tapping the chip UNDOES
                the move (small × shows the affordance). */}
            {currentAlbum && (
              <Pressable
                disabled={!onCurrentPress}
                onPress={onCurrentPress || undefined}
                hitSlop={{ top: 8, bottom: 8 }}
                android_ripple={{
                  color: 'rgba(255,255,255,0.18)',
                }}
                accessibilityRole="button"
                accessibilityLabel={currentAlbum.title}
                accessibilityState={{ disabled: !onCurrentPress }}
                style={[styles.chip, { backgroundColor: colors.accent }]}
              >
                <Ionicons
                  name={onCurrentPress ? 'close-circle' : 'checkmark'}
                  size={14}
                  color="#fff"
                />
                <Text
                  style={[styles.chipText, { color: '#fff' }]}
                  numberOfLines={1}
                >
                  {currentAlbum.title}
                </Text>
              </Pressable>
            )}
          </View>
        ) : null}
      />

      {/* Create-album dialog */}
      <Modal
        visible={creating}
        transparent
        animationType="fade"
        onRequestClose={() => setCreating(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setCreating(false)}>
          <Pressable
            style={[styles.dialog, { backgroundColor: colors.card }]}
            onPress={() => {}}
          >
            <Text style={[styles.dialogTitle, { color: colors.text }]}>
              {t('new_album')}
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={t('album_name_placeholder')}
              placeholderTextColor={colors.subtext}
              autoFocus
              style={[
                styles.input,
                { color: colors.text, borderColor: colors.border },
              ]}
            />
            <View style={styles.dialogRow}>
              <Pressable
                style={[styles.dialogBtn, { backgroundColor: colors.chartTrack }]}
                onPress={() => setCreating(false)}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>
                  {t('cancel')}
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.dialogBtn,
                  {
                    backgroundColor: name.trim()
                      ? colors.accent
                      : colors.chartTrack,
                  },
                ]}
                disabled={!name.trim()}
                onPress={() => {
                  setCreating(false);
                  onCreate(name.trim());
                }}
              >
                <Text
                  style={{
                    color: name.trim() ? '#fff' : colors.subtext,
                    fontWeight: '700',
                  }}
                >
                  {t('create')}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

// The cleaning screen re-renders on every swipe. Nothing here changes unless
// the album list, the current album or a handler does.
export default React.memo(AlbumChips);

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 12,
    gap: 8,
    alignItems: 'center',
  },
  // The [+] and [✓] chips ride in ListHeaderComponent, which sits OUTSIDE
  // contentContainerStyle's gap — so it carries its own.
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginRight: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
    maxWidth: 160,
    overflow: 'hidden',
  },
  chipText: { fontSize: 13, fontWeight: '600' },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 32,
  },
  dialog: { borderRadius: 20, padding: 20 },
  dialogTitle: { fontSize: 17, fontWeight: '700', marginBottom: 12 },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 14,
  },
  dialogRow: { flexDirection: 'row', gap: 10 },
  dialogBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
});
