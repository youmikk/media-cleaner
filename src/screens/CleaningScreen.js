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
  AppState,
  Share,
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
import { useFavorites, useStats } from '../context/AppContext';
import PhotoCard from '../components/PhotoCard';
import PageIndicator from '../components/PageIndicator';
import BottomInfoBar from '../components/BottomInfoBar';
import GlowingTrashBar from '../components/GlowingTrashBar';
import EXIFModal from '../components/EXIFModal';
import SimilarModal from '../components/SimilarModal';
import PhotoViewer from '../components/PhotoViewer';
import MoveSheet from '../components/MoveSheet';
import AlbumChips from '../components/AlbumChips';
import GroupConfirmSheet from '../components/GroupConfirmSheet';
import { incrementUsage } from '../utils/albumUsage';
import { batchDelete } from '../utils/deletionManager';
import * as sessionManager from '../utils/sessionManager';
import * as reviewedStore from '../utils/reviewedStore';
import * as suggestionStore from '../utils/suggestionStore';
import * as PhotoMove from '../../modules/photo-move';
import { log } from '../utils/logger';
import analyzer from '../utils/chunkedAnalyzer';
import { reverseGeocode } from '../utils/geocode';
import {
  getRawAlbums,
  getAssetsPage,
  getAssets,
  getAssetsByIds,
  getAlbumSnapshot,
  getCachedAssetList,
  saveCachedAssetList,
  moveAssetsToAlbum,
  removeAssetsFromAlbum,
  formatBytes,
  ALL_ALBUM_ID,
} from '../utils/albumHelpers';

// expo-sharing gives the real system share sheet for a FILE. Guarded: Expo
// Go and binaries built before it was added fall back to RN's Share, which
// can only pass a url/string.
let Sharing = null;
try {
  // eslint-disable-next-line global-require
  Sharing = require('expo-sharing');
} catch (e) {
  Sharing = null;
}

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
 * One card of the filmstrip.
 *
 * Its position depends ONLY on its absolute index in `visible`, never on
 * which photo is currently selected — so the re-render that advances the
 * selection moves nothing on screen. The parent renders these in a KEYED
 * array, so a neighbour promoted to current keeps its already-decoded
 * expo-image view instead of remounting.
 */
function StackLayer({ asset, index, screenW, offset, ty, dragId, children }) {
  const style = useAnimatedStyle(() => {
    const x = index * screenW + offset.value;
    return {
      transform: [
        { translateX: x },
        // Vertical drag belongs to the card that started the gesture. Any
        // other card sits flat, which is what makes an up-swipe commit safe:
        // the marked card unmounts still holding the offset, and the photo
        // taking its place is simply at 0.
        { translateY: dragId.value === asset.id ? ty.value : 0 },
      ],
      // Clamped: during a drag a neighbour can travel further than one
      // screen, and the default linear extrapolation would take opacity
      // negative.
      opacity: interpolate(Math.abs(x), [0, screenW], [1, 0.4], 'clamp'),
    };
  }, [index, screenW, asset.id]);
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      {children}
    </Animated.View>
  );
}

/**
 * Swipe-based cleaning flow, for PHOTOS and VIDEOS alike (`mediaType`).
 * - Swiping up MARKS an item; the actual media-library deletion happens ONCE
 *   per group ("Delete All Marked") — a single system dialog per batch.
 * - First page of the album shows immediately; the rest streams in.
 * - Sessions resume exactly: shuffled order, group, position and marks.
 *
 * The videos tab used to have its own full-screen black feed. Two screens
 * meant two behaviours drifting apart (and two sets of bugs) for what is the
 * same flow, so there is one screen now; only the card body differs, and
 * PhotoCard already handles that.
 */
export default function CleaningScreen({ route, navigation }) {
  const {
    albumId,
    albumTitle,
    assetIds = null,
    resume = false,
    sizesById = null,
    // Set when the session was started from a smart-suggestion card. Every
    // confirmed group is recorded under this name so the card stops offering
    // photos the user has already been through.
    suggestionKey = null,
    timeRange = null, // {start, end} — year / year-month scope
    mediaType = 'photo', // 'photo' | 'video'
  } = route.params;
  const isVideo = mediaType === 'video';
  const { colors, t, settings, setSetting, recycleBinActive, language } = useSettings();
  const { recordCleaned, recordViewed } = useStats();
  const { toggleFavorite, replaceFavoriteId, isFavorite } = useFavorites();
  const { width: SCREEN_W, height: SCREEN_H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const groupSize =
    route.params.groupSize ||
    (isVideo ? settings.videoGroupSize : settings.groupSize) ||
    5;
  // Reviewed history is per album AND per media type — photo and video
  // albums share ids, so the video flow needs its own namespace.
  const reviewScope = reviewedStore.scopeFor(mediaType);
  // ~22% of screen height — no need to drag all the way to the top; a fast
  // flick (velocity) deletes from even less.
  const DELETE_THRESHOLD = SCREEN_H * 0.22;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
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
  // Full-screen pinch/pan/double-tap viewer for the photo under the finger.
  const [showZoom, setShowZoom] = useState(false);
  const [showMove, setShowMove] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [finalStats, setFinalStats] = useState({ count: 0, bytes: 0 });
  const [toast, setToast] = useState(null);
  const [realAlbums, setRealAlbums] = useState([]); // for the quick chips
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [videoUriById, setVideoUriById] = useState({});
  const videoFallbackTriedRef = useRef(new Set());

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      setAppActive(state === 'active');
    });
    return () => sub.remove();
  }, []);

  // Real device albums for the quick-categorize chip row. Goes through the
  // shared 30s album cache, NOT MediaLibrary directly: getAlbumsAsync costs
  // seconds on a cold MediaStore cursor with a large album list, and doing
  // it here raced the first photo's decode for the native media thread.
  // Raw list — the chips have no use for the synthetic "All" row.
  useEffect(() => {
    let alive = true;
    getRawAlbums()
      .then(
        (list) => alive && setRealAlbums(list.filter((a) => a.assetCount > 0))
      )
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const handleVideoLoadError = useCallback(async (asset) => {
    if (!asset || videoFallbackTriedRef.current.has(asset.id)) return;
    videoFallbackTriedRef.current.add(asset.id);
    try {
      const info = await MediaLibrary.getAssetInfoAsync(asset.id);
      const numericId = String(asset.id).split('/')[0];
      const candidates = [
        info.localUri,
        info.uri,
        Platform.OS === 'android'
          ? `content://media/external/file/${numericId}`
          : null,
      ].filter((uri) => uri && uri !== asset.uri);
      if (candidates.length > 0 && aliveRef.current) {
        // PhotoCard is keyed by the URI below, so this replaces the failed
        // player by remounting it. Calling replace() on a live/releasing
        // expo-video player can crash natively.
        setVideoUriById((current) => ({ ...current, [asset.id]: candidates[0] }));
      }
    } catch (e) {
      // No alternate URI. Keep the poster instead of retrying forever.
    }
  }, []);

  const sessionRef = useRef(null);
  const cleanedRef = useRef({ count: 0, bytes: 0 });
  const viewedRef = useRef(new Set());
  const markStackRef = useRef([]); // mark order, for undo
  const frozenAssetRef = useRef(null);
  const extraAssetsRef = useRef({}); // marked id -> asset outside active group
  const orderRef = useRef([]); // asset ids in cleaning order
  const orderModeRef = useRef(settings.order);
  const orderPromptRef = useRef(false);
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
  // The strip offset is ABSOLUTE, not a per-card drag delta: every card sits
  // at `index * SCREEN_W + offset`, so committing a swipe is a pure change
  // of `offset` and the React re-render that follows moves nothing.
  //
  // The old shape — a relative `tx` zeroed in the same JS callback that
  // called setPi — was a race. The shared-value write reaches the UI thread
  // immediately, the re-render a frame or more later, and whichever won
  // decided which flicker you got: the outgoing photo snapping back to
  // centre (iOS) or a blank gap before the incoming one (Android).
  const offset = useSharedValue(0);
  const ty = useSharedValue(0);
  // Asset id the CURRENT gesture owns; only that card follows `ty`.
  const dragId = useSharedValue('');
  // Latched false once a pinch has opened the viewer, so the continuous
  // onUpdate stream costs exactly one JS hop per gesture.
  const zoomArmed = useSharedValue(true);
  const openZoom = useCallback(() => setShowZoom(true), []);
  const deleteProgress = useDerivedValue(() =>
    Math.min(1, Math.max(0, -ty.value / DELETE_THRESHOLD))
  );

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
      // Did this call actually pull anything? The look-ahead effect fires on
      // every group change, and the order below is up to 20 000 ids (~500 KB
      // of JSON) — rewriting it when nothing moved meant a half-megabyte
      // serialise + disk write every five photos.
      let appended = false;
      try {
        while (
          aliveRef.current &&
          cursorRef.current.hasNext &&
          allRef.current.length < Math.min(minCount, 20000)
        ) {
          // The range is pushed down to the media store, so a "clean March
          // 2023" session no longer has to page through everything newer
          // just to throw it away. The JS filter below stays as a guard for
          // boundary handling.
          const page = await getAssetsPage(
            albumId,
            mediaType,
            cursorRef.current.after,
            rangeRef.current
          );
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
          // A NEW array each page, on purpose: `lookupAsset` below memoises
          // its id index on this array's identity, and the segmented loader
          // only pulls ~3 groups ahead, so the copy is one page's worth of
          // work — the same order as the `map`/`makeGroups` right after it.
          // (The whole-library loops — resume here, and the home summary —
          // are the ones that had to stop re-copying; they push in place.)
          const next = allRef.current.slice();
          for (const a of pageAssets) next.push(a);
          allRef.current = next;
          if (pageAssets.length > 0) appended = true;
          cursorRef.current = { after: page.endCursor, hasNext: page.hasNext };
          orderRef.current = allRef.current.map((a) => a.id);
          setGroups(makeGroups(allRef.current, groupSize));
        }
        // Preset lists (Largest Files / Low Quality) must never overwrite
        // the paused album session's saved order — the home cards follow it.
        if (!assetIds && appended) {
          sessionManager.saveOrder(orderRef.current, mediaType);
        }
        // Whole album loaded (unscoped) — persist it as the local index so
        // the NEXT session opens with zero MediaStore scanning.
        if (
          fetchedPagesRef.current &&
          !listSavedRef.current &&
          !cursorRef.current.hasNext &&
          !rangeRef.current
        ) {
          listSavedRef.current = true;
          saveCachedAssetList(albumId, mediaType, allRef.current);
        }
      } finally {
        loadingMoreRef.current = false;
      }
    },
    [albumId, groupSize, settings.order, assetIds, mediaType]
  );

  // ---- Load: lazy segments for fresh sessions, full ordered for resume ----
  useEffect(() => {
    let alive = true;
    aliveRef.current = true;
    (async () => {
      try {
      const pending = await sessionManager.getPendingSession(mediaType);
      log(
        'clean.load',
        `resume=${resume} pending=${pending ? pending.type + '/' + pending.albumId + '/g' + (pending.groupIndex || 0) : 'none'} album=${albumId}`
      );
      const resuming =
        resume &&
        pending &&
        !pending.assetIds && // stale preset sessions (pre-fix) are not resumable
        pending.albumId === albumId &&
        pending.type === mediaType;
      const range = resuming ? pending.timeRange || timeRange : timeRange;
      if (!assetIds) {
        // Direct resume (including cold-start navigation) bypasses the album
        // picker, so establish the independent album/time round here too.
        reviewedStore.activateRound(mediaType, albumId, range);
      }
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
        const all = [];
        let after;
        let hasNext = true;
        while (hasNext && all.length < 20000) {
          const page = await getAssetsPage(albumId, mediaType, after, range);
          if (!alive) return;
          // push, not `all = [...all, ...]`: the spread re-copied everything
          // accumulated so far on every one of ~66 pages.
          for (const a of page.assets) if (inRange(a)) all.push(a);
          hasNext = page.hasNext;
          after = page.endCursor;
        }
        if (!range) {
          fullAlbumList = all;
          saveCachedAssetList(albumId, mediaType, all); // refresh local index
        }
        // CONFIRMED groups (recorded in reviewedStore) are dropped from the
        // order entirely — deletions in earlier groups then can't shift the
        // remaining group boundaries. The group you left mid-way is always
        // the FIRST group after resume, photo-for-photo identical.
        const savedOrder = (await sessionManager.getOrder(mediaType)) || [];
        const reviewed = await reviewedStore.getReviewed(reviewScope);
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
        sessionManager.saveOrder(orderRef.current, mediaType);
        initializedRef.current = true;
        setLoading(false);
      } else {
        // Fresh session: reviewed photos are EXCLUDED from the pool — a
        // group you confirmed (kept or deleted) never comes back until the
        // whole album has been reviewed once (then the round resets).
        reviewedSetRef.current = await reviewedStore.getReviewed(reviewScope);
        if (!alive) return;
        // Try the persisted local index first (Fossify-style) —
        // fingerprint unchanged means the FULL list loads instantly with
        // zero MediaStore scanning.
        const cachedList = await getCachedAssetList(albumId, mediaType);
        if (!alive) return;
        if (cachedList) {
          const inR = cachedList.filter(inRange);
          let pool = inR.filter((a) => !reviewedSetRef.current.has(a.id));
          if (pool.length === 0 && inR.length > 0) {
            // Round complete: every photo reviewed once — start over.
            await reviewedStore.resetAlbumRound(mediaType, albumId, inR);
            reviewedSetRef.current = await reviewedStore.getReviewed(reviewScope);
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
            const roundAssets = await getAssets(albumId, mediaType);
            await reviewedStore.resetAlbumRound(mediaType, albumId, roundAssets);
            reviewedSetRef.current = await reviewedStore.getReviewed(reviewScope);
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
        const before = await getAlbumSnapshot(albumId, mediaType, fullAlbumList);
        if (!alive) return;
        sessionRef.current = {
          type: mediaType,
          albumId,
          albumTitle,
          groupSize,
          assetIds,
          timeRange,
          before,
          ephemeral: true,
        };
      } else {
        const before = await getAlbumSnapshot(albumId, mediaType, fullAlbumList);
        if (!alive) return;
        const createdSession = await sessionManager.startSession({
          type: mediaType,
          albumId,
          albumTitle,
          groupSize,
          assetIds,
          timeRange,
          // Record the mode the queue was built for, so flipping the setting
          // from the home/settings tab can invalidate this session instead
          // of silently resuming the old order.
          order: settings.order,
          before,
        });
        if (!alive) {
          await sessionManager.discardSessionIfId(createdSession.id, mediaType);
          return;
        }
        sessionRef.current = createdSession;
        sessionManager.saveOrder(orderRef.current, mediaType);
      }

      if (!isVideo && settings.similarDetection) {
        const cache = await analyzer.getCached(albumId, 'photo');
        if (alive && cache && cache.clusters) setClusters(cache.clusters);
      }
      } catch (e) {
        log('clean.load', `failed: ${(e && e.message) || e}`);
        if (alive) {
          setLoadError(true);
          setLoading(false);
        }
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
    }, mediaType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gi, markedIds]);

  // Persist the in-group position too. The effect above only fires on group
  // or mark changes, and setPi(0) has already run by then — so browsing four
  // photos without marking any saved nothing, and resuming dropped the user
  // back on the first photo of the group.
  useEffect(() => {
    if (!sessionRef.current || sessionRef.current.ephemeral) return;
    const id = setTimeout(() => {
      sessionManager.saveProgress({ photoIndex: piRef.current }, mediaType);
    }, 600);
    return () => clearTimeout(id);
  }, [pi]);

  // ---- Derived state ----
  const group = groups[gi] || [];
  // Assets selected in the Similar modal can live OUTSIDE the current
  // group — keep their full objects so the confirm sheet can show and
  // delete them together with the group's marks.
  const deletedIdsRef = useRef(new Set()); // already deleted this session
  const visible = useMemo(
    () =>
      group.filter(
        (a) => !markedIds.has(a.id) && !deletedIdsRef.current.has(a.id)
      ),
    [group, markedIds]
  );
  // EVERYTHING queued for deletion: swipe marks + similar picks.
  //
  // Marks that resolve to neither the current group nor extraAssetsRef (a
  // resumed session's saved marks, say) need a lookup in the full list — up
  // to 20 000 assets. A linear `.find` per mark ran on every swipe; index it
  // instead, keyed on the array's IDENTITY, which is safe because every
  // writer above replaces allRef.current with a brand new array.
  const allIndexRef = useRef({ src: null, map: null });
  const lookupAsset = useCallback((id) => {
    const list = allRef.current;
    if (allIndexRef.current.src !== list) {
      allIndexRef.current = {
        src: list,
        map: new Map(list.map((a) => [a.id, a])),
      };
    }
    return allIndexRef.current.map.get(id);
  }, []);
  const markedAssets = useMemo(() => {
    const inGroup = group.filter(
      (a) => markedIds.has(a.id) && !deletedIdsRef.current.has(a.id)
    );
    const seen = new Set(inGroup.map((a) => a.id));
    const others = [];
    for (const id of markedIds) {
      if (seen.has(id) || deletedIdsRef.current.has(id)) continue;
      const a = extraAssetsRef.current[id] || lookupAsset(id);
      if (a) others.push(a);
    }
    return [...inGroup, ...others];
  }, [group, markedIds, lookupAsset]);
  const currentIdx = Math.min(pi, Math.max(0, visible.length - 1));
  const current = visible[currentIdx] || null;
  // Lets async handlers check whether the user has moved on since they
  // started — an awaited move that then advances unconditionally skips a
  // photo the user never saw.
  const currentRef = useRef(current);
  currentRef.current = current;
  // The rendered window: the current photo plus one neighbour each side.
  // Keyed by asset id in the render below, so the neighbour a swipe promotes
  // to current keeps its mounted (already decoded) image view.
  const stack = useMemo(() => {
    const out = [];
    for (let i = currentIdx - 1; i <= currentIdx + 1; i++) {
      if (i >= 0 && i < visible.length) out.push({ asset: visible[i], index: i });
    }
    return out;
  }, [visible, currentIdx]);

  // Keep the strip's resting position in sync with the committed index, and
  // clear any leftover vertical drag.
  //
  // After a swipe the worklet has already animated `offset` to exactly this
  // value, so this is a no-op — that is the whole point: the commit itself
  // must not move anything. It only bites for PROGRAMMATIC jumps (group
  // change, afterRemovalAdvance, resuming a session), where the strip has to
  // be snapped into place. Clearing `ty`/`dragId` here is safe precisely
  // because it runs AFTER React committed: an up-swiped card is already
  // unmounted, so nothing snaps back — and an undo can't resurrect a card
  // still holding the -SCREEN_H offset.
  useEffect(() => {
    const target = -currentIdx * SCREEN_W;
    if (Math.abs(offset.value - target) > 0.5) offset.value = target;
    // dragId FIRST: with no owner every card is already flat, so zeroing ty
    // afterwards can't snap a still-mounted card back into view.
    dragId.value = '';
    if (ty.value !== 0) ty.value = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx, visible.length, gi, SCREEN_W]);

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

  // Prefetch the photos just PAST the rendered window — the window itself
  // (current ± 1) is really mounted and decodes on its own.
  useEffect(() => {
    [visible[currentIdx + 2], visible[currentIdx + 3]].forEach((next) => {
      if (next && next.mediaType !== 'video') {
        ExpoImage.prefetch(next.uri).catch(() => {});
      }
    });
  }, [currentIdx, visible]);

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

  // Marking a photo ends the group the moment there is nothing left AFTER
  // it. Stepping back onto an already-reviewed photo (what this used to do
  // when earlier photos had been KEPT) made the user swipe forward through
  // the keepers again just to reach the confirmation.
  //
  // `remainingCount` is what `visible` will hold once React commits, so
  // `pi >= remainingCount` means "the removed photo was the last one".
  const afterRemovalAdvance = useCallback(
    (remainingCount) => {
      if (pi >= remainingCount) endOfGroupRef.current();
    },
    [pi]
  );

  // ---- Gesture callbacks ----
  // NONE of these touch a shared value. The worklet has already animated the
  // strip to its new resting place before handing over, so all that is left
  // is to commit the index — and a commit that moves nothing cannot flicker.
  const onSwipeNext = useCallback(() => {
    if (currentIdx < visible.length - 1) setPi(currentIdx + 1);
    else endOfGroupRef.current();
  }, [currentIdx, visible.length]);

  const onSwipePrev = useCallback(() => {
    if (currentIdx > 0) setPi(currentIdx - 1);
  }, [currentIdx]);

  const onSwipeDelete = useCallback(() => {
    if (!current) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (e) {
      // haptics unavailable
    }
    mark(current);
    afterRemovalAdvance(visible.length - 1);
  }, [current, mark, visible.length, afterRemovalAdvance]);

  const onSwipeDown = useCallback(() => {
    if (current) setShowMove(true);
  }, [current]);

  // ---- System share sheet for the photo on screen ----
  // getAssetInfoAsync first: `asset.uri` can be a ph:// or content:// handle
  // that other apps cannot open, while localUri is a real file path.
  const shareCurrent = async () => {
    const asset = displayAsset;
    if (!asset) return;
    try {
      const info = await MediaLibrary.getAssetInfoAsync(asset.id);
      const uri = info.localUri || info.uri || asset.uri;
      if (Sharing && (await Sharing.isAvailableAsync())) {
        // Android picks the target apps from the mime type; without it a
        // HEIC/HEIF shot can come back as "no app can handle this".
        await Sharing.shareAsync(uri, {
          mimeType: asset.mediaType === 'video' ? 'video/*' : 'image/*',
        });
      } else if (Platform.OS === 'ios') {
        await Share.share({ url: uri });
      } else {
        await Share.share({ message: uri });
      }
    } catch (e) {
      // user dismissed the sheet / sharing unavailable
    }
  };

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

  // Captured per render and read inside the worklets below.
  const restOffset = -currentIdx * SCREEN_W;
  const currentId = current ? current.id : '';
  const hasNext = currentIdx < visible.length - 1;
  const hasPrev = currentIdx > 0;

  const pan = Gesture.Pan()
    .enabled(!showConfirm && !showMove && !showSimilar && !showExif && !showZoom)
    .onStart(() => {
      'worklet';
      // Claim the vertical axis for THIS card only.
      ty.value = 0;
      dragId.value = currentId;
    })
    .onUpdate((e) => {
      'worklet';
      if (Math.abs(e.translationX) > Math.abs(e.translationY)) {
        offset.value = restOffset + e.translationX;
        ty.value = 0;
      } else {
        // Re-assert the owner rather than trusting onStart alone: a missed
        // claim would leave the card frozen while the trash bar filled up.
        if (dragId.value !== currentId) dragId.value = currentId;
        ty.value = e.translationY;
        offset.value = restOffset;
      }
    })
    .onEnd((e) => {
      'worklet';
      const horizontal = Math.abs(e.translationX) > Math.abs(e.translationY);
      if (horizontal) {
        const goNext = e.translationX < -SWIPE_X || e.velocityX < -800;
        const goPrev = e.translationX > SWIPE_X || e.velocityX > 800;
        if (goNext && hasNext) {
          offset.value = withTiming(
            restOffset - SCREEN_W,
            { duration: 110 },
            (finished) => {
              if (finished) runOnJS(callNext)();
            }
          );
        } else if (goPrev && hasPrev) {
          offset.value = withTiming(
            restOffset + SCREEN_W,
            { duration: 110 },
            (finished) => {
              if (finished) runOnJS(callPrev)();
            }
          );
        } else if (goNext) {
          // Last photo of the group: there is nothing to slide to, so settle
          // back and let the handler close the group out.
          offset.value = withTiming(restOffset, EASE);
          runOnJS(callNext)();
        } else {
          offset.value = withTiming(restOffset, EASE);
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

  // Pinching the card opens the full-screen zoomable viewer. It cannot zoom
  // in place: the card is one layer of a filmstrip that is itself being
  // translated, and PhotoCard may be hosting a LivePhotoView with its own
  // gesture recognizer. Pinch runs SIMULTANEOUSLY with the pan (they read
  // different inputs); the threshold keeps an incidental two-finger drag
  // from opening the viewer.
  const pinch = Gesture.Pinch()
    .enabled(!showConfirm && !showMove && !showSimilar && !showExif && !showZoom)
    .onBegin(() => {
      'worklet';
      zoomArmed.value = true;
    })
    .onUpdate((e) => {
      'worklet';
      // onUpdate fires continuously — fire the JS hop exactly once per pinch.
      if (zoomArmed.value && e.scale > 1.15) {
        zoomArmed.value = false;
        // Put the strip back where it belongs — the pan may have nudged it.
        ty.value = 0;
        offset.value = restOffset;
        runOnJS(openZoom)();
      }
    });

  const photoGesture = Gesture.Simultaneous(pan, pinch);

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

  const migrateMovedAssetId = (asset, oldId, nextId) => {
    const newId = nextId && String(nextId);
    if (!asset || !newId || newId === String(oldId)) return String(oldId);
    asset.id = newId;
    orderRef.current = orderRef.current.map((id) =>
      String(id) === String(oldId) ? newId : id
    );
    if (markStackRef.current.includes(oldId)) {
      markStackRef.current = markStackRef.current.map((id) =>
        id === oldId ? newId : id
      );
      setMarkedIds((currentIds) => {
        const next = new Set(currentIds);
        if (next.delete(oldId)) next.add(newId);
        return next;
      });
    }
    if (extraAssetsRef.current[oldId]) {
      extraAssetsRef.current[newId] = extraAssetsRef.current[oldId];
      delete extraAssetsRef.current[oldId];
    }
    replaceFavoriteId(oldId, newId);
    if (!assetIds && sessionRef.current) {
      sessionManager.saveOrder(orderRef.current, mediaType);
      sessionManager.saveProgress({ markedIds: [...markStackRef.current] }, mediaType);
    }
    return newId;
  };

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
        const movedId = migrateMovedAssetId(asset, id, res.newId);
        overrideHistoryRef.current[movedId] = {
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
      // Categorizing counts as completing this item in the current album.
      await reviewedStore.addReviewedAssets(mediaType, albumId, [current]);
      incrementUsage(album.id);
      setAlbumOverrides((m) => {
        const next = { ...m };
        delete next[id];
        next[asset.id] = album.id;
        return next;
      });
      showToast(t('moved_to', { album: album.title }));
      // Only advance if we are still on the photo we just moved — the user
      // may have swiped on during the await, and blindly calling next then
      // skipped an unseen photo.
      if (currentRef.current && currentRef.current.id === asset.id) callNext();
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
        const movedId = migrateMovedAssetId(asset, id, res.newId);
        // Forced: the album we just created is by definition not in the
        // shared 30s cache yet.
        const list = await getRawAlbums({ force: true });
        setRealAlbums(list.filter((a) => a.assetCount > 0));
        const album = list.find((a) => a.title === name);
        if (album) incrementUsage(album.id);
        await reviewedStore.addReviewedAssets(mediaType, albumId, [asset]);
        overrideHistoryRef.current[movedId] = {
          fromAlbumId,
          toAlbumId: album ? album.id : name,
          native: true,
          oldDir: res.oldDir || null,
          fromAlbumTitle:
            (realAlbums.find((a) => a.id === fromAlbumId) || {}).title || null,
        };
        setAlbumOverrides((m) => {
          const next = { ...m };
          delete next[id];
          next[movedId] = album ? album.id : name;
          return next;
        });
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
        const list = await getRawAlbums({ force: true });
        setRealAlbums(list.filter((a) => a.assetCount > 0));
      }
      await reviewedStore.addReviewedAssets(mediaType, albumId, [current]);
      showToast(t('moved_to', { album: name }));
      if (currentRef.current && currentRef.current.id === asset.id) callNext();
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
        migrateMovedAssetId(displayAsset, id, res.newId);
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
      delete overrideHistoryRef.current[displayAsset.id];
      setAlbumOverrides((m) => {
        const next = { ...m };
        delete next[id];
        if (rec.fromAlbumId) next[displayAsset.id] = rec.fromAlbumId;
        else delete next[displayAsset.id];
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

  // Stable identities for the chip row. AlbumChips is memoized and this
  // screen re-renders on every swipe — handing it three fresh closures each
  // time would defeat the memo completely. Same ref idiom as the gesture
  // handlers above: the callbacks never change, what they call does.
  const chipHandlersRef = useRef({});
  chipHandlersRef.current = {
    move: moveCurrentTo,
    create: createAlbumWithCurrent,
    cancel: cancelCurrentCategory,
  };
  const onChipSelect = useCallback(
    (album) => chipHandlersRef.current.move(album),
    []
  );
  const onChipCreate = useCallback(
    (name) => chipHandlersRef.current.create(name),
    []
  );
  const onChipCancel = useCallback(() => chipHandlersRef.current.cancel(), []);

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
      // Advance only after the decision ledger has accepted this group. On
      // the final group a fire-and-forget write raced flush/finish and the
      // same items reappeared after an immediate process kill.
      await reviewedStore.addReviewedAssets(mediaType, albumId, group);
    } else if (suggestionKey && group.length > 0) {
      // Suggestion sessions are ephemeral and album-scoped reviewing would be
      // wrong here (the ids span the whole library), so they get their own
      // per-suggestion ledger. Without it the "10 largest files" card kept
      // offering the same photos after they had been dealt with.
      await suggestionStore.addReviewed(suggestionKey, group.map((a) => a.id));
    }
    setShowConfirm(false);
    setPi(0);
    // No shared-value reset here: the strip resyncs itself once React has
    // committed the new group (see the offset effect above).

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

  // The settings tab stays mounted alongside this screen. Apply an order
  // change to the in-memory queue immediately instead of waiting until the
  // current group is confirmed. Marks are retained as extra assets, so a
  // photo selected for deletion cannot disappear merely because it moved to
  // a different group.
  useEffect(() => {
    if (orderModeRef.current === settings.order) return;
    if (
      !initializedRef.current ||
      loading ||
      showConfirm ||
      deleting ||
      allRef.current.length === 0
    ) {
      return;
    }

    if (markedIds.size > 0) {
      if (orderPromptRef.current) return;
      orderPromptRef.current = true;
      Alert.alert(
        t('discard_selection_title'),
        t('discard_selection_message'),
        [
          {
            text: t('cancel'),
            style: 'cancel',
            onPress: () => {
              orderPromptRef.current = false;
              setSetting('order', orderModeRef.current);
            },
          },
          {
            text: t('discard_selection_confirm'),
            style: 'destructive',
            onPress: () => {
              orderPromptRef.current = false;
              clearGroupMarks();
            },
          },
        ]
      );
      return;
    }

    const reordered =
      settings.order === 'random'
        ? shuffle(allRef.current)
        : [...allRef.current].sort(
            (a, b) => (b.creationTime || 0) - (a.creationTime || 0)
          );
    orderModeRef.current = settings.order;
    allRef.current = reordered;
    orderRef.current = reordered.map((asset) => asset.id);
    setGroups(makeGroups(reordered, groupSize));
    setGi(0);
    setPi(0);
    if (!assetIds && sessionRef.current) {
      sessionManager.saveOrder(orderRef.current, mediaType);
      // Keep the stored mode in step, or the home screen would drop this
      // session as stale the next time it looks at it.
      sessionManager.saveProgress({ order: settings.order }, mediaType);
    }
  }, [
    settings.order,
    loading,
    showConfirm,
    deleting,
    markedIds,
    groupSize,
    assetIds,
  ]);

  const deleteMarkedNow = async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      // Group marks AND similar-modal picks — deleted together, ONE dialog.
      const targets = markedAssets;
      if (targets.length > 0) {
        try {
          if (Platform.OS === 'ios' && PhotoMove.hasAlbumMembership()) {
            const membership = await PhotoMove.getAlbumMembership(
              targets.map((asset) => asset.id)
            );
            reviewedStore.rememberMembershipMap(mediaType, membership);
          }
          const { count, bytes, bytesById, deletedIds, skipped } = await batchDelete(
            targets,
            { useRecycleBin: recycleBinActive }
          );
          cleanedRef.current.count += count;
          cleanedRef.current.bytes += bytes;
          if (count > 0) {
            const goneSet = new Set(deletedIds || targets.map((a) => a.id));
            const deleted = targets.filter((a) => goneSet.has(a.id));
            const videos = deleted.filter((a) => a.mediaType === 'video');
            const photos = deleted.filter((a) => a.mediaType !== 'video');
            const sumBytes = (items) =>
              items.reduce((sum, item) => sum + (bytesById?.[item.id] || 0), 0);
            if (photos.length > 0) {
              recordCleaned('photo', photos.length, sumBytes(photos));
            }
            if (videos.length > 0) {
              recordCleaned('video', videos.length, sumBytes(videos));
            }
          }
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
            // The failed backups are still marked and still exist. Stay in
            // this group so they cannot be recorded as reviewed merely
            // because their neighbours were deleted successfully.
            return;
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
      await nextGroup();
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  // Backing out of the sheet (X / backdrop / Android back) is NOT a decision:
  // the marks stay and so does the group. It used to treat "everything in
  // this group is marked" as "keep all" — clearing every mark AND jumping to
  // the next group, so one stray tap threw away the whole group's work.
  // Only the explicit "keep all" button does that now.
  const closeConfirmOnly = () => {
    if (deleting) return;
    setShowConfirm(false);
    if (pi >= visible.length) setPi(Math.max(0, visible.length - 1));
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
      sessionManager.saveProgress({ photoIndex: piRef.current }, mediaType);
    }
    (async () => {
      try {
        if (viewed > 0) await recordViewed(mediaType, viewed);
        // Reviewed ids are coalesced in memory (see reviewedStore) — leaving
        // the screen is the point at which they must be on disk.
        await reviewedStore.flushReviewed();
        if (suggestionKey) await suggestionStore.flushReviewed();
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
  if (loadError) {
    return (
      <SafeAreaView
        edges={['top', 'left', 'right']}
        style={[styles.center, { backgroundColor: colors.background }]}
      >
        <Ionicons name="alert-circle-outline" size={46} color={colors.subtext} />
        <Text style={[styles.doneSub, { color: colors.subtext, marginTop: 12 }]}>
          {t('cleaning_load_failed')}
        </Text>
        <Pressable
          style={[styles.doneBtn, { backgroundColor: colors.accent }]}
          onPress={() => navigation.replace(route.name, route.params)}
        >
          <Text style={styles.doneBtnText}>{t('retry')}</Text>
        </Pressable>
      </SafeAreaView>
    );
  }
  if (loading) {
    return (
      <SafeAreaView edges={['top', 'left', 'right']} style={[styles.center, { backgroundColor: colors.background }]}>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={10}
          style={styles.loadingBack}
        >
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
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
          {t(isVideo ? 'no_videos' : 'no_photos')}
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

  const sizeLabelFor = (asset) =>
    sizesById && asset && sizesById[asset.id]
      ? formatBytes(sizesById[asset.id])
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

      {/* Filmstrip: current photo ± 1 neighbour, laid out side by side and
          moved as ONE strip. The gesture lives on the STATIC container, so
          it survives the card sliding out from under the finger. */}
      <GestureDetector gesture={photoGesture}>
        <View style={styles.photoArea}>
          {stack.map(({ asset, index }) => {
            const isCurrent = index === currentIdx;
            const overrideUri = videoUriById[asset.id];
            const cardAsset = overrideUri ? { ...asset, uri: overrideUri } : asset;
            return (
              <StackLayer
                key={asset.id}
                asset={asset}
                index={index}
                screenW={SCREEN_W}
                offset={offset}
                ty={ty}
                dragId={dragId}
              >
                <PhotoCard
                  key={`${asset.id}:${cardAsset.uri}`}
                  asset={cardAsset}
                  inactive={!isCurrent}
                  active={
                    isCurrent &&
                    appActive &&
                    !showConfirm &&
                    !showExif &&
                    !showSimilar &&
                    !showZoom &&
                    !showMove
                  }
                  onLoadError={
                    isCurrent && asset.mediaType === 'video'
                      ? () => handleVideoLoadError(cardAsset)
                      : undefined
                  }
                  isFavorite={isFavorite(asset.id)}
                  marked={markedIds.has(asset.id)}
                  sizeLabel={isCurrent ? sizeLabelFor(asset) : null}
                />
              </StackLayer>
            );
          })}
          {/* Every photo in the group is marked, so the strip is empty.
              Without this the screen was a dead end: closing the sheet left a
              blank card area with no way back to it. */}
          {stack.length === 0 && markedAssets.length > 0 && (
            <View style={styles.allMarked}>
              <Ionicons name="trash-outline" size={46} color={colors.subtext} />
              <Text style={[styles.allMarkedText, { color: colors.subtext }]}>
                {t('all_marked_hint')}
              </Text>
              <Pressable
                style={[styles.doneBtn, { backgroundColor: colors.accent }]}
                onPress={() => setShowConfirm(true)}
              >
                <Text style={styles.doneBtnText}>
                  {t('review_marked', { count: markedAssets.length })}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
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
          onSelect={onChipSelect}
          onCreate={onChipCreate}
          onCurrentPress={
            displayAsset && overrideHistoryRef.current[displayAsset.id]
              ? onChipCancel
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
        onShare={shareCurrent}
        undoCount={undoCount || 0}
        onUndo={undo}
      />

      <EXIFModal
        visible={showExif}
        asset={displayAsset}
        onClose={() => setShowExif(false)}
      />

      {/* Pinch-opened zoom. It is fed the whole VISIBLE group so the viewer's
          own swipe/chevrons page through the same photos the strip shows,
          and it starts on whichever one was under the finger. */}
      <PhotoViewer
        visible={showZoom}
        assets={visible}
        initialIndex={currentIdx}
        onClose={() => setShowZoom(false)}
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
  loadingBack: { position: 'absolute', left: 18, top: 18, zIndex: 2 },
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
  allMarked: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  allMarkedText: { fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
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
