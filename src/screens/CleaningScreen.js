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
  useWindowDimensions,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
  runOnJS,
  interpolate,
  Easing,
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
import AlbumChips from '../components/AlbumChips';
import GroupConfirmSheet from '../components/GroupConfirmSheet';
import { incrementUsage } from '../utils/albumUsage';
import { batchDelete } from '../utils/deletionManager';
import * as sessionManager from '../utils/sessionManager';
import analyzer from '../utils/chunkedAnalyzer';
import { reverseGeocode } from '../utils/geocode';
import {
  getAssetsPage,
  getAssetsByIds,
  getAlbumSnapshot,
  getCachedAssetList,
  saveCachedAssetList,
  moveAssetsToAlbum,
  formatBytes,
  ALL_ALBUM_ID,
} from '../utils/albumHelpers';

const SWIPE_X = 70;
const MOVE_THRESHOLD = 120;
// Plain ease-out transition — no spring, no wobble: the card just glides
// to its resting position and stops.
const EASE = { duration: 200, easing: Easing.out(Easing.cubic) };
const FLICK_VELOCITY = -900; // fast upward flick deletes without full drag

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
  const insets = useSafeAreaInsets();
  const groupSize = route.params.groupSize || settings.groupSize || 5;
  // ~22% of screen height — no need to drag all the way to the top; a fast
  // flick (velocity) deletes from even less.
  const DELETE_THRESHOLD = SCREEN_H * 0.22;

  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState([]);
  const [gi, setGi] = useState(0);
  const [pi, setPi] = useState(0);
  const [markedIds, setMarkedIds] = useState(new Set());
  // Categorizing is NOT deleting: moving a photo to an album keeps it in the
  // cleaning flow — we only remember its new album so the ✓ chip follows it.
  const [albumOverrides, setAlbumOverrides] = useState({});
  const [clusters, setClusters] = useState([]);
  const [showExif, setShowExif] = useState(false);
  const [showSimilar, setShowSimilar] = useState(false);
  const [showMove, setShowMove] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [finalStats, setFinalStats] = useState({ count: 0, bytes: 0 });
  const [toast, setToast] = useState(null);
  const [realAlbums, setRealAlbums] = useState([]); // for the quick chips

  // Real device albums for the quick-categorize chip row.
  useEffect(() => {
    let alive = true;
    MediaLibrary.getAlbumsAsync()
      .then((list) => alive && setRealAlbums(list.filter((a) => a.assetCount > 0)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const sessionRef = useRef(null);
  const cleanedRef = useRef({ count: 0, bytes: 0 });
  const viewedRef = useRef(new Set());
  const markStackRef = useRef([]); // mark order, for undo
  const frozenAssetRef = useRef(null);
  const orderRef = useRef([]); // asset ids in cleaning order
  // Lazy segment loading: only ~3 groups ahead are fetched; more pages load
  // AFTER the user confirms a group.
  const allRef = useRef([]);
  const cursorRef = useRef({ after: undefined, hasNext: true });
  const loadingMoreRef = useRef(false);
  const aliveRef = useRef(true);
  const rangeRef = useRef(null);
  const fetchedPagesRef = useRef(false); // did THIS session hit MediaStore?
  const listSavedRef = useRef(false);

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

  // Suspend background analysis while cleaning — swipes stay buttery.
  useFocusEffect(
    useCallback(() => {
      analyzer.suspend();
      return () => analyzer.resume();
    }, [])
  );

  /** Pull pages until at least `minCount` scoped photos are loaded. */
  const ensureLoaded = useCallback(
    async (minCount) => {
      if (loadingMoreRef.current) return;
      loadingMoreRef.current = true;
      try {
        while (
          aliveRef.current &&
          cursorRef.current.hasNext &&
          allRef.current.length < Math.min(minCount, 20000)
        ) {
          const page = await getAssetsPage(albumId, 'photo', cursorRef.current.after);
          if (!aliveRef.current) return;
          fetchedPagesRef.current = true;
          const r = rangeRef.current;
          const scoped = page.assets.filter(
            (a) =>
              !r ||
              (a.creationTime && a.creationTime >= r.start && a.creationTime < r.end)
          );
          const pageAssets =
            settings.order === 'random' ? shuffle(scoped) : scoped;
          allRef.current = [...allRef.current, ...pageAssets];
          cursorRef.current = { after: page.endCursor, hasNext: page.hasNext };
          orderRef.current = allRef.current.map((a) => a.id);
          setGroups(chunk(allRef.current, groupSize));
        }
        sessionManager.saveOrder(orderRef.current);
        // Whole album loaded (unscoped) — persist it as the local index so
        // the NEXT session opens with zero MediaStore scanning.
        if (
          fetchedPagesRef.current &&
          !listSavedRef.current &&
          !cursorRef.current.hasNext &&
          !rangeRef.current
        ) {
          listSavedRef.current = true;
          saveCachedAssetList(albumId, 'photo', allRef.current);
        }
      } finally {
        loadingMoreRef.current = false;
      }
    },
    [albumId, groupSize, settings.order]
  );

  // ---- Load: lazy segments for fresh sessions, full ordered for resume ----
  useEffect(() => {
    let alive = true;
    aliveRef.current = true;
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

      let fullAlbumList = null; // reused for the "before" snapshot

      rangeRef.current = range;

      if (assetIds) {
        // Explicit subset (suggestions) — small, load directly.
        const assets = await getAssetsByIds(assetIds);
        if (!alive) return;
        const ordered =
          settings.order === 'random' && !resuming ? shuffle(assets) : assets;
        allRef.current = ordered;
        cursorRef.current = { after: undefined, hasNext: false };
        orderRef.current = ordered.map((a) => a.id);
        setGroups(chunk(ordered, groupSize));
        setLoading(false);
      } else if (resuming) {
        // Resume needs the full list to rebuild the EXACT saved order.
        let all = [];
        let after;
        let hasNext = true;
        while (hasNext && all.length < 20000) {
          const page = await getAssetsPage(albumId, 'photo', after);
          if (!alive) return;
          all = [...all, ...page.assets.filter(inRange)];
          hasNext = page.hasNext;
          after = page.endCursor;
        }
        if (!range) {
          fullAlbumList = all;
          saveCachedAssetList(albumId, 'photo', all); // refresh local index
        }
        const savedOrder = (await sessionManager.getOrder()) || [];
        const byId = Object.fromEntries(all.map((a) => [a.id, a]));
        const ordered = savedOrder.map((id) => byId[id]).filter(Boolean);
        const rest = all.filter((a) => !savedOrder.includes(a.id));
        const finalList = [...ordered, ...rest];
        allRef.current = finalList;
        cursorRef.current = { after: undefined, hasNext: false };
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
        // Fresh session: try the persisted local index first (Fossify-style)
        // — fingerprint unchanged means the FULL list loads instantly with
        // zero MediaStore scanning.
        const cachedList = await getCachedAssetList(albumId, 'photo');
        if (!alive) return;
        if (cachedList) {
          const scoped = cachedList.filter(inRange);
          const ordered =
            settings.order === 'random' ? shuffle(scoped) : scoped;
          allRef.current = ordered;
          cursorRef.current = { after: undefined, hasNext: false };
          orderRef.current = ordered.map((a) => a.id);
          setGroups(chunk(ordered, groupSize));
          setLoading(false);
          if (!range) fullAlbumList = cachedList;
        } else {
          // No/stale index: SEGMENTED loading — just ~3 groups ahead. The
          // rest loads as the user confirms groups; the finished list is
          // then saved as the new index.
          await ensureLoaded(groupSize * 3);
          if (!alive) return;
          setLoading(false);
          if (!range && !cursorRef.current.hasNext) fullAlbumList = allRef.current;
        }
      }

      // Session bookkeeping (snapshot reuses the already-loaded list when
      // the scope is the whole album — no second full fetch).
      if (resuming) {
        sessionRef.current = pending;
      } else {
        const before = await getAlbumSnapshot(albumId, 'photo', fullAlbumList);
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
      aliveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep ~3 groups pre-loaded ahead of the current one.
  useEffect(() => {
    ensureLoaded((gi + 3) * groupSize);
  }, [gi, groupSize, ensureLoaded]);

  // Persist progress (group, position, marks) for exact resume.
  // Only on group / mark changes — NOT every swipe (no per-swipe disk IO).
  const piRef = useRef(pi);
  piRef.current = pi;
  useEffect(() => {
    if (!sessionRef.current) return;
    sessionManager.saveProgress({
      groupIndex: gi,
      photoIndex: piRef.current,
      markedIds: [...markedIds],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gi, markedIds]);

  // ---- Derived state ----
  const group = groups[gi] || [];
  const visible = useMemo(
    () => group.filter((a) => !markedIds.has(a.id)),
    [group, markedIds]
  );
  const markedInGroup = useMemo(
    () => group.filter((a) => markedIds.has(a.id)),
    [group, markedIds]
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

  // Prefetch the next TWO photos so swiping feels instant even while the
  // decoder is still warm on slower devices.
  useEffect(() => {
    [visible[pi + 1], visible[pi + 2]].forEach((next) => {
      if (next && next.mediaType !== 'video') {
        ExpoImage.prefetch(next.uri).catch(() => {});
      }
    });
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

  // End of group: only ask for confirmation when something is actually
  // marked for deletion — otherwise move straight on to the next group.
  // (Assigned every render below, after nextGroup exists.)
  const endOfGroupRef = useRef(() => {});

  const afterRemovalAdvance = useCallback(
    (remainingCount) => {
      if (remainingCount === 0) endOfGroupRef.current();
      else if (pi >= remainingCount) setPi(remainingCount - 1);
    },
    [pi]
  );

  // ---- Gesture callbacks ----
  const slideInFrom = useCallback(
    (fromX) => {
      // Start closer (35%) so the next photo is visible almost instantly —
      // no blank gap while it slides in.
      tx.value = fromX * 0.35;
      ty.value = 0;
      tx.value = withTiming(0, EASE);
    },
    [tx, ty]
  );

  const onSwipeNext = useCallback(() => {
    if (pi < visible.length - 1) {
      setPi(pi + 1);
      slideInFrom(SCREEN_W);
    } else {
      tx.value = withTiming(0, EASE);
      endOfGroupRef.current();
    }
  }, [pi, visible.length, slideInFrom, SCREEN_W, tx]);

  const onSwipePrev = useCallback(() => {
    if (pi > 0) {
      setPi(pi - 1);
      slideInFrom(-SCREEN_W);
    } else {
      tx.value = withTiming(0, EASE);
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
    ty.value = withTiming(0, EASE);
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
        if (e.translationX < -SWIPE_X || e.velocityX < -800) {
          tx.value = withTiming(-SCREEN_W, { duration: 110 }, (finished) => {
            if (finished) runOnJS(callNext)();
          });
        } else if (e.translationX > SWIPE_X || e.velocityX > 800) {
          tx.value = withTiming(SCREEN_W, { duration: 110 }, (finished) => {
            if (finished) runOnJS(callPrev)();
          });
        } else {
          tx.value = withTiming(0, EASE);
        }
      } else if (
        e.translationY < -DELETE_THRESHOLD ||
        (e.translationY < -60 && e.velocityY < FLICK_VELOCITY)
      ) {
        ty.value = withTiming(-SCREEN_H, { duration: 140 }, (finished) => {
          if (finished) runOnJS(callDel)();
        });
      } else if (e.translationY > MOVE_THRESHOLD) {
        ty.value = withTiming(0, EASE);
        runOnJS(callDown)();
      } else {
        ty.value = withTiming(0, EASE);
      }
    });

  // ---- Move flow (shared by swipe-down sheet AND the quick chips) ----
  // Categorizing ≠ deleting: the photo STAYS in the cleaning flow; only the
  // ✓ chip switches to the new album.
  const moveCurrentTo = async (album) => {
    if (!current) return;
    const id = current.id;
    try {
      await moveAssetsToAlbum([current], album);
      incrementUsage(album.id);
      setAlbumOverrides((m) => ({ ...m, [id]: album.id }));
      showToast(t('moved_to', { album: album.title }));
    } catch (e) {
      // move failed — nothing changes
    }
  };

  const handleMove = async (album) => {
    setShowMove(false);
    await moveCurrentTo(album);
  };

  // "+" chip: create a NEW album with the current photo (photo stays).
  const createAlbumWithCurrent = async (name) => {
    if (!current || !name) return;
    const id = current.id;
    try {
      const album = await MediaLibrary.createAlbumAsync(name, current, false);
      if (album) {
        incrementUsage(album.id);
        setAlbumOverrides((m) => ({ ...m, [id]: album.id }));
      }
      showToast(t('moved_to', { album: name }));
      const list = await MediaLibrary.getAlbumsAsync();
      setRealAlbums(list.filter((a) => a.assetCount > 0));
    } catch (e) {
      // creation failed — photo stays
    }
  };

  // The current photo's album for the ✓ chip: a manual move wins, then the
  // asset's own albumId (Android), then the cleaning scope's album.
  const currentAssetAlbumId =
    (displayAsset &&
      (albumOverrides[displayAsset.id] || displayAsset.albumId)) ||
    (albumId !== ALL_ALBUM_ID ? albumId : null);

  // ---- Group confirmation (ONE batched delete per group) ----
  // Spare / re-mark from the confirm sheet and its full-screen viewer.
  const unmark = (id) => {
    markStackRef.current = markStackRef.current.filter((x) => x !== id);
    setMarkedIds((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  };

  const remark = (id) => {
    if (!markStackRef.current.includes(id)) markStackRef.current.push(id);
    setMarkedIds((s) => new Set(s).add(id));
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

  const nextGroup = async () => {
    setShowConfirm(false);
    setPi(0);
    tx.value = 0;
    ty.value = 0;
    // Android has no OS memory-warning event — proactively drop the decoded
    // -bitmap cache every few groups so huge albums can't OOM the app.
    if (Platform.OS === 'android' && (gi + 1) % 5 === 0) {
      ExpoImage.clearMemoryCache().catch(() => {});
    }
    if (gi < groups.length - 1) {
      setGi(gi + 1);
      return;
    }
    // Last loaded group but more photos exist — load the next segment first.
    if (cursorRef.current.hasNext) {
      await ensureLoaded((gi + 2) * groupSize);
      const totalGroups = Math.ceil(allRef.current.length / groupSize);
      if (gi < totalGroups - 1) {
        setGi(gi + 1);
        return;
      }
    }
    finishAll();
  };

  // Fresh closure every render: open the sheet only if this group has marks
  // (markStackRef is updated synchronously, so a just-marked last photo is
  // seen immediately). No marks → straight to the next group, no sheet.
  endOfGroupRef.current = () => {
    const stack = new Set(markStackRef.current);
    if (group.some((a) => stack.has(a.id))) setShowConfirm(true);
    else nextGroup();
  };

  const skipGroup = () => {
    clearGroupMarks(); // keep all = spare everything in this group
    nextGroup();
  };

  const deletingRef = useRef(false); // ignore extra taps while the system dialog is up
  const deleteMarkedNow = async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    try {
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
    } finally {
      deletingRef.current = false;
    }
  };

  const closeConfirmOnly = () => {
    if (visible.length === 0) {
      // Every photo in the group is marked and the user backed out —
      // treat it as "keep all" so nothing is deleted silently later.
      clearGroupMarks();
      nextGroup();
      return;
    }
    setShowConfirm(false);
    if (pi >= visible.length) setPi(visible.length - 1);
    tx.value = 0;
    ty.value = 0;
  };

  // ---- Completion / exit ----
  /**
   * Session bookkeeping runs in the BACKGROUND — never blocks the UI.
   * `finish=false` (plain exit) PAUSES the session: the shuffled order,
   * group, position and marks all persist, so the home cards keep showing
   * THIS group and re-entering resumes it exactly. Only completing the
   * whole album (finish=true) ends the session.
   */
  const settleSession = (finish) => {
    const viewed = viewedRef.current.size;
    const session = sessionRef.current;
    sessionRef.current = null;
    (async () => {
      try {
        if (viewed > 0) await recordViewed('photo', viewed);
        if (session && finish) await sessionManager.finishSession(session);
      } catch (e) {
        // stats are best-effort
      }
    })();
  };

  const finishAll = () => {
    setFinalStats({ ...cleanedRef.current });
    setCompleted(true);
    settleSession(true);
  };

  // X = pause & leave. Nothing is deleted and nothing is lost: the same
  // group (same random order) is waiting on the home screen.
  const exit = () => {
    navigation.goBack(); // leave IMMEDIATELY
    settleSession(false);
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
          style={[
            styles.exitBtn,
            {
              backgroundColor: colors.chartTrack,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.border,
            },
          ]}
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
          style={[
            styles.similarPill,
            {
              backgroundColor: colors.accent,
              bottom: Math.max(insets.bottom, 12) + 128,
            },
          ]}
          onPress={() => setShowSimilar(true)}
        >
          <Ionicons name="copy-outline" size={14} color="#fff" />
          <Text style={styles.similarText}>
            {t('similar_pill', { count: currentCluster.length })}
          </Text>
        </Pressable>
      )}

      {/* Quick-categorize chips: [+] [✓current] [others by usage] */}
      <View
        style={[styles.chipsWrap, { bottom: Math.max(insets.bottom, 12) + 80 }]}
        pointerEvents="box-none"
      >
        <AlbumChips
          albums={realAlbums}
          currentAlbumId={currentAssetAlbumId}
          onSelect={moveCurrentTo}
          onCreate={createAlbumWithCurrent}
        />
      </View>

      {toast && (
        <View style={styles.toast}>
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
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

      <GroupConfirmSheet
        visible={showConfirm}
        assets={markedInGroup}
        onUnmark={unmark}
        onRemark={remark}
        onClose={closeConfirmOnly}
        onKeepAll={skipGroup}
        onDelete={deleteMarkedNow}
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
  chipsWrap: { position: 'absolute', left: 0, right: 0 },
  similarPill: {
    position: 'absolute',
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
    backgroundColor: 'rgba(0,0,0,0.75)', // readable over any content
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
