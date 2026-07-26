import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  PanResponder,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import { useApp } from '../context/AppContext';
import PhotoCard from '../components/PhotoCard';
import PageIndicator from '../components/PageIndicator';
import BottomInfoBar from '../components/BottomInfoBar';
import EXIFModal from '../components/EXIFModal';
import SimilarModal from '../components/SimilarModal';
import MoveSheet from '../components/MoveSheet';
import GroupConfirmSheet from '../components/GroupConfirmSheet';
import { SoftDeleteManager } from '../utils/deletionManager';
import * as sessionManager from '../utils/sessionManager';
import analyzer from '../utils/chunkedAnalyzer';
import {
  getAssets,
  getAssetsByIds,
  getAlbumSnapshot,
  moveAssetsToAlbum,
  formatBytes,
} from '../utils/albumHelpers';

const SWIPE_X = 60;
const SWIPE_Y = 80;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Swipe-based photo cleaning flow.
 * left/right: navigate group · up: soft delete · down: move to album.
 */
export default function CleaningScreen({ route, navigation }) {
  const {
    albumId,
    albumTitle,
    groupSize,
    assetIds = null,
    resumeGroupIndex = 0,
  } = route.params;
  const { colors, t, settings, recycleBinActive } = useSettings();
  const { recordCleaned, recordViewed, toggleFavorite, isFavorite } = useApp();

  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState([]);
  const [gi, setGi] = useState(resumeGroupIndex);
  const [pi, setPi] = useState(0);
  const [softDeletedIds, setSoftDeletedIds] = useState(new Set());
  const [movedIds, setMovedIds] = useState(new Set());
  const [undoCount, setUndoCount] = useState(0);
  const [clusters, setClusters] = useState([]);
  const [showExif, setShowExif] = useState(false);
  const [showSimilar, setShowSimilar] = useState(false);
  const [showMove, setShowMove] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [finalStats, setFinalStats] = useState({ count: 0, bytes: 0 });
  const [toast, setToast] = useState(null);

  const sessionRef = useRef(null);
  const cleanedRef = useRef({ count: 0, bytes: 0 });
  const viewedRef = useRef(new Set());
  const managerRef = useRef(null);

  if (!managerRef.current) {
    managerRef.current = new SoftDeleteManager({
      useRecycleBin: recycleBinActive,
      onFinalized: (asset, bytes) => {
        cleanedRef.current.count += 1;
        cleanedRef.current.bytes += bytes || 0;
        recordCleaned('photo', 1, bytes);
      },
      onChange: (count) => setUndoCount(count),
    });
  }
  managerRef.current.setOptions({ useRecycleBin: recycleBinActive });

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1800);
  };

  // ---- Load assets, groups, analysis cache and start the session ----
  useEffect(() => {
    let alive = true;
    (async () => {
      let assets = assetIds
        ? await getAssetsByIds(assetIds)
        : await getAssets(albumId, 'photo');
      if (settings.order === 'random') assets = shuffle(assets);
      if (!alive) return;
      setGroups(chunk(assets, groupSize));
      setLoading(false);

      const before = await getAlbumSnapshot(albumId, 'photo', assets);
      const pending = await sessionManager.getPendingSession();
      if (pending && pending.albumId === albumId && pending.type === 'photo') {
        sessionRef.current = pending; // resuming
      } else {
        sessionRef.current = await sessionManager.startSession({
          type: 'photo',
          albumId,
          albumTitle,
          groupSize,
          assetIds,
          before,
        });
      }

      if (settings.similarDetection) {
        const cache = await analyzer.getCached(albumId, 'photo');
        if (alive && cache && cache.clusters) setClusters(cache.clusters);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist group progress for resume.
  useEffect(() => {
    if (sessionRef.current) sessionManager.saveProgress({ groupIndex: gi });
  }, [gi]);

  // ---- Derived state ----
  const group = groups[gi] || [];
  const visible = useMemo(
    () => group.filter((a) => !softDeletedIds.has(a.id) && !movedIds.has(a.id)),
    [group, softDeletedIds, movedIds]
  );
  const current = visible[Math.min(pi, Math.max(0, visible.length - 1))] || null;

  // Track viewed photos (batched into stats at the end).
  useEffect(() => {
    if (current && !viewedRef.current.has(current.id)) {
      viewedRef.current.add(current.id);
    }
  }, [current]);

  const currentCluster = useMemo(() => {
    if (!current || clusters.length === 0) return null;
    const c = clusters.find((ids) => ids.includes(current.id));
    return c && c.length > 1 ? c : null;
  }, [current, clusters]);

  // ---- Actions ----
  const softDelete = useCallback(
    (asset) => {
      if (!asset) return;
      managerRef.current.softDelete(asset);
      setSoftDeletedIds((s) => new Set(s).add(asset.id));
    },
    []
  );

  const undo = useCallback(() => {
    const asset = managerRef.current.undoLast();
    if (!asset) return;
    setSoftDeletedIds((s) => {
      const next = new Set(s);
      next.delete(asset.id);
      return next;
    });
  }, []);

  const goNext = useCallback(() => {
    if (pi < visible.length - 1) {
      setPi(pi + 1);
    } else {
      setShowConfirm(true); // end of group
    }
  }, [pi, visible.length]);

  const goPrev = useCallback(() => {
    if (pi > 0) setPi(pi - 1);
  }, [pi]);

  const afterRemovalAdvance = useCallback(
    (remainingCount) => {
      if (remainingCount === 0) setShowConfirm(true);
      else if (pi >= remainingCount) setPi(remainingCount - 1);
    },
    [pi]
  );

  const handleSwipeUp = useCallback(() => {
    if (!current) return;
    softDelete(current);
    afterRemovalAdvance(visible.length - 1);
  }, [current, softDelete, visible.length, afterRemovalAdvance]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 12 || Math.abs(g.dy) > 12,
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dy) > Math.abs(g.dx)) {
          if (g.dy < -SWIPE_Y) handlersRef.current.up();
          else if (g.dy > SWIPE_Y) handlersRef.current.down();
        } else {
          if (g.dx < -SWIPE_X) handlersRef.current.next();
          else if (g.dx > SWIPE_X) handlersRef.current.prev();
        }
      },
    })
  ).current;

  const handlersRef = useRef({});
  handlersRef.current = {
    up: handleSwipeUp,
    down: () => current && setShowMove(true),
    next: goNext,
    prev: goPrev,
  };

  const handleMove = async (album) => {
    setShowMove(false);
    if (!current) return;
    try {
      await moveAssetsToAlbum([current], album);
      setMovedIds((s) => new Set(s).add(current.id));
      showToast(t('moved_to', { album: album.title }));
      afterRemovalAdvance(visible.length - 1);
    } catch (e) {
      // move failed (permission?) — keep photo in place
    }
  };

  // ---- Group confirmation ----
  const markedIds = softDeletedIds;
  const toggleMark = (id) => {
    setSoftDeletedIds((s) => {
      const next = new Set(s);
      if (next.has(id)) {
        next.delete(id);
        managerRef.current.undoById(id);
      } else {
        next.add(id);
        const asset = group.find((a) => a.id === id);
        if (asset) managerRef.current.softDelete(asset);
      }
      return next;
    });
  };

  const nextGroup = () => {
    setShowConfirm(false);
    setPi(0);
    if (gi < groups.length - 1) setGi(gi + 1);
    else finishAll();
  };

  const deleteMarkedNow = async () => {
    for (const asset of group) {
      if (markedIds.has(asset.id)) {
        await managerRef.current.finalizeById(asset.id);
      }
    }
    nextGroup();
  };

  const [moveMarkedMode, setMoveMarkedMode] = useState(false);
  const moveMarked = async (album) => {
    setMoveMarkedMode(false);
    const targets = group.filter((a) => markedIds.has(a.id));
    for (const asset of targets) {
      managerRef.current.undoById(asset.id);
    }
    try {
      await moveAssetsToAlbum(targets, album);
      setMovedIds((s) => {
        const next = new Set(s);
        targets.forEach((a) => next.add(a.id));
        return next;
      });
      setSoftDeletedIds((s) => {
        const next = new Set(s);
        targets.forEach((a) => next.delete(a.id));
        return next;
      });
      showToast(t('moved_to', { album: album.title }));
    } catch (e) {
      // ignore
    }
    nextGroup();
  };

  // ---- Completion / exit ----
  const finishAll = async () => {
    await managerRef.current.flushAll();
    const viewed = viewedRef.current.size;
    if (viewed > 0) recordViewed('photo', viewed);
    if (sessionRef.current) await sessionManager.finishSession(sessionRef.current);
    setFinalStats({ ...cleanedRef.current });
    setCompleted(true);
  };

  const exit = () => {
    Alert.alert(t('exit'), '', [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('exit'),
        style: 'destructive',
        onPress: async () => {
          await managerRef.current.flushAll();
          const viewed = viewedRef.current.size;
          if (viewed > 0) recordViewed('photo', viewed);
          if (sessionRef.current)
            await sessionManager.finishSession(sessionRef.current);
          navigation.goBack();
        },
      },
    ]);
  };

  // ---- Render ----
  if (loading) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </SafeAreaView>
    );
  }

  if (completed) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: colors.background }]}>
        <Ionicons name="sparkles" size={54} color={colors.accent} />
        <Text style={[styles.doneTitle, { color: colors.text }]}>
          {t('completion_title')}
        </Text>
        <Text style={[styles.doneSub, { color: colors.subtext }]}>
          {t('completion_subtitle')}
        </Text>
        <Text style={[styles.doneStat, { color: colors.text }]}>
          {t('completion_deleted', { count: finalStats.count })} ·{' '}
          {t('completion_saved', { size: formatBytes(finalStats.bytes) })}
        </Text>
        <Pressable
          style={[styles.doneBtn, { backgroundColor: colors.accent }]}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.doneBtnText}>{t('done')}</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (groups.length === 0) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: colors.background }]}>
        <Ionicons name="images-outline" size={48} color={colors.subtext} />
        <Text style={[styles.doneSub, { color: colors.subtext, marginTop: 12 }]}>
          {t('no_photos')}
        </Text>
        <Pressable
          style={[styles.doneBtn, { backgroundColor: colors.accent }]}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.doneBtnText}>{t('done')}</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <View>
          <Text style={[styles.topTitle, { color: colors.text }]} numberOfLines={1}>
            {albumTitle}
          </Text>
          <Text style={[styles.topSub, { color: colors.subtext }]}>
            {t('group_of', { current: gi + 1, total: groups.length })} ·{' '}
            {t('photo_of', {
              current: Math.min(pi + 1, visible.length),
              total: visible.length,
            })}
          </Text>
        </View>
        <Pressable onPress={exit} hitSlop={10} style={[styles.exitBtn, { backgroundColor: colors.card }]}>
          <Ionicons name="close" size={22} color={colors.text} />
        </Pressable>
      </View>

      {/* Photo area with gestures */}
      <View style={styles.photoArea} {...pan.panHandlers}>
        <PhotoCard
          asset={current}
          isFavorite={current ? isFavorite(current.id) : false}
          marked={current ? softDeletedIds.has(current.id) : false}
        />
      </View>

      <View style={styles.indicatorWrap}>
        <PageIndicator total={visible.length} index={Math.min(pi, visible.length - 1)} />
      </View>

      {/* Similar pill */}
      {currentCluster && (
        <Pressable
          style={[styles.similarPill, { backgroundColor: colors.accent }]}
          onPress={() => setShowSimilar(true)}
        >
          <Ionicons name="copy-outline" size={14} color="#fff" />
          <Text style={styles.similarText}>
            {t('similar_pill', { count: currentCluster.length })}
          </Text>
        </Pressable>
      )}

      {toast && (
        <View style={[styles.toast, { backgroundColor: colors.elevated }]}>
          <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>
            {toast}
          </Text>
        </View>
      )}

      <BottomInfoBar
        asset={current}
        isFavorite={current ? isFavorite(current.id) : false}
        onToggleFavorite={() => current && toggleFavorite(current.id)}
        onPressDate={() => current && setShowExif(true)}
        undoCount={undoCount}
        onUndo={undo}
      />

      <EXIFModal visible={showExif} asset={current} onClose={() => setShowExif(false)} />

      <SimilarModal
        visible={showSimilar}
        clusterIds={currentCluster}
        onClose={() => setShowSimilar(false)}
        onDeleteSelected={(assets) => {
          setShowSimilar(false);
          assets.forEach((a) => softDelete(a));
          afterRemovalAdvance(
            visible.filter((v) => !assets.some((a) => a.id === v.id)).length
          );
        }}
      />

      <MoveSheet
        visible={showMove}
        excludeAlbumId={albumId}
        onClose={() => setShowMove(false)}
        onSelect={handleMove}
      />

      <MoveSheet
        visible={moveMarkedMode}
        excludeAlbumId={albumId}
        onClose={() => setMoveMarkedMode(false)}
        onSelect={moveMarked}
      />

      <GroupConfirmSheet
        visible={showConfirm && !moveMarkedMode}
        assets={group.filter((a) => !movedIds.has(a.id))}
        markedIds={markedIds}
        onToggleMark={toggleMark}
        onSkip={nextGroup}
        onDeleteMarked={deleteMarkedNow}
        onMoveMarked={() => setMoveMarkedMode(true)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  topTitle: { fontSize: 18, fontWeight: '800', maxWidth: 260 },
  topSub: { fontSize: 12, marginTop: 2 },
  exitBtn: { borderRadius: 18, padding: 8 },
  photoArea: { flex: 1, marginBottom: 8 },
  indicatorWrap: { paddingVertical: 8, marginBottom: 120 },
  similarPill: {
    position: 'absolute',
    bottom: 108,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  similarText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  toast: {
    position: 'absolute',
    top: 90,
    alignSelf: 'center',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  doneTitle: { fontSize: 24, fontWeight: '800', marginTop: 16 },
  doneSub: { fontSize: 14, marginTop: 6, textAlign: 'center' },
  doneStat: { fontSize: 15, fontWeight: '600', marginTop: 14 },
  doneBtn: {
    marginTop: 24,
    borderRadius: 14,
    paddingHorizontal: 36,
    paddingVertical: 13,
  },
  doneBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
