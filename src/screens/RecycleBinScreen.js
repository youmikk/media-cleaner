import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import { useTrash } from '../context/AppContext';
import * as trashManager from '../utils/trashManager';
import { formatBytes } from '../utils/albumHelpers';
import { getTrashImageThumbnail, getVideoThumbnail } from '../utils/thumbCache';
import { Image } from 'expo-image';
import IconButton from '../components/IconButton';
import { showAppAlert } from '../components/AppDialog';

const RECYCLE_ROW_HEIGHT = 86;
const RECYCLE_ROW_GAP = 8;
const RECYCLE_ITEM_LENGTH = RECYCLE_ROW_HEIGHT + RECYCLE_ROW_GAP;
// Column counts offered by the grid toggle. Tapping the chip cycles through
// them, so keep the list short — three sensible densities, not a slider.
const COLUMN_CHOICES = [3, 4, 5];
const GRID_GAP = 6;
const SCREEN_PADDING = 16;

/**
 * Recycle bin: 30-day retention list with multi-select restore / permanent
 * delete. Items with fewer than 7 days remaining are shown in red.
 *
 * Two layouts: the detailed row list, and a thumbnail grid whose tiles carry
 * a translucent size strip along the bottom edge. The choice (and the grid
 * density) is persisted — browsing a few hundred deleted photos is a lot
 * easier in the grid, and re-picking it on every visit got old fast.
 */
export default function RecycleBinScreen({ navigation }) {
  const { colors, t, settings, setSetting } = useSettings();
  const { trash, refreshTrash } = useTrash();
  const { width } = useWindowDimensions();
  const [selected, setSelected] = useState({});
  const [busy, setBusy] = useState(false);
  const [thumbs, setThumbs] = useState({});
  const thumbGenerationRef = useRef(0);
  const thumbPendingRef = useRef(new Set());
  const requestThumbsRef = useRef(null);

  const isGrid = settings.recycleView === 'grid';
  const columns = COLUMN_CHOICES.includes(settings.recycleColumns)
    ? settings.recycleColumns
    : COLUMN_CHOICES[0];
  const tileSize =
    (width - SCREEN_PADDING * 2 - GRID_GAP * (columns - 1)) / columns;

  const cycleColumns = () => {
    const next =
      COLUMN_CHOICES[
        (COLUMN_CHOICES.indexOf(columns) + 1) % COLUMN_CHOICES.length
      ];
    setSetting('recycleColumns', next);
  };

  useFocusEffect(
    useCallback(() => {
      refreshTrash();
    }, [refreshTrash])
  );

  requestThumbsRef.current = async (entries) => {
    const generation = thumbGenerationRef.current;
    const needed = (entries || []).filter(
      (entry) =>
        !thumbs[entry.fileUri] && !thumbPendingRef.current.has(entry.fileUri)
    );
    needed.forEach((entry) => thumbPendingRef.current.add(entry.fileUri));
    try {
      for (let i = 0; i < needed.length; i += 4) {
          const batch = needed.slice(i, i + 4);
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
          if (generation !== thumbGenerationRef.current) return;
          setThumbs((current) => ({
            ...current,
            ...Object.fromEntries(results.filter(([, uri]) => !!uri)),
          }));
      }
    } finally {
      needed.forEach((entry) => thumbPendingRef.current.delete(entry.fileUri));
    }
  };

  useFocusEffect(
    useCallback(() => {
      thumbGenerationRef.current++;
      requestThumbsRef.current?.(trash.slice(0, 12));
      return () => {
        thumbGenerationRef.current++;
      };
    }, [trash])
  );

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    requestThumbsRef.current?.(viewableItems.map((item) => item.item));
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;

  const selectedEntries = trash.filter((e) => selected[e.fileUri]);
  const allSelected = trash.length > 0 && selectedEntries.length === trash.length;
  const trashBytes = useMemo(
    () => trash.reduce((total, entry) => total + (Number(entry.size) || 0), 0),
    [trash]
  );

  const toggleOne = (item) =>
    setSelected((s) => ({ ...s, [item.fileUri]: !s[item.fileUri] }));

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
          await trashManager.restoreFromTrash(entry, { remove: false });
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
      if (failed > 0) {
        showAppAlert(t('recycle_bin'), t('restore_failed_some'));
      }
    }
  };

  const deleteSelected = () => {
    showAppAlert(t('delete_forever'), '', [
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

  const renderRow = (item) => {
    const isSel = !!selected[item.fileUri];
    const urgent = item.daysLeft < 7;
    const thumb = thumbs[item.fileUri];
    return (
      <Pressable
        style={[styles.row, { backgroundColor: colors.card }]}
        onPress={() => toggleOne(item)}
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
  };

  const renderTile = (item) => {
    const isSel = !!selected[item.fileUri];
    const urgent = item.daysLeft < 7;
    const thumb = thumbs[item.fileUri];
    return (
      <Pressable
        style={[
          styles.tile,
          {
            width: tileSize,
            height: tileSize,
            backgroundColor: colors.card,
            borderColor: isSel ? colors.accent : 'transparent',
          },
        ]}
        onPress={() => toggleOne(item)}
      >
        {thumb ? (
          <Image
            source={{ uri: thumb }}
            style={styles.thumb}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={100}
          />
        ) : (
          <View style={styles.tilePlaceholder}>
            <Ionicons
              name={item.mediaType === 'video' ? 'videocam' : 'image'}
              size={22}
              color={colors.subtext}
            />
          </View>
        )}
        {item.mediaType === 'video' && (
          <View style={styles.tileVideoBadge}>
            <Ionicons name="play" size={10} color="#fff" />
          </View>
        )}
        {/* Translucent strip along the bottom edge: file size, plus the
            days-left counter once it turns urgent. Pure white on the scrim
            rather than a theme colour — it sits over arbitrary photo pixels. */}
        <View style={styles.tileFooter}>
          <Text style={styles.tileFooterText} numberOfLines={1}>
            {formatBytes(item.size)}
          </Text>
          {urgent && (
            <Text style={[styles.tileFooterText, styles.tileFooterUrgent]}>
              {item.daysLeft}d
            </Text>
          )}
        </View>
        {isSel && (
          <View style={[styles.tileCheck, { backgroundColor: colors.accent }]}>
            <Ionicons name="checkmark" size={13} color="#fff" />
          </View>
        )}
      </Pressable>
    );
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.topBar}>
        <IconButton
          name="chevron-back"
          label={t('back')}
          onPress={() => navigation.goBack()}
          color={colors.text}
          iconSize={26}
        />
        <Text style={[styles.title, { color: colors.text }]}>
          {t('recycle_bin')}
        </Text>
        <IconButton
          name={isGrid ? 'list-outline' : 'grid-outline'}
          label={t(isGrid ? 'recycle_view_list' : 'recycle_view_grid')}
          onPress={() => setSetting('recycleView', isGrid ? 'list' : 'grid')}
          color={colors.accent}
        />
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
          <View style={styles.toolBar}>
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
            {isGrid && (
              <Pressable
                style={[styles.columnChip, { backgroundColor: colors.card }]}
                onPress={cycleColumns}
              >
                <Ionicons name="apps-outline" size={14} color={colors.subtext} />
                <Text style={{ color: colors.subtext, fontSize: 12, fontWeight: '700' }}>
                  {t('recycle_columns', { count: columns })}
                </Text>
              </Pressable>
            )}
          </View>
          <Text style={[styles.totalSize, { color: colors.subtext }]}>
            {t('recycle_usage', { size: formatBytes(trashBytes) })}
          </Text>

          <FlatList
            // numColumns cannot change on a mounted FlatList, so the layout
            // and density are baked into the key and it remounts instead.
            key={isGrid ? `grid-${columns}` : 'list'}
            data={trash}
            keyExtractor={(item) => item.fileUri}
            numColumns={isGrid ? columns : 1}
            columnWrapperStyle={isGrid ? styles.gridRow : undefined}
            contentContainerStyle={{ paddingBottom: 140 }}
            // Every row has a fixed 58px thumbnail plus 14px vertical padding;
            // telling FlatList the exact geometry avoids measuring each row
            // while scrolling a large recycle bin. In grid mode FlatList
            // passes getItemLayout straight through to VirtualizedList, whose
            // item count is Math.ceil(n / numColumns) — so the index here is a
            // ROW index, not an item index, and the square tiles make the row
            // pitch known up front.
            getItemLayout={
              isGrid
                ? (_, rowIndex) => ({
                    length: tileSize + GRID_GAP,
                    offset: (tileSize + GRID_GAP) * rowIndex,
                    index: rowIndex,
                  })
                : (_, index) => ({
                    length: RECYCLE_ITEM_LENGTH,
                    offset: RECYCLE_ITEM_LENGTH * index,
                    index,
                  })
            }
            renderItem={({ item }) => (isGrid ? renderTile(item) : renderRow(item))}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
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
  toolBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  columnChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
  },
  gridRow: { gap: GRID_GAP, marginBottom: GRID_GAP },
  tile: {
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 2,
  },
  tilePlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(128,128,128,0.12)',
  },
  tileFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    paddingHorizontal: 5,
    paddingVertical: 3,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  tileFooterText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  tileFooterUrgent: { color: '#ff6b6b' },
  tileVideoBadge: {
    position: 'absolute',
    left: 4,
    top: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  tileCheck: {
    position: 'absolute',
    right: 4,
    top: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
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
