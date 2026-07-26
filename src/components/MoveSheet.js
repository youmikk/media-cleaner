import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { useSettings } from '../context/SettingsContext';

/**
 * Bottom sheet listing target albums for "Move to Album".
 */
export default function MoveSheet({ visible, excludeAlbumId, onClose, onSelect }) {
  const { colors, t } = useSettings();
  const [albums, setAlbums] = useState([]);

  useEffect(() => {
    if (!visible) return;
    MediaLibrary.getAlbumsAsync()
      .then((all) =>
        setAlbums(all.filter((a) => a.id !== excludeAlbumId))
      )
      .catch(() => setAlbums([]));
  }, [visible, excludeAlbumId]);

  return (
    <Modal visible={visible} transparent animationType="slide">
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.card }]}
          onPress={() => {}}
        >
          <Text style={[styles.title, { color: colors.text }]}>
            {t('move_to_album')}
          </Text>
          <FlatList
            data={albums}
            keyExtractor={(item) => item.id}
            style={{ maxHeight: 380 }}
            renderItem={({ item }) => (
              <Pressable style={styles.row} onPress={() => onSelect(item)}>
                <Ionicons name="folder-outline" size={20} color={colors.accent} />
                <Text style={[styles.rowText, { color: colors.text }]} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={[styles.count, { color: colors.subtext }]}>
                  {item.assetCount}
                </Text>
              </Pressable>
            )}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
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
    gap: 12,
    paddingVertical: 13,
  },
  rowText: { flex: 1, fontSize: 15 },
  count: { fontSize: 13 },
});
