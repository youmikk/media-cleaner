import React, { useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import PhotoViewer from './PhotoViewer';

/**
 * End-of-group DELETE confirmation. Shows ONLY the photos/videos marked for
 * deletion. Tap a thumbnail to view it FULL SCREEN (zoomable); tap its
 * circle badge to spare it. Buttons: Keep all (advance, delete nothing) /
 * Delete (n) — one system dialog. Closing (X / backdrop / Android back)
 * returns to the group without advancing.
 */
export default function GroupConfirmSheet({
  visible,
  assets, // marked-for-deletion assets ONLY
  onUnmark,
  onRemark = null, // re-mark from inside the viewer (optional)
  onClose,
  onKeepAll,
  onDelete,
  thumbs = {},
}) {
  const { colors, t } = useSettings();
  const { width } = useWindowDimensions();
  const cell = (width - 16 * 2 - 8 * 3) / 4;

  // Full-screen viewer: the list is FROZEN at open time so unmarking a
  // photo doesn't yank it out from under the user mid-view; the mark state
  // itself stays live.
  const [viewer, setViewer] = useState(null); // {list, index} | null
  const markedMap = useMemo(
    () => Object.fromEntries(assets.map((a) => [a.id, true])),
    [assets]
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.card }]}
          onPress={() => {}}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>
              {t('confirm_delete_title', { count: assets.length })}
            </Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.subtext} />
            </Pressable>
          </View>
          <Text style={[styles.hint, { color: colors.subtext }]}>
            {t('confirm_delete_hint')}
          </Text>
          <FlatList
            data={assets}
            numColumns={4}
            keyExtractor={(item) => item.id}
            columnWrapperStyle={{ gap: 8 }}
            contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
            style={{ maxHeight: 300 }}
            renderItem={({ item, index }) => (
              <Pressable
                onPress={() => setViewer({ list: assets, index })} // tap = enlarge
                style={{ width: cell, height: cell }}
              >
                <Image
                  source={{ uri: thumbs[item.id] || item.uri }}
                  style={styles.thumb}
                  cachePolicy="memory-disk"
                  recyclingKey={item.id}
                />
                {/* circle badge = spare this one */}
                <Pressable
                  hitSlop={8}
                  onPress={() => onUnmark(item.id)}
                  style={[styles.mark, { backgroundColor: colors.danger }]}
                >
                  <Ionicons name="trash" size={13} color="#fff" />
                </Pressable>
              </Pressable>
            )}
          />
          <View style={styles.buttons}>
            <Pressable
              style={[styles.btn, { backgroundColor: colors.chartTrack }]}
              onPress={onKeepAll}
            >
              <Text style={[styles.btnText, { color: colors.text }]}>
                {t('keep_all')}
              </Text>
            </Pressable>
            <Pressable
              disabled={assets.length === 0}
              style={[
                styles.btn,
                {
                  backgroundColor:
                    assets.length === 0 ? colors.chartTrack : colors.danger,
                },
              ]}
              onPress={onDelete}
            >
              <Text
                style={[
                  styles.btnText,
                  { color: assets.length === 0 ? colors.subtext : '#fff' },
                ]}
              >
                {t('delete_all_marked')} ({assets.length})
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>

      <PhotoViewer
        visible={viewer !== null}
        assets={viewer ? viewer.list : []}
        initialIndex={viewer ? viewer.index : 0}
        onClose={() => setViewer(null)}
        selected={markedMap}
        onToggleSelect={(id) => {
          if (markedMap[id]) onUnmark(id);
          else if (onRemark) onRemark(id);
        }}
        thumbs={thumbs}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 16,
    paddingBottom: 30,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  title: { fontSize: 17, fontWeight: '700', flex: 1, marginRight: 8 },
  hint: { fontSize: 12, marginBottom: 12 },
  thumb: { width: '100%', height: '100%', borderRadius: 10 },
  mark: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 10 },
  btn: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
  },
  btnText: { fontSize: 14, fontWeight: '700' },
});
