import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
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
 */
export default function AlbumChips({
  albums,
  currentAlbumId,
  onSelect,
  onCreate,
  dark = false,
}) {
  const { colors, t } = useSettings();
  const [usage, setUsage] = useState({});
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => {
    getUsage().then(setUsage);
  }, [currentAlbumId, albums.length]);

  const currentAlbum = useMemo(
    () => albums.find((a) => a.id === currentAlbumId) || null,
    [albums, currentAlbumId]
  );
  const others = useMemo(
    () =>
      sortByUsage(
        albums.filter((a) => a.id !== currentAlbumId),
        usage
      ),
    [albums, currentAlbumId, usage]
  );

  // Scrim chips: the row floats OVER photos/videos, so theme colors can't
  // guarantee contrast (white card on a white photo is invisible). A dark
  // translucent scrim with white text reads on ANY background.
  const chipBg = 'rgba(0,0,0,0.45)';
  const chipFg = '#fff';

  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {/* 1) fixed: create new album */}
        <Pressable
          style={[styles.chip, { backgroundColor: chipBg }]}
          onPress={() => {
            setName('');
            setCreating(true);
          }}
        >
          <Ionicons name="add" size={16} color={chipFg} />
        </Pressable>

        {/* 2) current item's album (follows the item) — solid accent so the
            ✓ chip stands out from the scrim chips on any background */}
        {currentAlbum && (
          <View style={[styles.chip, { backgroundColor: colors.accent }]}>
            <Ionicons name="checkmark" size={14} color="#fff" />
            <Text style={[styles.chipText, { color: '#fff' }]} numberOfLines={1}>
              {currentAlbum.title}
            </Text>
          </View>
        )}

        {/* 3) the rest, by usage frequency */}
        {others.map((album) => (
          <Pressable
            key={album.id}
            style={[styles.chip, { backgroundColor: chipBg }]}
            onPress={() => onSelect(album)}
          >
            <Text style={[styles.chipText, { color: chipFg }]} numberOfLines={1}>
              {album.title}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

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

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 12,
    gap: 8,
    alignItems: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
    maxWidth: 160,
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
