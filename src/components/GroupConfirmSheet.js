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
  // A delete is running. Everything that could advance the group or clear
  // marks must be inert until it settles — the deletion captured its target
  // list already, so a competing "keep all" would delete photos the user
  // just spared and skip an unseen group.
  busy = false,
  busyLabel = null,
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
      onRequestClose={busy ? undefined : onClose}
    >
      <Pressable style={styles.backdrop} onPress={busy ? undefined : onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.card }]}
          onPress={() => {}}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>
              {t('confirm_delete_title', { count: assets.length })}
            </Text>
            <Pressable
              disabled={busy}
              onPress={onClose}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t('close')}
              accessibilityState={{ disabled: busy }}
              style={({ pressed }) => [
                styles.closeButton,
                pressed && { backgroundColor: colors.chartTrack },
              ]}
            >
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
                disabled={busy}
                onPress={() => setViewer({ list: assets, index })} // tap = enlarge
                style={{ width: cell, height: cell }}
                accessibilityRole="button"
                accessibilityLabel={t('details')}
              >
                <Image
                  source={{ uri: thumbs[item.id] || item.uri }}
                  style={styles.thumb}
                  cachePolicy="memory-disk"
                  recyclingKey={item.id}
                />
                {/* circle badge = spare this one */}
                <Pressable
                  disabled={busy}
                  hitSlop={8}
                  onPress={() => onUnmark(item.id)}
                  style={[styles.mark, { backgroundColor: colors.danger }]}
                  accessibilityRole="button"
                  accessibilityLabel={t('viewer_marked')}
                  accessibilityState={{ selected: true, disabled: busy }}
                >
                  <Ionicons name="trash" size={15} color="#fff" />
                </Pressable>
              </Pressable>
            )}
          />
          <View style={styles.buttons}>
            <Pressable
              disabled={busy}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              style={[
                styles.btn,
                { backgroundColor: colors.chartTrack, opacity: busy ? 0.5 : 1 },
              ]}
              onPress={onKeepAll}
            >
              <Text style={[styles.btnText, { color: colors.text }]}>
                {t('keep_all')}
              </Text>
            </Pressable>
            <Pressable
              disabled={busy || assets.length === 0}
              accessibilityRole="button"
              accessibilityState={{
                disabled: busy || assets.length === 0,
              }}
              style={[
                styles.btn,
                {
                  backgroundColor:
                    assets.length === 0 ? colors.chartTrack : colors.danger,
                  opacity: busy ? 0.6 : 1,
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
                {busy
                  ? busyLabel || t('deleting')
                  : `${t('delete_all_marked')} (${assets.length})`}
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
          if (busy) return;
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
  closeButton: {
    width: 44,
    height: 44,
    marginVertical: -10,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumb: { width: '100%', height: '100%', borderRadius: 10 },
  mark: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 28,
    height: 28,
    borderRadius: 14,
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
