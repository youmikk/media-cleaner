import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

/**
 * Button + modal list to pick a source album.
 */
export default function AlbumPicker({ albums, selected, onSelect }) {
  const { colors, t } = useSettings();
  const [open, setOpen] = useState(false);
  const current = albums.find((a) => a.id === selected);

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
        <Ionicons name="chevron-down" size={16} color={colors.subtext} />
      </Pressable>

      <Modal visible={open} transparent animationType="slide">
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
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
                  {item.assetCount !== undefined && (
                    <Text style={[styles.count, { color: colors.subtext }]}>
                      {item.assetCount}
                    </Text>
                  )}
                  {item.id === selected && (
                    <Ionicons name="checkmark" size={18} color={colors.accent} />
                  )}
                </Pressable>
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
    maxWidth: 200,
  },
  buttonText: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    maxHeight: '70%',
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
