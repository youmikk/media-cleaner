import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  SectionList,
  Image,
  StyleSheet,
  ActivityIndicator,
  useWindowDimensions,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import { useApp } from '../context/AppContext';
import { getAssetsByIds, formatBytes } from '../utils/albumHelpers';
import { laplacianVariance } from '../utils/sharpness';
import { permanentDelete } from '../utils/deletionManager';

/**
 * Burst cleaning: for each burst group, computes sharpness (Laplacian
 * variance) and auto-selects every photo EXCEPT the sharpest for deletion.
 * The user can toggle any photo; Confirm deletes the selected set.
 */
export default function BurstCleanScreen({ route, navigation }) {
  const { groups = [] } = route.params || {};
  const { colors, t, recycleBinActive } = useSettings();
  const { recordCleaned } = useApp();
  const { width } = useWindowDimensions();

  const [sections, setSections] = useState(null);
  const [selected, setSelected] = useState({});
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const total = groups.reduce((n, g) => n + g.ids.length, 0);
      setProgress({ done: 0, total });
      const out = [];
      const autoSel = {};
      let done = 0;
      for (let gi = 0; gi < groups.length; gi++) {
        const assets = await getAssetsByIds(groups[gi].ids);
        if (!alive) return;
        // Score sharpness per member, chunk-yielding to the UI.
        let bestId = null;
        let bestScore = -1;
        const scored = [];
        for (const a of assets) {
          const score = await laplacianVariance(a.localUri || a.uri);
          scored.push({ ...a, score });
          if (score > bestScore) {
            bestScore = score;
            bestId = a.id;
          }
          done += 1;
          if (alive) setProgress({ done, total });
          await new Promise((r) => setTimeout(r, 0));
        }
        if (scored.length > 1) {
          scored.forEach((a) => {
            if (a.id !== bestId) autoSel[a.id] = true;
          });
          out.push({ title: `#${gi + 1}`, bestId, data: [scored] });
        }
      }
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
          let bytes = 0;
          let count = 0;
          for (const section of sections) {
            for (const asset of section.data[0]) {
              if (selected[asset.id]) {
                try {
                  bytes += await permanentDelete(asset, {
                    useRecycleBin: recycleBinActive,
                  });
                  count += 1;
                } catch (e) {
                  // skip failures
                }
              }
            }
          }
          if (count > 0) await recordCleaned('photo', count, bytes);
          setWorking(false);
          navigation.goBack();
        },
      },
    ]);
  };

  if (sections === null || working) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} />
        {!working && progress.total > 0 && (
          <Text style={[styles.progress, { color: colors.subtext }]}>
            {t('computing_sharpness', progress)}
          </Text>
        )}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.topBar}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>
          {t('burst_title')}
        </Text>
        <View style={{ width: 26 }} />
      </View>
      <Text style={[styles.hint, { color: colors.subtext }]}>
        {t('burst_keep_hint')}
      </Text>

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
            {rowAssets.map((asset) => {
              const isSel = !!selected[asset.id];
              const isBest = asset.id === section.bestId;
              return (
                <Pressable
                  key={asset.id}
                  onPress={() =>
                    setSelected((s) => ({ ...s, [asset.id]: !s[asset.id] }))
                  }
                  style={{ width: cell, height: cell }}
                >
                  <Image
                    source={{ uri: asset.uri }}
                    style={[styles.thumb, isSel && { opacity: 0.5 }]}
                  />
                  {isBest && (
                    <View style={[styles.bestBadge, { backgroundColor: colors.success }]}>
                      <Ionicons name="star" size={11} color="#fff" />
                    </View>
                  )}
                  <View
                    style={[
                      styles.mark,
                      { backgroundColor: isSel ? colors.danger : 'rgba(0,0,0,0.35)' },
                    ]}
                  >
                    <Ionicons name={isSel ? 'trash' : 'checkmark'} size={12} color="#fff" />
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      />

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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  progress: { marginTop: 12, fontSize: 13 },
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
