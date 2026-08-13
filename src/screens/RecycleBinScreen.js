import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { useSettings } from '../context/SettingsContext';
import { useApp } from '../context/AppContext';
import * as trashManager from '../utils/trashManager';
import { formatBytes } from '../utils/albumHelpers';
import { getTrashImageThumbnail, getVideoThumbnail } from '../utils/thumbCache';
import { Image } from 'expo-image';

const RECYCLE_ROW_HEIGHT = 86;
const RECYCLE_ROW_GAP = 8;
const RECYCLE_ITEM_LENGTH = RECYCLE_ROW_HEIGHT + RECYCLE_ROW_GAP;

/**
 * Recycle bin: 30-day retention list with multi-select restore / permanent
 * delete. Items with fewer than 7 days remaining are shown in red.
 */
export default function RecycleBinScreen({ navigation }) {
  const { colors, t } = useSettings();
  const { trash, refreshTrash } = useApp();
  const [selected, setSelected] = useState({});
  const [busy, setBusy] = useState(false);
  const [thumbs, setThumbs] = useState({});

  useFocusEffect(
    useCallback(() => {
      refreshTrash();
    }, [refreshTrash])
  );

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        // Limit work to four files at a time so opening the recycle bin does
        // not decode every original image concurrently.
        for (let i = 0; i < trash.length; i += 4) {
          const batch = trash.slice(i, i + 4);
          const results = await Promise.all(
            batch.map(async (entry) => {
              try {
                const uri =
                  entry.mediaType === 'video'
                    ? await getVideoThumbnail({
                        id: entry.id,
                        uri: entry.fileUri,
                        localUri: entry.fileUri,
                      })
                    : await getTrashImageThumbnail(entry);
                return [entry.fileUri, uri];
              } catch (e) {
                return [entry.fileUri, null];
              }
            })
          );
          if (!alive) return;
          setThumbs((current) => ({
            ...current,
            ...Object.fromEntries(results),
          }));
        }
      })();
      return () => {
        alive = false;
      };
    }, [trash])
  );

  const selectedEntries = trash.filter((e) => selected[e.fileUri]);
  const allSelected = trash.length > 0 && selectedEntries.length === trash.length;
  const trashBytes = useMemo(
    () => trash.reduce((total, entry) => total + (Number(entry.size) || 0), 0),
    [trash]
  );

  const toggleAll = () => {
    if (allSelected) setSelected({});
    else {
      const next = {};
      trash.forEach((e) => {
        next[e.fileUri] = true;
      });
      setSelected(next);
    }
  };

  // Restores go one at a time (each is a separate createAssetAsync), but the
  // index is rewritten ONCE at the end — the old code did a full
  // read+serialise+write of the whole index per entry, so restoring a few
  // hundred items rewrote megabytes over and over.
  const restoreSelected = async () => {
    if (busy) return;
    setBusy(true);
    const restored = [];
    let failed = 0;
    try {
      for (const entry of selectedEntries) {
        try {
          await MediaLibrary.createAssetAsync(entry.fileUri);
          restored.push(entry);
        } catch (e) {
          failed++; // backing file missing — leave the row in place
        }
      }
      if (restored.length > 0) {
        await trashManager.removeManyFromTrash(restored);
      }
    } finally {
      setBusy(false);
      setSelected({});
      refreshTrash();
      if (failed > 0) Alert.alert(t('recycle_bin'), t('restore_failed_some'));
    }
  };

  const deleteSelected = () => {
    Alert.alert(t('delete_forever'), '', [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('delete_forever'),
        style: 'destructive',
        onPress: async () => {
          if (busy) return;
          setBusy(true);
          try {
            await trashManager.removeManyFromTrash(selectedEntries);
          } finally {
            setBusy(false);
            setSelected({});
            refreshTrash();
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.topBar}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>
          {t('recycle_bin')}
        </Text>
        <View style={{ width: 26 }} />
      </View>

      {trash.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="trash-bin-outline" size={48} color={colors.subtext} />
          <Text style={[styles.emptyText, { color: colors.subtext }]}>
            {t('recycle_empty')}
          </Text>
        </View>
      ) : (
        <>
          <Pressable style={styles.selectAll} onPress={toggleAll}>
            <Ionicons
              name={allSelected ? 'checkbox' : 'square-outline'}
              size={20}
              color={colors.accent}
            />
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>
              {t('select_all')}
            </Text>
          </Pressable>
          <Text style={[styles.totalSize, { color: colors.subtext }]}>
            {t('recycle_usage', { size: formatBytes(trashBytes) })}
          </Text>

          <FlatList
            data={trash}
            keyExtractor={(item) => item.fileUri}
            contentContainerStyle={{ paddingBottom: 140 }}
            // Every row has a fixed 58px thumbnail plus 14px vertical padding;
            // telling FlatList the exact geometry avoids measuring each row
            // while scrolling a large recycle bin.
            getItemLayout={(_, index) => ({
              length: RECYCLE_ITEM_LENGTH,
              offset: RECYCLE_ITEM_LENGTH * index,
              index,
            })}
            renderItem={({ item }) => {
              const isSel = !!selected[item.fileUri];
              const urgent = item.daysLeft < 7;
              const thumb = thumbs[item.fileUri];
              return (
                <Pressable
                  style={[styles.row, { backgroundColor: colors.card }]}
                  onPress={() =>
                    setSelected((s) => ({ ...s, [item.fileUri]: !s[item.fileUri] }))
                  }
                >
                  <Ionicons
                    name={isSel ? 'checkbox' : 'square-outline'}
                    size={20}
                    color={isSel ? colors.accent : colors.subtext}
                  />
                  <View style={styles.thumbWrap}>
                    {thumb ? (
                      <Image
                        source={{ uri: thumb }}
                        style={styles.thumb}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        transition={100}
                      />
                    ) : (
                      <Ionicons
                        name={item.mediaType === 'video' ? 'videocam' : 'image'}
                        size={20}
                        color={colors.subtext}
                      />
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}
                      numberOfLines={1}
                    >
                      {item.filename}
                    </Text>
                    <Text style={{ color: colors.subtext, fontSize: 12, marginTop: 2 }}>
                      {formatBytes(item.size)}
                    </Text>
                  </View>
                  <Text
                    style={{
                      color: urgent ? colors.danger : colors.subtext,
                      fontSize: 12,
                      fontWeight: urgent ? '800' : '500',
                    }}
                  >
                    {t('days_left', { days: item.daysLeft })}
                  </Text>
                </Pressable>
              );
            }}
          />

          {selectedEntries.length > 0 && (
            <View style={styles.actions}>
              <Pressable
                style={[styles.actionBtn, { backgroundColor: colors.accent }]}
                onPress={restoreSelected}
              >
                <Ionicons name="refresh" size={16} color="#fff" />
                <Text style={styles.actionText}>
                  {t('restore')} ({selectedEntries.length})
                </Text>
              </Pressable>
              <Pressable
                style={[styles.actionBtn, { backgroundColor: colors.danger }]}
                onPress={deleteSelected}
              >
                <Ionicons name="trash" size={16} color="#fff" />
                <Text style={styles.actionText}>
                  {t('delete_forever')} ({selectedEntries.length})
                </Text>
              </Pressable>
            </View>
          )}
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  title: { fontSize: 18, fontWeight: '800' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyText: { fontSize: 14 },
  selectAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  totalSize: {
    fontSize: 13,
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: RECYCLE_ROW_HEIGHT,
    borderRadius: 14,
    paddingHorizontal: 14,
    marginBottom: RECYCLE_ROW_GAP,
  },
  thumbWrap: {
    width: 58,
    height: 58,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: 'rgba(128,128,128,0.12)',
  },
  thumb: { width: '100%', height: '100%' },
  actions: {
    position: 'absolute',
    bottom: 30,
    left: 16,
    right: 16,
    flexDirection: 'row',
    gap: 10,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 14,
    paddingVertical: 13,
  },
  actionText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
