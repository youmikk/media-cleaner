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
  ActivityIndicator,
  Alert,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useDerivedValue,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Image as ExpoImage } from 'expo-image';
import * as MediaLibrary from 'expo-media-library';
import { useSettings } from '../context/SettingsContext';
import { useApp } from '../context/AppContext';
import PhotoCard from '../components/PhotoCard';
import PageIndicator from '../components/PageIndicator';
import BottomInfoBar from '../components/BottomInfoBar';
import GlowingTrashBar from '../components/GlowingTrashBar';
import EXIFModal from '../components/EXIFModal';
import SimilarModal from '../components/SimilarModal';
import MoveSheet from '../components/MoveSheet';
import GroupConfirmSheet from '../components/GroupConfirmSheet';
import { batchDelete } from '../utils/deletionManager';
import * as sessionManager from '../utils/sessionManager';
import analyzer from '../utils/chunkedAnalyzer';
import { reverseGeocode } from '../utils/geocode';
import {
  getAssetsPage,
  getAssetsByIds,
  getAlbumSnapshot,
  moveAssetsToAlbum,
  formatBytes,
} from '../utils/albumHelpers';

const SWIPE_X = 80;
const MOVE_THRESHOLD = 120;
const SPRING = { damping: 18, stiffness: 180 };

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
 * - Swiping up MARKS a photo; the actual media-library deletion happens ONCE
 *   per group ("Delete All Marked") — a single system dialog per batch.
 * - First page of the album shows immediately; the rest streams in.
 * - Sessions resume exactly: shuffled order, group, position and marks.
 */
export default function CleaningScreen({ route, navigation }) {
  const {
    albumId,
    albumTitle,
    assetIds = null,
    resume = false,
    sizesById = null,
    timeRange = null, // {start, end} — year / year-month scope
  } = route.params;
  const { colors, t, settings, recycleBinActive, language } = useSettings();
  const { recordCleaned, recordViewed, toggleFavorite, isFavorite } = useApp();
  const { width: SCREEN_W, height: SCREEN_H } = useWindowDimensions();
  const groupSize = route.params.groupSize || settings.groupSize || 5;
  const DELETE_THRESHOLD = SCREEN_H * 0.4;

  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState([]);
  const [gi, setGi] = useState(0);
  const [pi, setPi] = useState(0);
  const [markedIds, setMarkedIds] = useState(new Set());
  const [movedIds, setMovedIds] = useState(new Set());
  const [clusters, setClusters] = useState([]);
  const [showExif, setShowExif] = useState(false);
  const [showSimilar, setShowSimilar] = useState(false);
  const [showMove, setShowMove] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [moveMarkedMode, setMoveMarkedMode] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [finalStats, setFinalStats] = useState({ count: 0, bytes: 0 });
  const [toast, setToast] = useState(null);

  const sessionRef = useRef(null);
  const cleanedRef = useRef({ count: 0, bytes: 0 });
  const viewedRef = useRef(new Set());
  const markStackRef = useRef([]); // mark order, for undo
  const frozenAssetRef = useRef(null);
  const orderRef = useRef([]); // asset ids in cleaning order

  // ---- Animation shared values ----
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const deleteProgress = useDerivedValue(() =>
    Math.min(1, Math.max(0, -ty.value / DELETE_THRESHOLD))
  );

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }],
    opacity: interpolate(Math.abs(tx.value), [0, SCREEN_W], [1, 0.4]),
  }));

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1800);
  };

  // ---- Load: progressive for fresh sessions, ordered for resume ----
  useEffect(() => {
    let alive = true;
    (async () => {
      const pending = await sessionManager.getPendingSession();
      const resuming =
        resume &&
        pending &&
        pending.albumId === albumId &&
        pending.type === 'photo';
      const range = resuming ? pending.timeRange || timeRange : timeRange;
      const inRange = (a) =>
        !range ||
        (a.creationTime &&
          a.creationTime >= range.start &&
          a.creationTime < range.end);

      if (assetIds) {
        // Explicit subset (suggestions) — small, load directly.
        const assets = await getAssetsByIds(assetIds);
        if (!alive) return;
        const ordered =
          settings.order === 'random' && !resuming ? shuffle(assets) : assets;
        orderRef.current = ordered.map((a) => a.id);
        setGroups(chunk(ordered, groupSize));
        setLoading(false);
      } else {
        // Stream pages: first page starts the session instantly.
        let all = [];
        let after;
        let hasNext = true;
        let first = true;
        while (hasNext && all.length < 5000) {
          const page = await getAssetsPage(albumId, 'photo', after);
          if (!alive) return;
          const scoped = page.assets.filter(inRange);
          const pageAssets =
            settings.order === 'random' && !resuming ? shuffle(scoped) : scoped;
          all = [...all, ...pageAssets];
          hasNext = page.hasNext;
          after = page.endCursor;
          if (!resuming) {
            orderRef.current = all.map((a) => a.id);
            setGroups(chunk(all, groupSize));
            if (first) setLoading(false);
          }
          first = false;
        }
        if (resuming) {
          // Rebuild the EXACT saved order (dropping deleted assets).
          const savedOrder = (await sessionManager.getOrder()) || [];
          const byId = Object.fromEntries(all.map((a) => [a.id, a]));
          const ordered = savedOrder.map((id) => byId[id]).filter(Boolean);
          const rest = all.filter((a) => !savedOrder.includes(a.id));
          const finalList = [...ordered, ...rest];
          orderRef.current = finalList.map((a) => a.id);
          if (!alive) return;
          setGroups(chunk(finalList, groupSize));
          setGi(Math.min(pending.groupIndex || 0, Math.max(0, Math.ceil(finalList.length / groupSize) - 1)));
          setPi(pending.photoIndex || 0);
          const savedMarks = new Set(pending.markedIds || []);
          setMarkedIds(savedMarks);
          markStackRef.current = [...savedMarks];
          setLoading(false);
        } else {
          sessionManager.saveOrder(orderRef.current);
        }
      }

      // Session bookkeeping
      if (resuming) {
        sessionRef.current = pending;
      } else {
        const before = await getAlbumSnapshot(albumId, 'photo');
        sessionRef.current = await sessionManager.startSession({
          type: 'photo',
          albumId,
          albumTitle,
          groupSize,
          assetIds,
          timeRange,
          before,
        });
        sessionManager.saveOrder(orderRef.current);
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

  // Persist progress (group, position, marks) for exact resume.
  const persistProgress = useCallback((patch = {}) => {
    if (!sessionRef.current) return;
    sessionManager.saveProgress({
      groupIndex: gi,
      photoIndex: pi,
      markedIds: [...markedIds],
      ...patch,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gi, pi, markedIds]);

  useEffect(() => {
    persistProgress();
  }, [gi, markedIds, persistProgress]);

  // ---- Derived state ----
  const group = groups[gi] || [];
  const visible = useMemo(
    () => group.filter((a) => !markedIds.has(a.id) && !movedIds.has(a.id)),
    [group, markedIds, movedIds]
  );
  const current = visible[Math.min(pi, Math.max(0, visible.length - 1))] || null;

  // Freeze the background photo while the confirm sheet is open.
  useEffect(() => {
    if (showConfirm) {
      if (!frozenAssetRef.current) frozenAssetRef.current = current;
    } else {
      frozenAssetRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showConfirm]);
  const displayAsset =
    showConfirm && frozenAssetRef.current ? frozenAssetRef.current : current;

  useEffect(() => {
    if (current && !viewedRef.current.has(current.id)) {
      viewedRef.current.add(current.id);
    }
  }, [current]);

  // Prefetch the NEXT photo so swiping feels instant.
  useEffect(() => {
    const next = visible[pi + 1];
    if (next && next.mediaType !== 'video') {
      ExpoImage.prefetch(next.uri).catch(() => {});
    }
  }, [pi, visible]);

  // Resolve the current photo's address (GPS -> reverse geocode, cached).
  const [address, setAddress] = useState(null);
  const addressCacheRef = useRef({});
  useEffect(() => {
    let alive = true;
    setAddress(null);
    if (!displayAsset) return undefined;
    const cached = addressCacheRef.current[displayAsset.id];
    if (cached !== undefined) {
      setAddress(cached);
      return undefined;
    }
    (async () => {
      try {
        const info = await MediaLibrary.getAssetInfoAsync(displayAsset.id);
        let addr = null;
        if (info.location) {
          addr = await reverseGeocode(
            info.location.latitude,
            info.location.longitude,
            language
          );
        }
        addressCacheRef.current[displayAsset.id] = addr;
        if (alive) setAddress(addr);
      } catch (e) {
        addressCacheRef.current[displayAsset.id] = null;
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayAsset?.id, language]);

  const currentCluster = useMemo(() => {
    if (!current || clusters.length === 0) return null;
    const c = clusters.find((ids) => ids.includes(current.id));
    return c && c.length > 1 ? c : null;
  }, [current, clusters]);

  // ---- Mark / undo (no deletion yet — deletion is batched per group) ----
  const mark = useCallback((asset) => {
    if (!asset) return;
    markStackRef.current.push(asset.id);
    setMarkedIds((s) => new Set(s).add(asset.id));
  }, []);

  const undo = useCallback(() => {
    const id = markStackRef.current.pop();
    if (!id) return;
    setMarkedIds((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }, []);

  const undoCount = markStackRef.current.length; // fresh on every re-render

  const afterRemovalAdvance = useCallback(
    (remainingCount) => {
      if (remainingCount === 0) setShowConfirm(true);
      else if (pi >= remainingCount) setPi(remainingCount - 1);
    },
    [pi]
  );

  // ---- Gesture callbacks ----
  const slideInFrom = useCallback(
    (fromX) => {
      tx.value = fromX;
      ty.value = 0;
      tx.value = withSpring(0, SPRING);
    },
    [tx, ty]
  );

  const onSwipeNext = useCallback(() => {
    if (pi < visible.length - 1) {
      setPi(pi + 1);
      slideInFrom(SCREEN_W);
    } else {
      tx.value = withSpring(0, SPRING);
      setShowConfirm(true);
    }
  }, [pi, visible.length, slideInFrom, SCREEN_W, tx]);

  const onSwipePrev = useCallback(() => {
    if (pi > 0) {
      setPi(pi - 1);
      slideInFrom(-SCREEN_W);
    } else {
      tx.value = withSpring(0, SPRING);
    }
  }, [pi, slideInFrom, SCREEN_W, tx]);

  const onSwipeDelete = useCallback(() => {
    if (!current) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (e) {
      // haptics unavailable
    }
    mark(current);
    ty.value = SCREEN_H * 0.12;
    tx.value = 0;
    ty.value = withSpring(0, SPRING);
    afterRemovalAdvance(visible.length - 1);
  }, [current, mark, visible.length, afterRemovalAdvance, ty, tx, SCREEN_H]);

  const onSwipeDown = useCallback(() => {
    if (current) setShowMove(true);
  }, [current]);

  const handlersRef = useRef({});
  handlersRef.current = {
    next: onSwipeNext,
    prev: onSwipePrev,
    del: onSwipeDelete,
    down: onSwipeDown,
  };
  const callNext = useCallback(() => handlersRef.current.next(), []);
  const callPrev = useCallback(() => handlersRef.current.prev(), []);
  const callDel = useCallback(() => handlersRef.current.del(), []);
  const callDown = useCallback(() => handlersRef.current.down(), []);

  const pan = Gesture.Pan()
    .enabled(!showConfirm && !showMove && !showSimilar && !showExif)
    .onUpdate((e) => {
      'worklet';
      if (Math.abs(e.translationX) > Math.abs(e.translationY)) {
        tx.value = e.translationX;
        ty.value = 0;
      } else {
        ty.value = e.translationY;
        tx.value = 0;
      }
    })
    .onEnd((e) => {
      'worklet';
      const horizontal = Math.abs(e.translationX) > Math.abs(e.translationY);
      if (horizontal) {
        if (e.translationX < -SWIPE_X) {
          tx.value = withTiming(-SCREEN_W, { duration: 150 }, (finished) => {
            if (finished) runOnJS(callNext)();
          });
        } else if (e.translationX > SWIPE_X) {
          tx.value = withTiming(SCREEN_W, { duration: 150 }, (finished) => {
            if (finished) runOnJS(callPrev)();
          });
        } else {
          tx.value = withSpring(0, SPRING);
        }
      } else if (e.translationY < -DELETE_THRESHOLD) {
        ty.value = withTiming(-SCREEN_H, { duration: 180 }, (finished) => {
          if (finished) runOnJS(callDel)();
        });
      } else if (e.translationY > MOVE_THRESHOLD) {
        ty.value = withSpring(0, SPRING);
        runOnJS(callDown)();
      } else {
        ty.value = withSpring(0, SPRING);
      }
    });

  // ---- Move flow ----
  const handleMove = async (album) => {
    setShowMove(false);
    if (!current) return;
    try {
      await moveAssetsToAlbum([current], album);
      setMovedIds((s) => new Set(s).add(current.id));
      showToast(t('moved_to', { album: album.title }));
      afterRemovalAdvance(visible.length - 1);
    } catch (e) {
      // move failed — keep photo in place
    }
  };

  // ---- Group confirmation (ONE batched delete per group) ----
  const toggleMark = (id) => {
    setMarkedIds((s) => {
      const next = new Set(s);
      if (next.has(id)) {
        next.delete(id);
        markStackRef.current = markStackRef.current.filter((x) => x !== id);
      } else {
        next.add(id);
        markStackRef.current.push(id);
      }
      return next;
    });
  };

  const clearGroupMarks = () => {
    const groupIdSet = new Set(group.map((a) => a.id));
    setMarkedIds((s) => {
      const next = new Set(s);
      group.forEach((a) => next.delete(a.id));
      return next;
    });
    markStackRef.current = markStackRef.current.filter(
      (id) => !groupIdSet.has(id)
    );
  };

  const nextGroup = () => {
    setShowConfirm(false);
    setPi(0);
    tx.value = 0;
    ty.value = 0;
    if (gi < groups.length - 1) setGi(gi + 1);
    else finishAll();
  };

  const skipGroup = () => {
    clearGroupMarks(); // skip = keep everything in this group
    nextGroup();
  };

  const deleteMarkedNow = async () => {
    const targets = group.filter((a) => markedIds.has(a.id));
    if (targets.length > 0) {
      try {
        // SINGLE system deletion dialog for the whole group.
        const { count, bytes } = await batchDelete(targets, {
          useRecycleBin: recycleBinActive,
        });
        cleanedRef.current.count += count;
        cleanedRef.current.bytes += bytes;
        recordCleaned('photo', count, bytes);
        clearGroupMarks();
      } catch (e) {
        // user cancelled the system dialog — keep marks, stay in the sheet
        return;
      }
    }
    nextGroup();
  };

  const moveMarked = async (album) => {
    setMoveMarkedMode(false);
    const targets = group.filter((a) => markedIds.has(a.id));
    try {
      await moveAssetsToAlbum(targets, album);
      setMovedIds((s) => {
        const next = new Set(s);
        targets.forEach((a) => next.add(a.id));
        return next;
      });
      clearGroupMarks();
      showToast(t('moved_to', { album: album.title }));
    } catch (e) {
      // ignore
    }
    nextGroup();
  };

  const closeConfirmOnly = () => {
    if (visible.length === 0) {
      nextGroup();
      return;
    }
    setShowConfirm(false);
    if (pi >= visible.length) setPi(visible.length - 1);
    tx.value = 0;
    ty.value = 0;
  };

  // ---- Completion / exit (marks are discarded — deletion only happens
  // through the explicit batched group action) ----
  const finishAll = async () => {
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

  const sizeLabel =
    sizesById && displayAsset && sizesById[displayAsset.id]
      ? formatBytes(sizesById[displayAsset.id])
      : null;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <GlowingTrashBar progress={deleteProgress} />

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
        <Pressable
          onPress={exit}
          hitSlop={10}
          style={[styles.exitBtn, { backgroundColor: colors.card }]}
        >
          <Ionicons name="close" size={22} color={colors.text} />
        </Pressable>
      </View>

      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.photoArea, cardStyle]}>
          <PhotoCard
            asset={displayAsset}
            isFavorite={displayAsset ? isFavorite(displayAsset.id) : false}
            marked={displayAsset ? markedIds.has(displayAsset.id) : false}
            sizeLabel={sizeLabel}
          />
        </Animated.View>
      </GestureDetector>

      <View style={styles.indicatorWrap}>
        <PageIndicator
          total={visible.length}
          index={Math.min(pi, visible.length - 1)}
        />
      </View>

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
        asset={displayAsset}
        address={address}
        isFavorite={displayAsset ? isFavorite(displayAsset.id) : false}
        onToggleFavorite={() => displayAsset && toggleFavorite(displayAsset.id)}
        onPressDate={() => displayAsset && setShowExif(true)}
        undoCount={undoCount || 0}
        onUndo={undo}
      />

      <EXIFModal
        visible={showExif}
        asset={displayAsset}
        onClose={() => setShowExif(false)}
      />

      <SimilarModal
        visible={showSimilar}
        clusterIds={currentCluster}
        onClose={() => setShowSimilar(false)}
        onDeleteSelected={(assets) => {
          setShowSimilar(false);
          assets.forEach((a) => mark(a));
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
        onClose={closeConfirmOnly}
        onSkip={skipGroup}
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
