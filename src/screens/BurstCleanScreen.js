import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  SectionList,
  StyleSheet,
  ActivityIndicator,
  useWindowDimensions,
  Alert,
} from 'react-native';
import { Image } from 'expo-image';
import { getVideoThumbnail } from '../utils/thumbCache';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import { useStats } from '../context/AppContext';
import PhotoViewer from '../components/PhotoViewer';
import { getAssetsByIds, formatBytes } from '../utils/albumHelpers';
import { hammingDistance } from '../utils/imageHashing';
import analyzer from '../utils/chunkedAnalyzer';
import { batchDelete } from '../utils/deletionManager';
import ProgressBar from '../components/ProgressBar';
import * as suggestionCache from '../utils/suggestionCache';

// Members whose hash differs from the group's reference by more than this
// are NOT real burst duplicates — drop them from the group.
const BURST_SIMILAR_THRESHOLD = 16;

/**
 * Group-based cleanup screen, two modes:
 * - 'burst': candidate groups are verified with perceptual hashes
 *   (dissimilar members dropped), scored for sharpness, everything except
 *   the sharpest pre-selected.
 * - 'duplicate': exact-duplicate groups (photos or videos) — first copy is
 *   kept, the rest pre-selected. Video members get generated thumbnails.
 * Confirm deletes the selected set with ONE system dialog.
 */
export default function BurstCleanScreen({ route, navigation }) {
  const { groups = [], mode = 'burst' } = route.params || {};
  const isDuplicate = mode === 'duplicate';
  const { colors, t, recycleBinActive } = useSettings();
  const { recordCleaned } = useStats();
  const { width } = useWindowDimensions();

  const [sections, setSections] = useState(null);
  const [selected, setSelected] = useState({});
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [working, setWorking] = useState(false);
  const [thumbs, setThumbs] = useState({}); // video id -> generated thumbnail uri
  // Full-screen viewer: {assets, index, bestId} of the tapped group, or null.
  const [viewer, setViewer] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const total = groups.reduce((n, g) => n + g.ids.length, 0);
      setProgress({ done: 0, total });
      // Resolve every member in one batched MediaLibrary request. The old
      // per-group loop repeated native lookups whenever this screen opened.
      const allIds = [...new Set(groups.flatMap((g) => g.ids))];
      const resolved = await getAssetsByIds(allIds);
      const byId = new Map(resolved.map((a) => [a.id, a]));
      const out = [];
      const autoSel = {};
      let done = 0;
      let sectionNo = 0;

      const cached = await suggestionCache.getVerifiedGroups(mode, groups, resolved);
      if (!alive) return;
      if (cached) {
        for (const item of cached) {
          const members = (item.ids || []).map((id) => byId.get(id)).filter(Boolean);
          if (members.length < 2) continue;
          members.forEach((a) => {
            if (a.id !== item.bestId) autoSel[a.id] = true;
            if (a.mediaType === 'video') {
              getVideoThumbnail(a)
                .then((uri) => alive && setThumbs((s) => ({ ...s, [a.id]: uri })))
                .catch(() => {});
            }
          });
          sectionNo += 1;
          out.push({ title: `#${sectionNo}`, bestId: item.bestId, data: [members] });
        }
        setProgress({ done: total, total });
        setSections(out);
        setSelected(autoSel);
        return;
      }

      for (let gi = 0; gi < groups.length; gi++) {
        const assets = groups[gi].ids
          .map((id) => byId.get(id))
          .filter(Boolean);
        if (!alive) return;

        let members;
        let bestId;
        if (isDuplicate) {
          // Exact duplicates — already verified, no pixel work needed.
          members = assets;
          done += assets.length;
          if (alive) setProgress({ done, total });
          if (members.length < 2) continue;
          bestId = members[0].id; // keep the first copy
          // Thumbnails for video members — persistently CACHED: generated
          // once per video, instant on every later visit.
          for (const a of members) {
            if (!alive) return;
            if (a.mediaType === 'video') {
              try {
                const uri = await getVideoThumbnail(a);
                if (alive) setThumbs((s) => ({ ...s, [a.id]: uri }));
              } catch (e) {
                // no thumbnail — icon shows instead
              }
            }
          }
        } else {
          // Burst mode: metrics via the analyzer's global store — instant
          // for photos the album analysis has already seen.
          const scored = [];
          for (const a of assets) {
            if (!alive) return;
            try {
              const m = await analyzer.metricsFor(a);
              if (m && m.hash) scored.push({ ...a, score: m.sharpness, hash: m.hash });
            } catch (e) {
              // unreadable — skip member
            }
            done += 1;
            if (alive) setProgress({ done, total });
            await new Promise((r) => setTimeout(r, 0));
          }
          if (scored.length < 2) continue;

          // Similarity filter: medoid reference, drop outliers.
          let medoid = scored[0];
          let bestSum = Infinity;
          for (const a of scored) {
            let sum = 0;
            for (const b of scored) sum += hammingDistance(a.hash, b.hash);
            if (sum < bestSum) {
              bestSum = sum;
              medoid = a;
            }
          }
          members = scored.filter(
            (a) => hammingDistance(a.hash, medoid.hash) <= BURST_SIMILAR_THRESHOLD
          );
          if (members.length < 2) continue; // not a real burst — drop group

          bestId = members[0].id;
          let bestScore = -1;
          for (const a of members) {
            if (a.score > bestScore) {
              bestScore = a.score;
              bestId = a.id;
            }
          }
        }

        members.forEach((a) => {
          if (a.id !== bestId) autoSel[a.id] = true;
        });
        sectionNo += 1;
        out.push({ title: `#${sectionNo}`, bestId, data: [members] });
      }
      if (!alive) return;
      await suggestionCache.saveVerifiedGroups(
        mode,
        groups,
        out.map((section) => ({
          ids: section.data[0].map((a) => a.id),
          bestId: section.bestId,
        })),
        resolved
      );
      if (!alive) return;
      setSections(out);
      setSelected(autoSel);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedIds = Object.keys(selected).filter((k) => selected[k]);
  const cell = (width - 16 * 2 - 8 * 3) / 4;

  const confirm = () => {
    Alert.alert(t('burst_confirm', { count: selectedIds.length }), '', [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('delete_all_marked'),
        style: 'destructive',
        onPress: async () => {
          setWorking(true);
          const targets = [];
          for (const section of sections) {
            for (const asset of section.data[0]) {
              if (selected[asset.id]) targets.push(asset);
            }
          }
          try {
            // ONE system deletion dialog for all selected burst photos.
            const { count, bytesById, deletedIds } = await batchDelete(targets, {
              useRecycleBin: recycleBinActive,
            });
            if (count > 0) {
              // The duplicate mode is also reachable with VIDEO groups
              // (Profile's "duplicate videos" card), and everything used to
              // be booked as photos.
              const goneIds = new Set(deletedIds || targets.map((a) => a.id));
              const gone = targets.filter((a) => goneIds.has(a.id));
              const vids = gone.filter((a) => a.mediaType === 'video');
              const pics = gone.filter((a) => a.mediaType !== 'video');
              const sum = (items) =>
                items.reduce((n, item) => n + (bytesById?.[item.id] || 0), 0);
              if (vids.length > 0) {
                await recordCleaned('video', vids.length, sum(vids));
              }
              if (pics.length > 0) {
                await recordCleaned('photo', pics.length, sum(pics));
              }
            }
          } catch (e) {
            // user cancelled the system dialog
          }
          setWorking(false);
          navigation.goBack();
        },
      },
    ]);
  };

  if (sections === null || working) {
    return (
      <SafeAreaView edges={['top', 'left', 'right']} style={[styles.loadingScreen, { backgroundColor: colors.background }]}>
        {!working && (
          <Pressable
            onPress={() => navigation.goBack()}
            hitSlop={10}
            style={styles.loadingBack}
          >
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </Pressable>
        )}
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
          {!working && progress.total > 0 && (
            <View style={styles.loadingProgress}>
              <Text style={[styles.progress, { color: colors.subtext }]}>
                {t('computing_sharpness', progress)}
              </Text>
              <ProgressBar done={progress.done} total={progress.total} />
            </View>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.topBar}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>
          {isDuplicate ? t('dupes_title') : t('burst_title')}
        </Text>
        <View style={{ width: 26 }} />
      </View>
      <Text style={[styles.hint, { color: colors.subtext }]}>
        {isDuplicate ? t('dupes_keep_hint') : t('burst_keep_hint')}
      </Text>

      {sections.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="checkmark-circle-outline" size={48} color={colors.subtext} />
          <Text style={[styles.progress, { color: colors.subtext }]}>
            {t('nothing_found')}
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item, i) => `row_${i}`}
          contentContainerStyle={{ paddingBottom: 140 }}
          renderSectionHeader={({ section }) => (
            <Text style={[styles.groupTitle, { color: colors.subtext }]}>
              {section.title}
            </Text>
          )}
          renderItem={({ item: rowAssets, section }) => (
            <View style={styles.grid}>
              {rowAssets.map((asset, ai) => {
                const isSel = !!selected[asset.id];
                const isBest = asset.id === section.bestId;
                return (
                  <Pressable
                    key={asset.id}
                    onPress={() =>
                      // tap = view the group full screen from this photo
                      setViewer({
                        assets: rowAssets,
                        index: ai,
                        bestId: section.bestId,
                      })
                    }
                    style={{ width: cell, height: cell }}
                  >
                    <Image
                      source={{ uri: thumbs[asset.id] || asset.uri }}
                      style={[styles.thumb, isSel && { opacity: 0.5 }]}
                      cachePolicy="memory-disk"
                      recyclingKey={asset.id}
                    />
                    {asset.mediaType === 'video' && (
                      <View style={styles.videoBadge}>
                        <Ionicons name="videocam" size={11} color="#fff" />
                      </View>
                    )}
                    {isBest && (
                      <View style={[styles.bestBadge, { backgroundColor: colors.success }]}>
                        <Ionicons name="star" size={11} color="#fff" />
                      </View>
                    )}
                    {/* circle badge = (de)select */}
                    <Pressable
                      hitSlop={8}
                      onPress={() =>
                        setSelected((s) => ({ ...s, [asset.id]: !s[asset.id] }))
                      }
                      style={[
                        styles.mark,
                        { backgroundColor: isSel ? colors.danger : 'rgba(0,0,0,0.35)' },
                      ]}
                    >
                      <Ionicons name={isSel ? 'trash' : 'checkmark'} size={12} color="#fff" />
                    </Pressable>
                  </Pressable>
                );
              })}
            </View>
          )}
        />
      )}

      {selectedIds.length > 0 && (
        <Pressable
          style={[styles.confirmBtn, { backgroundColor: colors.danger }]}
          onPress={confirm}
        >
          <Text style={styles.confirmText}>
            {t('burst_confirm', { count: selectedIds.length })}
          </Text>
        </Pressable>
      )}

      <PhotoViewer
        visible={viewer !== null}
        assets={viewer ? viewer.assets : []}
        initialIndex={viewer ? viewer.index : 0}
        bestId={viewer ? viewer.bestId : null}
        onClose={() => setViewer(null)}
        selected={selected}
        onToggleSelect={(id) => setSelected((s) => ({ ...s, [id]: !s[id] }))}
        thumbs={thumbs}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16 },
  loadingScreen: { flex: 1, paddingHorizontal: 16 },
  loadingBack: {
    width: 36,
    height: 40,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  progress: { marginTop: 12, fontSize: 13 },
  loadingProgress: { width: '72%', gap: 8 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  title: { fontSize: 18, fontWeight: '800' },
  hint: { fontSize: 12, marginBottom: 10 },
  groupTitle: { fontSize: 13, fontWeight: '700', marginTop: 14, marginBottom: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  thumb: { width: '100%', height: '100%', borderRadius: 10 },
  videoBadge: {
    position: 'absolute',
    bottom: 5,
    left: 5,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8,
    padding: 3,
  },
  bestBadge: {
    position: 'absolute',
    top: 5,
    left: 5,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  confirmBtn: {
    position: 'absolute',
    bottom: 30,
    left: 16,
    right: 16,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  confirmText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
