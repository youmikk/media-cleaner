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
  Alert,
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
import * as reviewedStore from '../utils/reviewedStore';
import * as PhotoMove from '../../modules/photo-move';
import { log } from '../utils/logger';
import analyzer from '../utils/chunkedAnalyzer';
import { reverseGeocode } from '../utils/geocode';
import {
  getAssetsPage,
  getAssetsByIds,
  getAlbumSnapshot,
  getCachedAssetList,
  saveCachedAssetList,
  moveAssetsToAlbum,
  removeAssetsFromAlbum,
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

/** WITHIN a group the order is always FIXED (newest first) — random mode
 *  only randomizes which photos land in a group, not their order. */
function sortGroup(g) {
  return [...g].sort((a, b) => (b.creationTime || 0) - (a.creationTime || 0));
}

function makeGroups(list, size) {
  return chunk(list, size).map(sortGroup);
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
  // Blocks the look-ahead loader until the initial load (fresh, cached OR
  // RESUME) has fully set up state. Without this, the mount-time effect
  // raced the resume path, reshuffled and OVERWROTE the saved order —
  // "re-entering shows a different group".
  const initializedRef = useRef(false);
  // Persistent "already reviewed" record: photos whose group was confirmed
  // (kept OR deleted) never re-enter the random pool in later sessions.
  const reviewedSetRef = useRef(new Set());

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

  // photoo-style CARD STACK: the neighbour the gesture is moving toward is
  // ALREADY rendered underneath, so committing a swipe swaps to a photo
  // that's fully on screen — zero load gap, zero flicker, and what you see
  // is always the real asset (no stale frames).
  const prevUnderStyle = useAnimatedStyle(() => ({
    opacity: tx.value > 8 ? 1 : 0,
  }));
  const nextUnderStyle = useAnimatedStyle(() => ({
    opacity: tx.value < -8 || ty.value < -8 ? 1 : 0,
  }));

  // Timer is tracked so a rapid second toast replaces the first cleanly and
  // nothing calls setState after the screen is gone.
  const toastTimerRef = useRef(null);
  const showToast = (msg) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 1800);
  };
  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

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
      if (!initializedRef.current || loadingMoreRef.current) return;
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
          const scoped = page.assets
            .filter(
              (a) =>
                !r ||
                (a.creationTime && a.creationTime >= r.start && a.creationTime < r.end)
            )
            // Already-reviewed photos never re-enter the pool.
            .filter((a) => !reviewedSetRef.current.has(a.id));
          const pageAssets =
            settings.order === 'random' ? shuffle(scoped) : scoped;
          allRef.current = [...allRef.current, ...pageAssets];
          cursorRef.current = { after: page.endCursor, hasNext: page.hasNext };
          orderRef.current = allRef.current.map((a) => a.id);
          setGroups(makeGroups(allRef.current, groupSize));
        }
        // Preset lists (Largest Files / Low Quality) must never overwrite
        // the paused album session's saved order — the home cards follow it.
        if (!assetIds) sessionManager.saveOrder(orderRef.current);
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
    [albumId, groupSize, settings.order, assetIds]
  );

  // ---- Load: lazy segments for fresh sessions, full ordered for resume ----
  useEffect(() => {
    let alive = true;
    aliveRef.current = true;
    (async () => {
      const pending = await sessionManager.getPendingSession();
      log(
        'clean.load',
        `resume=${resume} pending=${pending ? pending.type + '/' + pending.albumId + '/g' + (pending.groupIndex || 0) : 'none'} album=${albumId}`
      );
      const resuming =
        resume &&
        pending &&
        !pending.assetIds && // stale preset sessions (pre-fix) are not resumable
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
        setGroups(makeGroups(ordered, groupSize));
        initializedRef.current = true;
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
        // CONFIRMED groups (recorded in reviewedStore) are dropped from the
        // order entirely — deletions in earlier groups then can't shift the
        // remaining group boundaries. The group you left mid-way is always
        // the FIRST group after resume, photo-for-photo identical.
        const savedOrder = (await sessionManager.getOrder()) || [];
        const reviewed = await reviewedStore.getReviewed(albumId);
        reviewedSetRef.current = reviewed;
        const byId = Object.fromEntries(all.map((a) => [a.id, a]));
        const ordered = savedOrder
          .filter((id) => !reviewed.has(id))
          .map((id) => byId[id])
          .filter(Boolean);
        const inOrder = new Set(savedOrder);
        const rest = all.filter(
          (a) => !inOrder.has(a.id) && !reviewed.has(a.id)
        );
        // NEW photos taken since the session started: sorted per the
        // user's order setting and inserted right AFTER the interrupted
        // group — they show up as the very next group instead of hiding
        // at the tail of a long paused session.
        const restSorted =
          settings.order === 'random'
            ? shuffle(rest)
            : [...rest].sort(
                (a, b) => (b.creationTime || 0) - (a.creationTime || 0)
              );
        const finalList =
          restSorted.length > 0 && ordered.length > groupSize
            ? [
                ...ordered.slice(0, groupSize),
                ...restSorted,
                ...ordered.slice(groupSize),
              ]
            : [...ordered, ...restSorted];
        log(
          'clean.resume',
          `order=${savedOrder.length} reviewed=${reviewed.size} kept=${ordered.length} rest=${rest.length}`
        );
        allRef.current = finalList;
        cursorRef.current = { after: undefined, hasNext: false };
        orderRef.current = finalList.map((a) => a.id);
        if (!alive) return;
        setGroups(makeGroups(finalList, groupSize));
        setGi(0); // the interrupted group is always first now
        const savedMarks = new Set(pending.markedIds || []);
        // Drop marks whose asset no longer resolves (deleted outside the
        // app, or a similar-modal pick from outside the restored range).
        // A mark that can't be resolved can never be cleared either, and one
        // of them was enough to reopen an empty confirm sheet at every
        // group end for the rest of the session.
        const liveIds = new Set(finalList.map((a) => a.id));
        const usableMarks = new Set(
          [...savedMarks].filter((id) => liveIds.has(id))
        );
        // Clamp to what will actually be VISIBLE: marked photos are filtered
        // out of the group, so a saved index measured against groupSize left
        // the user swiping right several times with nothing happening.
        const firstGroup = finalList.slice(0, groupSize);
        const visibleCount = firstGroup.filter(
          (a) => !usableMarks.has(a.id)
        ).length;
        setPi(
          Math.min(pending.photoIndex || 0, Math.max(0, visibleCount - 1))
        );
        setMarkedIds(usableMarks);
        markStackRef.current = [...usableMarks];
        // Re-save the restored order: guards against any earlier writer.
        sessionManager.saveOrder(orderRef.current);
        initializedRef.current = true;
        setLoading(false);
      } else {
        // Fresh session: reviewed photos are EXCLUDED from the pool — a
        // group you confirmed (kept or deleted) never comes back until the
        // whole album has been reviewed once (then the round resets).
        reviewedSetRef.current = await reviewedStore.getReviewed(albumId);
        if (!alive) return;
        // Try the persisted local index first (Fossify-style) —
        // fingerprint unchanged means the FULL list loads instantly with
        // zero MediaStore scanning.
        const cachedList = await getCachedAssetList(albumId, 'photo');
        if (!alive) return;
        if (cachedList) {
          const inR = cachedList.filter(inRange);
          let pool = inR.filter((a) => !reviewedSetRef.current.has(a.id));
          if (pool.length === 0 && inR.length > 0) {
            // Round complete: every photo reviewed once — start over.
            await reviewedStore.clearReviewed(albumId);
            reviewedSetRef.current = new Set();
            pool = inR;
          }
          const ordered = settings.order === 'random' ? shuffle(pool) : pool;
          allRef.current = ordered;
          cursorRef.current = { after: undefined, hasNext: false };
          orderRef.current = ordered.map((a) => a.id);
          setGroups(makeGroups(ordered, groupSize));
          initializedRef.current = true;
          setLoading(false);
          if (!range) fullAlbumList = cachedList;
        } else {
          // No/stale index: SEGMENTED loading — just ~3 groups ahead. The
          // rest loads as the user confirms groups; the finished list is
          // then saved as the new index.
          initializedRef.current = true; // segmented loading may start now
          await ensureLoaded(groupSize * 3);
          if (!alive) return;
          if (
            allRef.current.length === 0 &&
            !cursorRef.current.hasNext &&
            reviewedSetRef.current.size > 0
          ) {
            // Round complete (everything filtered as reviewed) — reset
            // and reload from scratch.
            await reviewedStore.clearReviewed(albumId);
            reviewedSetRef.current = new Set();
            cursorRef.current = { after: undefined, hasNext: true };
            await ensureLoaded(groupSize * 3);
            if (!alive) return;
          }
          setLoading(false);
          if (!range && !cursorRef.current.hasNext) fullAlbumList = allRef.current;
        }
      }

      // Session bookkeeping (snapshot reuses the already-loaded list when
      // the scope is the whole album — no second full fetch).
      if (resuming) {
        sessionRef.current = pending;
      } else if (assetIds) {
        // Suggestion cleanings (Largest Files / Low Quality) are EPHEMERAL:
        // an in-memory session only. Persisting one used to overwrite the
        // paused album session + saved order, so the home cards suddenly
        // showed the preset's photos and resume lost the real group.
        const before = await getAlbumSnapshot(albumId, 'photo', fullAlbumList);
        sessionRef.current = {
          type: 'photo',
          albumId,
          albumTitle,
          groupSize,
          assetIds,
          timeRange,
          before,
          ephemeral: true,
        };
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
    // Ephemeral (preset) sessions are never persisted — saveProgress would
    // patch the PAUSED album session on disk and corrupt its resume state.
    if (!sessionRef.current || sessionRef.current.ephemeral) return;
    sessionManager.saveProgress({
      groupIndex: gi,
      photoIndex: piRef.current,
      markedIds: [...markedIds],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gi, markedIds]);

  // Persist the in-group position too. The effect above only fires on group
  // or mark changes, and setPi(0) has already run by then — so browsing four
  // photos without marking any saved nothing, and resuming dropped the user
  // back on the first photo of the group.
  useEffect(() => {
    if (!sessionRef.current || sessionRef.current.ephemeral) return;
    const id = setTimeout(() => {
      sessionManager.saveProgress({ photoIndex: piRef.current });
    }, 600);
    return () => clearTimeout(id);
  }, [pi]);

  // ---- Derived state ----
  const group = groups[gi] || [];
  // Assets selected in the Similar modal can live OUTSIDE the current
  // group — keep their full objects so the confirm sheet can show and
  // delete them together with the group's marks.
  const extraAssetsRef = useRef({}); // id -> asset
  const deletedIdsRef = useRef(new Set()); // already deleted this session
  const visible = useMemo(
    () =>
      group.filter(
        (a) => !markedIds.has(a.id) && !deletedIdsRef.current.has(a.id)
      ),
    [group, markedIds]
  );
  // EVERYTHING queued for deletion: swipe marks + similar picks.
  const markedAssets = useMemo(() => {
    const inGroup = group.filter(
      (a) => markedIds.has(a.id) && !deletedIdsRef.current.has(a.id)
    );
    const seen = new Set(inGroup.map((a) => a.id));
    const others = [];
    for (const id of markedIds) {
      if (seen.has(id) || deletedIdsRef.current.has(id)) continue;
      const a =
        extraAssetsRef.current[id] ||
        allRef.current.find((x) => x.id === id);
      if (a) others.push(a);
    }
    return [...inGroup, ...others];
  }, [group, markedIds]);
  const currentIdx = Math.min(pi, Math.max(0, visible.length - 1));
  const current = visible[currentIdx] || null;
  // Lets async handlers check whether the user has moved on since they
  // started — an awaited move that then advances unconditionally skips a
  // photo the user never saw.
  const currentRef = useRef(current);
  currentRef.current = current;
  // Stack neighbours (pre-rendered underneath the top card).
  const prevAsset = currentIdx > 0 ? visible[currentIdx - 1] : null;
  const nextAsset = visible[currentIdx + 1] || null;

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

  // A group can end up with nothing left to show: the Similar modal deletes
  // across group boundaries, so every member of a later group may already be
  // gone by the time it comes up. That rendered a blank card area with
  // "photo 1 of 0" and needed a blind swipe to get past. Skip it instead.
  useEffect(() => {
    if (loading || showConfirm || groups.length === 0) return;
    if (group.length > 0 && visible.length === 0 && markedAssets.length === 0) {
      endOfGroupRef.current();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length, markedAssets.length, group.length, loading, showConfirm]);

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

  // ---- Gesture callbacks (card stack: committing a swipe resets the top
  // card INSTANTLY — the photo underneath is already fully on screen) ----
  const onSwipeNext = useCallback(() => {
    if (pi < visible.length - 1) {
      setPi(pi + 1);
      tx.value = 0;
      ty.value = 0;
    } else {
      tx.value = withTiming(0, EASE);
      endOfGroupRef.current();
    }
  }, [pi, visible.length, tx, ty]);

  const onSwipePrev = useCallback(() => {
    if (pi > 0) {
      setPi(pi - 1);
      tx.value = 0;
      ty.value = 0;
    } else {
      tx.value = withTiming(0, EASE);
    }
  }, [pi, tx, ty]);

  const onSwipeDelete = useCallback(() => {
    if (!current) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (e) {
      // haptics unavailable
    }
    mark(current);
    tx.value = 0;
    ty.value = 0;
    afterRemovalAdvance(visible.length - 1);
  }, [current, mark, visible.length, afterRemovalAdvance, ty, tx]);

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
  // ✓ chip switches to the new album. After categorizing, the flow ADVANCES
  // to the next photo automatically; tapping the ✓ chip again UNDOES it.
  const overrideHistoryRef = useRef({}); // assetId -> {fromAlbumId, toAlbumId}

  // Categorizing on Android REQUIRES the in-place move permission — no
  // permission means the tap prompts for it instead of moving anything.
  const maybeOfferNativeMove = () => {
    Alert.alert(t('native_move_title'), t('native_move_message'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('native_move_enable'),
        onPress: () => PhotoMove.requestAllFilesPermission(),
      },
    ]);
  };

  // One categorization at a time. Without this, a double-tap on a chip sent
  // two in-place moves for the same id (the second acting on a path the
  // first had already invalidated), and each completion called callNext() —
  // so the flow jumped two photos and skipped one entirely.
  const movingRef = useRef(false);

  const moveCurrentTo = async (album) => {
    if (!current || movingRef.current) return;
    const id = current.id;
    const asset = current;
    const fromAlbumId = albumOverrides[id] || current.albumId || null;
    movingRef.current = true;
    try {
      if (
        Platform.OS === 'android' &&
        PhotoMove.hasNativeMove() &&
        PhotoMove.hasAllFilesPermission()
      ) {
        // photoo-style TRUE in-place move: bytes, EXIF and mtime all
        // untouched — no copy, no pending deletion.
        const [res] = await PhotoMove.moveToAlbum([id], album.title);
        if (!res || !res.ok) throw new Error(res && res.error);
        asset.uri = 'file://' + res.newPath; // keep displaying the photo
        overrideHistoryRef.current[id] = {
          fromAlbumId,
          toAlbumId: album.id,
          native: true,
          // Absolute source folder, so undo can put the file back exactly
          // where it came from. Deriving it from the album title instead
          // sent camera-roll photos to Pictures/Camera rather than
          // DCIM/Camera — a different folder that shows up as a new album.
          oldDir: res.oldDir || null,
          fromAlbumTitle:
            (realAlbums.find((a) => a.id === fromAlbumId) || {}).title || null,
        };
      } else if (Platform.OS === 'android' && PhotoMove.hasNativeMove()) {
        // Native module present but "All files access" not granted yet:
        // prompt once and do nothing — categorizing only ever uses the
        // info-preserving in-place move.
        maybeOfferNativeMove();
        return;
      } else {
        // iOS (collections — file untouched) or Expo Go dev fallback.
        await moveAssetsToAlbum([current], album);
        overrideHistoryRef.current[id] = { fromAlbumId, toAlbumId: album.id };
      }
      incrementUsage(album.id);
      setAlbumOverrides((m) => ({ ...m, [id]: album.id }));
      showToast(t('moved_to', { album: album.title }));
      // Only advance if we are still on the photo we just moved — the user
      // may have swiped on during the await, and blindly calling next then
      // skipped an unseen photo.
      if (currentRef.current && currentRef.current.id === id) callNext();
    } catch (e) {
      // move failed — nothing changes
    } finally {
      movingRef.current = false;
    }
  };

  const handleMove = async (album) => {
    setShowMove(false);
    await moveCurrentTo(album);
  };

  // "+" chip: create a NEW album with the current photo (photo stays).
  const createAlbumWithCurrent = async (name) => {
    if (!current || !name || movingRef.current) return;
    const id = current.id;
    const asset = current;
    const fromAlbumId = albumOverrides[id] || current.albumId || null;
    movingRef.current = true;
    try {
      if (
        Platform.OS === 'android' &&
        PhotoMove.hasNativeMove() &&
        PhotoMove.hasAllFilesPermission()
      ) {
        // In-place move — the target folder is created automatically.
        const [res] = await PhotoMove.moveToAlbum([id], name);
        if (!res || !res.ok) throw new Error(res && res.error);
        asset.uri = 'file://' + res.newPath;
        const list = await MediaLibrary.getAlbumsAsync();
        setRealAlbums(list.filter((a) => a.assetCount > 0));
        const album = list.find((a) => a.title === name);
        if (album) incrementUsage(album.id);
        overrideHistoryRef.current[id] = {
          fromAlbumId,
          toAlbumId: album ? album.id : name,
          native: true,
          oldDir: res.oldDir || null,
          fromAlbumTitle:
            (realAlbums.find((a) => a.id === fromAlbumId) || {}).title || null,
        };
        setAlbumOverrides((m) => ({ ...m, [id]: album ? album.id : name }));
      } else if (Platform.OS === 'android' && PhotoMove.hasNativeMove()) {
        // Needs "All files access" — prompt once, do nothing this time.
        maybeOfferNativeMove();
        return;
      } else {
        // iOS (collections) or Expo Go dev fallback.
        const album = await MediaLibrary.createAlbumAsync(name, current, false);
        if (album) {
          incrementUsage(album.id);
          overrideHistoryRef.current[id] = { fromAlbumId, toAlbumId: album.id };
          setAlbumOverrides((m) => ({ ...m, [id]: album.id }));
        }
        const list = await MediaLibrary.getAlbumsAsync();
        setRealAlbums(list.filter((a) => a.assetCount > 0));
      }
      showToast(t('moved_to', { album: name }));
      if (currentRef.current && currentRef.current.id === id) callNext();
    } catch (e) {
      // creation failed — photo stays
    } finally {
      movingRef.current = false;
    }
  };

  // Second tap on the ✓ chip: undo THIS SESSION's categorization — move the
  // photo back to its previous album (or just remove it on iOS).
  const cancelCurrentCategory = async () => {
    if (!displayAsset || movingRef.current) return;
    const id = displayAsset.id;
    const rec = overrideHistoryRef.current[id];
    if (!rec) return;
    movingRef.current = true;
    try {
      if (rec.native) {
        // Restore to the ORIGINAL absolute folder when we recorded it; the
        // album-title fallback only exists for records written before that
        // was captured.
        const backTitle = rec.fromAlbumTitle || 'Camera';
        const [res] = await PhotoMove.moveToAlbum(
          [id],
          backTitle,
          rec.oldDir || null
        );
        // A failed undo must NOT look like a successful one. MediaScanner
        // re-indexes a moved file under a NEW MediaStore id, so this lookup
        // can legitimately fail — and the old code then still dropped the
        // undo record, rolled back the chip and said "category removed"
        // while the file sat in the new album, now unrecoverable.
        if (!res || !res.ok) throw new Error((res && res.error) || 'undo_failed');
        displayAsset.uri = 'file://' + res.newPath;
      } else {
        // iOS: pull the photo back out of the collection.
        const backAlbum = rec.fromAlbumId
          ? realAlbums.find((a) => a.id === rec.fromAlbumId)
          : null;
        const toAlbum = realAlbums.find((a) => a.id === rec.toAlbumId);
        if (backAlbum) {
          await moveAssetsToAlbum([displayAsset], backAlbum);
        } else if (toAlbum) {
          await removeAssetsFromAlbum([displayAsset], toAlbum);
        }
      }
      delete overrideHistoryRef.current[id];
      setAlbumOverrides((m) => {
        const next = { ...m };
        if (rec.fromAlbumId) next[id] = rec.fromAlbumId;
        else delete next[id];
        return next;
      });
      showToast(t('category_cancelled'));
    } catch (e) {
      // Keep the record so the user can try again, and say so.
      showToast(t('category_cancel_failed'));
    } finally {
      movingRef.current = false;
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

  /** Clear a set of marks (group marks + similar picks alike). */
  const clearMarks = (ids) => {
    const drop = new Set(ids);
    setMarkedIds((s) => {
      const next = new Set(s);
      drop.forEach((id) => next.delete(id));
      return next;
    });
    markStackRef.current = markStackRef.current.filter((id) => !drop.has(id));
    drop.forEach((id) => delete extraAssetsRef.current[id]);
  };

  // Clear EVERY mark, not just the ones that still resolve to an asset.
  //
  // The sheet's open/close test uses markStackRef (authoritative), but this
  // used to clear `markedAssets`, which silently drops ids it can't resolve
  // — a photo deleted in the system gallery, or a similar-modal pick from
  // outside the current time range after a resume. One such id was enough to
  // wedge the flow: every group end reopened an empty "delete (0)" sheet
  // whose Delete button was disabled and whose "keep all" could not clear it.
  const clearGroupMarks = () => {
    const ids = [...markStackRef.current];
    if (ids.length > 0) clearMarks(ids);
    markStackRef.current = [];
    setMarkedIds(new Set());
  };

  const nextGroup = async () => {
    // Confirming a group (kept OR deleted) marks every photo in it as
    // REVIEWED — they won't re-enter the pool in later sessions.
    if (!assetIds && group.length > 0) {
      const ids = group.map((a) => a.id);
      ids.forEach((id) => reviewedSetRef.current.add(id));
      reviewedStore.addReviewed(albumId, ids); // fire & forget
    }
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

  // Fresh closure every render: open the sheet if ANYTHING is marked —
  // group marks or similar-modal picks (markStackRef updates synchronously,
  // so a just-marked last photo is seen immediately). Nothing marked →
  // straight to the next group, no sheet.
  endOfGroupRef.current = () => {
    if (markStackRef.current.length > 0) setShowConfirm(true);
    else nextGroup();
  };

  const skipGroup = () => {
    if (deleting) return; // a delete is mid-flight — see deleteMarkedNow
    clearGroupMarks(); // keep all = spare everything in this group
    nextGroup();
  };

  // A delete is in flight. This is STATE, not a ref, because the sheet's
  // other controls have to be disabled while it runs: batchDelete does real
  // work (size lookup, per-file trash copies) BEFORE the system dialog even
  // appears, and that window runs into seconds. Tapping "keep all" during it
  // used to clear the marks and advance a group while the already-captured
  // target list went on to delete the very photos the user just chose to
  // keep — and nextGroup() fired twice, skipping a group that was never
  // shown yet got recorded as reviewed.
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const deleteMarkedNow = async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      // Group marks AND similar-modal picks — deleted together, ONE dialog.
      const targets = markedAssets;
      if (targets.length > 0) {
        try {
          const { count, bytes, deletedIds, skipped } = await batchDelete(
            targets,
            { useRecycleBin: recycleBinActive }
          );
          cleanedRef.current.count += count;
          cleanedRef.current.bytes += bytes;
          if (count > 0) recordCleaned('photo', count, bytes);
          // Only what ACTUALLY went away — a recycle-bin backup that failed
          // leaves its photo in place, and pretending otherwise would hide
          // it from this round while it still sits in the library.
          const gone = deletedIds || targets.map((a) => a.id);
          gone.forEach((id) => deletedIdsRef.current.add(id));
          clearMarks(gone);
          if (skipped > 0) {
            Alert.alert(
              t('delete_forever'),
              t('delete_partial', { count: skipped })
            );
          }
        } catch (e) {
          if (e && e.message === 'trash-no-space') {
            Alert.alert(t('delete_forever'), t('trash_no_space'));
            return;
          }
          // user cancelled the system dialog — keep marks, stay in the sheet
          return;
        }
      }
      nextGroup();
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  const closeConfirmOnly = () => {
    if (deleting) return;
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
  const settledRef = useRef(false);
  const settleSession = (finish) => {
    // Idempotent: completing the album settles once, then the user taps
    // "Done" and beforeRemove fires — without this the viewed count would be
    // recorded twice.
    if (settledRef.current) return;
    settledRef.current = true;
    const viewed = viewedRef.current.size;
    const session = sessionRef.current;
    sessionRef.current = null;
    // Snapshot what this run actually removed. The alternative — diffing two
    // album snapshots — extrapolates the whole album from its 60 newest (and
    // therefore largest) assets, so it could report "0 B freed" after
    // deleting gigabytes.
    const measured = { ...cleanedRef.current };
    // Persist the final in-group position before the session object goes.
    if (session && !session.ephemeral && !finish) {
      sessionManager.saveProgress({ photoIndex: piRef.current });
    }
    (async () => {
      try {
        if (viewed > 0) await recordViewed('photo', viewed);
        if (session && finish) {
          await sessionManager.finishSession(
            { ...session, afterAssets: allRef.current },
            measured
          );
        }
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

  // The X button is not the only way out: Android's hardware back and, in
  // the native-tab build, swiping the fullScreenModal down both leave
  // without touching exit(), so the viewed count never reached the stats.
  // settleSession is idempotent, so a normal exit() still wins the race.
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', () => {
      settleSession(false);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation]);

  // ---- Render ----
  if (loading) {
    return (
      <SafeAreaView edges={['top', 'left', 'right']} style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </SafeAreaView>
    );
  }

  if (completed) {
    return (
      <SafeAreaView edges={['top', 'left', 'right']} style={[styles.center, { backgroundColor: colors.background }]}>
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
      <SafeAreaView edges={['top', 'left', 'right']} style={[styles.center, { backgroundColor: colors.background }]}>
        <Ionicons name="images-outline" size={48} color={colors.subtext} />
        <Text style={[styles.doneSub, { color: colors.subtext, marginTop: 12 }]}>
          {t('no_photos')}
        </Text>
        <Pressable
          style={[styles.doneBtn, { backgroundColor: colors.accent }]}
          // Settle before leaving: startSession already wrote a session to
          // disk by this point, and going straight back left an empty
          // 0-photo session behind that the home screen kept offering to
          // resume.
          onPress={exit}
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
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: colors.background }]}>
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

      <View style={styles.photoArea}>
        {/* UNDER layer: the neighbours, already rendered (photoo stack) */}
        {prevAsset && (
          <Animated.View style={[StyleSheet.absoluteFill, prevUnderStyle]}>
            <PhotoCard asset={prevAsset} inactive isFavorite={false} marked={false} />
          </Animated.View>
        )}
        {nextAsset && (
          <Animated.View style={[StyleSheet.absoluteFill, nextUnderStyle]}>
            <PhotoCard asset={nextAsset} inactive isFavorite={false} marked={false} />
          </Animated.View>
        )}
        {/* TOP card: keyed per asset — always shows the REAL current photo */}
        <GestureDetector gesture={pan}>
          <Animated.View style={[StyleSheet.absoluteFill, cardStyle]}>
            <PhotoCard
              key={displayAsset ? displayAsset.id : 'none'}
              asset={displayAsset}
              isFavorite={displayAsset ? isFavorite(displayAsset.id) : false}
              marked={displayAsset ? markedIds.has(displayAsset.id) : false}
              sizeLabel={sizeLabel}
            />
          </Animated.View>
        </GestureDetector>
      </View>

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
          onCurrentPress={
            displayAsset && overrideHistoryRef.current[displayAsset.id]
              ? cancelCurrentCategory
              : null
          }
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
          // Keep full objects — cluster photos may be outside this group;
          // they'll appear in (and be deleted by) the group confirm sheet.
          assets.forEach((a) => {
            extraAssetsRef.current[a.id] = a;
            mark(a);
          });
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
        assets={markedAssets}
        onUnmark={unmark}
        onRemark={remark}
        onClose={closeConfirmOnly}
        onKeepAll={skipGroup}
        onDelete={deleteMarkedNow}
        busy={deleting}
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
  // Sits ABOVE the album-chip row (chips: bottom+80, ~36 tall) — no overlap.
  indicatorWrap: { paddingVertical: 8, marginBottom: 158 },
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
