import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  Switch,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { useSettings } from '../context/SettingsContext';
import { useStats } from '../context/AppContext';
import { batchDelete } from '../utils/deletionManager';
import {
  getAssets,
  getAssetSizes,
  formatBytes,
  ALL_ALBUM_ID,
} from '../utils/albumHelpers';

// react-native-compressor is a native module: available in EAS/dev builds,
// absent in Expo Go — degrade gracefully for videos there.
let VideoCompressor = null;
try {
  // eslint-disable-next-line global-require
  VideoCompressor = require('react-native-compressor').Video;
} catch (e) {
  VideoCompressor = null;
}

const QUALITIES = [
  { key: 'high', value: 0.8 },
  { key: 'medium', value: 0.6 },
  { key: 'low', value: 0.4 },
];
// Rough post-compression size ratios (shown as estimates in the UI).
const IMG_RATIO = { high: 0.7, medium: 0.45, low: 0.25 };
const VID_RATIO = { high: 0.5, medium: 0.35, low: 0.2 };
const SCAN_CAP = 200;
const LIST_MAX = 100; // hard cap on rendered rows
const MB = 1024 * 1024;
const MIN_SIZE_OPTIONS = [5, 10, 20, 50]; // "only show files over X MB"

/**
 * 压缩工具 — pick the biggest photos/videos, re-encode them at a chosen
 * quality, save the compressed copies and optionally delete the originals.
 * Photos: expo-image-manipulator. Videos: react-native-compressor.
 */
export default function CompressScreen({ navigation }) {
  const { colors, t, recycleBinActive } = useSettings();
  const { recordCleaned } = useStats();

  const [allSized, setAllSized] = useState(null); // every scanned file+size
  const [minMB, setMinMB] = useState(10); // only show files over X MB
  const [selected, setSelected] = useState({});
  const [quality, setQuality] = useState('medium');
  const [deleteOriginal, setDeleteOriginal] = useState(false);
  const [progress, setProgress] = useState(null); // {done, total}

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [photos, videos] = await Promise.all([
          getAssets(ALL_ALBUM_ID, 'photo'),
          getAssets(ALL_ALBUM_ID, 'video'),
        ]);
        const pool = [...photos.slice(0, SCAN_CAP), ...videos.slice(0, SCAN_CAP)];
        // ONE batched size query (native) instead of hundreds of stats.
        const sizeMap = await getAssetSizes(pool);
        if (!alive) return;
        const sized = pool
          .map((a) => ({ ...a, size: sizeMap[a.id] || 0 }))
          .filter((i) => i.size > 0);
        setAllSized(sized.sort((x, y) => y.size - x.size));
      } catch (e) {
        if (alive) setAllSized([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Only files over the threshold reach the list — switching the threshold
  // is instant (no rescan), and the list is hard-capped for smoothness.
  const items = React.useMemo(
    () =>
      allSized === null
        ? null
        : allSized.filter((i) => i.size >= minMB * MB).slice(0, LIST_MAX),
    [allSized, minMB]
  );

  const selectedItems = (items || []).filter((i) => selected[i.id]);
  const q = QUALITIES.find((x) => x.key === quality).value;

  const estimateFor = (item) =>
    Math.round(
      item.size *
        (item.mediaType === 'video' ? VID_RATIO[quality] : IMG_RATIO[quality])
    );
  const selectedAfter = selectedItems.reduce((s, i) => s + estimateFor(i), 0);
  const selectedBefore = selectedItems.reduce((s, i) => s + i.size, 0);

  // Set to false to abort between items. Compressing a single video can take
  // minutes; without this the loop kept running after the user left the
  // screen, calling setProgress on an unmounted component and finally
  // navigating a screen that was no longer there.
  const runningRef = useRef(false);
  useEffect(() => () => {
    runningRef.current = false;
  }, []);

  const run = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setProgress({ done: 0, total: selectedItems.length });
    let savedBytes = 0;
    let done = 0;
    const failedVideos = [];
    const originalsToDelete = [];

    for (const item of selectedItems) {
      if (!runningRef.current) break; // user left or hit cancel
      // Compressor output lives in the cache directory. It used to be left
      // there forever — both the copies that were imported into the library
      // AND the ones rejected for not being smaller — so compressing 100
      // large files leaked a full second copy of all of them.
      let outUri = null;
      try {
        const info = await MediaLibrary.getAssetInfoAsync(item.id);
        const src = info.localUri || info.uri;

        if (item.mediaType === 'video') {
          if (!VideoCompressor) {
            failedVideos.push(item);
            done += 1;
            if (runningRef.current) setProgress({ done, total: selectedItems.length });
            continue;
          }
          outUri = await VideoCompressor.compress(src, {
            compressionMethod: 'manual',
            bitrate: Math.round(3500000 * q),
          });
        } else {
          const result = await ImageManipulator.manipulateAsync(src, [], {
            compress: q,
            format: ImageManipulator.SaveFormat.JPEG,
          });
          outUri = result.uri;
        }

        if (outUri) {
          const stat = await FileSystem.getInfoAsync(outUri, { size: true });
          const newSize = stat.size || 0;
          if (newSize > 0 && newSize < item.size) {
            await MediaLibrary.createAssetAsync(outUri);
            savedBytes += item.size - newSize;
            if (deleteOriginal) originalsToDelete.push(item);
          }
        }
      } catch (e) {
        // skip failures, keep going
      } finally {
        if (outUri) {
          await FileSystem.deleteAsync(outUri, { idempotent: true }).catch(
            () => {}
          );
        }
      }
      done += 1;
      if (runningRef.current) setProgress({ done, total: selectedItems.length });
    }

    // Delete all originals with ONE system dialog.
    if (originalsToDelete.length > 0) {
      try {
        const res = await batchDelete(originalsToDelete, {
          useRecycleBin: recycleBinActive,
        });
        const goneIds = new Set(res.deletedIds || []);
        const gone = originalsToDelete.filter((i) => goneIds.has(i.id));
        const vids = gone.filter((i) => i.mediaType === 'video');
        const pics = gone.filter((i) => i.mediaType !== 'video');
        // Report the real bytes each category freed. These were previously
        // both passed 0, so compression never showed up in "space saved" —
        // and the two calls raced each other, so one category's count was
        // reliably lost. (statsManager now serialises, but the byte totals
        // still had to be real.)
        const sum = (list) => list.reduce((s, i) => s + (i.size || 0), 0);
        if (vids.length > 0) await recordCleaned('video', vids.length, sum(vids));
        if (pics.length > 0) await recordCleaned('photo', pics.length, sum(pics));
      } catch (e) {
        // user cancelled the deletion dialog — compressed copies remain
      }
    }

    const aborted = !runningRef.current;
    runningRef.current = false;
    setProgress(null);
    setSelected({});
    if (aborted) return; // screen is gone; don't touch navigation
    const message =
      failedVideos.length > 0 ? t('compress_video_unavailable') : '';
    Alert.alert(t('compress_done', { size: formatBytes(savedBytes) }), message, [
      { text: t('done'), onPress: () => navigation.goBack() },
    ]);
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.topBar}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>
          {t('compress_title')}
        </Text>
        <View style={{ width: 26 }} />
      </View>

      {/* Quality picker */}
      <View style={styles.controls}>
        <Text style={[styles.label, { color: colors.text }]}>
          {t('compress_quality')}
        </Text>
        <View style={[styles.segmented, { backgroundColor: colors.chartTrack }]}>
          {QUALITIES.map((opt) => (
            <Pressable
              key={opt.key}
              onPress={() => setQuality(opt.key)}
              style={[
                styles.segment,
                quality === opt.key && { backgroundColor: colors.card },
              ]}
            >
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: '600',
                  color: quality === opt.key ? colors.accent : colors.subtext,
                }}
              >
                {t(`quality_${opt.key}`)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {/* Minimum-size filter: keep the list small and smooth */}
      <View style={styles.controls}>
        <Text style={[styles.label, { color: colors.text }]}>
          {t('compress_min_size')}
        </Text>
        <View style={[styles.segmented, { backgroundColor: colors.chartTrack }]}>
          {MIN_SIZE_OPTIONS.map((mb) => (
            <Pressable
              key={mb}
              onPress={() => setMinMB(mb)}
              style={[
                styles.segment,
                minMB === mb && { backgroundColor: colors.card },
              ]}
            >
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: '600',
                  color: minMB === mb ? colors.accent : colors.subtext,
                }}
              >
                {mb}MB
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.controls}>
        <Text style={[styles.label, { color: colors.text }]}>
          {t('compress_delete_original')}
        </Text>
        <Switch
          value={deleteOriginal}
          onValueChange={setDeleteOriginal}
          trackColor={{ true: colors.accent }}
        />
      </View>

      {/* Honest disclosure: re-encoding drops EXIF (capture time, GPS…). */}
      <Text style={[styles.note, { color: colors.subtext }]}>
        {t('compress_note')}
      </Text>

      {selectedItems.length > 0 && (
        <Text style={[styles.summary, { color: colors.text }]}>
          {t('compress_selected_summary', {
            count: selectedItems.length,
            after: formatBytes(selectedAfter),
            saved: formatBytes(Math.max(0, selectedBefore - selectedAfter)),
          })}
        </Text>
      )}

      {items === null ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.accent} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: 160, paddingTop: 8 }}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={7}
          removeClippedSubviews
          renderItem={({ item }) => {
            const isSel = !!selected[item.id];
            return (
              <Pressable
                style={[styles.row, { backgroundColor: colors.card }]}
                onPress={() =>
                  setSelected((s) => ({ ...s, [item.id]: !s[item.id] }))
                }
              >
                <Ionicons
                  name={isSel ? 'checkbox' : 'square-outline'}
                  size={20}
                  color={isSel ? colors.accent : colors.subtext}
                />
                <Image
                  source={{ uri: item.uri }}
                  style={styles.thumb}
                  cachePolicy="memory-disk"
                  recyclingKey={item.id}
                />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>
                    {item.mediaType === 'video' ? '🎬' : '🖼'} {formatBytes(item.size)}
                  </Text>
                  <Text style={{ color: colors.subtext, fontSize: 11, marginTop: 2 }}>
                    {t('compress_after', { size: formatBytes(estimateFor(item)) })}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}

      {progress ? (
        <View style={[styles.runBtn, { backgroundColor: colors.chartTrack }]}>
          <Text style={[styles.runText, { color: colors.text }]}>
            {t('compressing', progress)}
          </Text>
        </View>
      ) : (
        selectedItems.length > 0 && (
          <Pressable
            style={[styles.runBtn, { backgroundColor: colors.accent }]}
            onPress={run}
          >
            <Text style={styles.runText}>
              {t('compress_run', { count: selectedItems.length })}
            </Text>
          </Pressable>
        )
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
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  label: { fontSize: 14, fontWeight: '600' },
  note: { fontSize: 11, lineHeight: 16, marginBottom: 6 },
  summary: { fontSize: 13, fontWeight: '700', marginBottom: 4 },
  segmented: { flexDirection: 'row', borderRadius: 10, padding: 3 },
  segment: { paddingHorizontal: 14, paddingVertical: 5, borderRadius: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    padding: 10,
    marginBottom: 8,
  },
  thumb: { width: 52, height: 52, borderRadius: 10 },
  runBtn: {
    position: 'absolute',
    bottom: 30,
    left: 16,
    right: 16,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  runText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
