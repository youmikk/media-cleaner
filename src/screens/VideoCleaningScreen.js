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
  Share,
  Platform,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
  runOnJS,
  Easing,
} from 'react-native-reanimated';
import { useSettings } from '../context/SettingsContext';
import { useApp } from '../context/AppContext';
import VideoCard from '../components/VideoCard';
import BottomInfoBar from '../components/BottomInfoBar';
import EXIFModal from '../components/EXIFModal';
import AlbumPicker from '../components/AlbumPicker';
import AlbumChips from '../components/AlbumChips';
import GroupConfirmSheet from '../components/GroupConfirmSheet';
import MoveSheet from '../components/MoveSheet';
import GlowingTrashBar from '../components/GlowingTrashBar';
import { incrementUsage } from '../utils/albumUsage';
import * as reviewedStore from '../utils/reviewedStore';
import * as MediaLibrary from 'expo-media-library';
import { getVideoThumbnail } from '../utils/thumbCache';
import { log, logSync } from '../utils/logger';

// expo-sharing (system share sheet for FILES) — guarded so the app still
// runs before `npx expo install expo-sharing` has been executed.
let Sharing = null;
try {
  // eslint-disable-next-line global-require
  Sharing = require('expo-sharing');
} catch (e) {
  Sharing = null;
}
import { batchDelete } from '../utils/deletionManager';
import * as sessionManager from '../utils/sessionManager';
import {
  getAlbums,
  getAssets,
  getAlbumSnapshot,
  getAlbumFingerprint,
  getCachedAssetList,
  saveCachedAssetList,
  moveAssetsToAlbum,
  formatBytes,
  ALL_ALBUM_ID,
} from '../utils/albumHelpers';

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const SWIPE_X = 70;
const MOVE_THRESHOLD = 120;
const FLICK_VELOCITY = -900;
const EASE = { duration: 200, easing: Easing.out(Easing.cubic) };

function VideoStackLayer({ asset, index, screenW, offset, ty, dragId, children }) {
  const style = useAnimatedStyle(() => {
    const x = index * screenW + offset.value;
    return {
      transform: [
        { translateX: x },
        { translateY: dragId.value === asset.id ? ty.value : 0 },
      ],
      opacity: Math.max(0.4, 1 - Math.min(1, Math.abs(x) / screenW) * 0.6),
    };
  }, [index, screenW, asset.id]);

  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      {children}
    </Animated.View>
  );
}

/**
 * Videos tab — GROUP-AT-A-TIME cleaning feed.
 * The feed only contains the CURRENT group (size from settings). When the
 * last video of the group finishes (or the user swipes past it), the
 * DELETE-confirmation sheet pops up IF anything is marked — otherwise the
 * next group loads directly. Deletion is one batch per group.
 */
export default function VideoCleaningScreen({ navigation, route }) {
  const { colors, t, settings, recycleBinActive } = useSettings();
  const { recordCleaned, recordViewed, toggleFavorite, isFavorite } = useApp();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const groupSize =
    route?.params?.groupSize || settings.videoGroupSize || settings.groupSize || 5;
  const initialAlbumId = route?.params?.albumId || ALL_ALBUM_ID;

  const [albums, setAlbums] = useState([]);
  const [totalCounts, setTotalCounts] = useState({});
  const [albumId, setAlbumId] = useState(initialAlbumId);
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [remaining, setRemaining] = useState([]); // not yet reviewed
  const [processedGroups, setProcessedGroups] = useState(0);
  const [index, setIndex] = useState(0);
  const [markedIds, setMarkedIds] = useState(new Set());
  // Categorizing ≠ deleting: moving a video keeps it in the feed; only the
  // ✓ chip follows to its new album.
  const [albumOverrides, setAlbumOverrides] = useState({});
  const [videoThumbs, setVideoThumbs] = useState({});
  const [showConfirm, setShowConfirm] = useState(false);
  const [showMove, setShowMove] = useState(false);
  const [showExif, setShowExif] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [focused, setFocused] = useState(false);
  const [finalStats, setFinalStats] = useState({ count: 0, bytes: 0 });
  const [videoProgress, setVideoProgress] = useState(0);
  const [mediaHeight, setMediaHeight] = useState(0);

  const sessionRef = useRef(null);
  const cleanedRef = useRef({ count: 0, bytes: 0 });
  const viewedRef = useRef(new Set());
  const markStackRef = useRef([]);
  const finishedRef = useRef(false);
  const offset = useSharedValue(0);
  const ty = useSharedValue(0);
  const dragId = useSharedValue('');
  const viewportHeight = mediaHeight || height;
  const deleteThreshold = viewportHeight * 0.22;

  const albumTitle = useMemo(() => {
    const a = albums.find((x) => x.id === albumId);
    return a ? a.title : t('all_videos');
  }, [albums, albumId, t]);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, [])
  );

  useEffect(() => {
    getAlbums('video', t('all_videos'))
      .then(setAlbums)
      .catch(() => {});
  }, [t]);

  useEffect(() => {
    if (albums.length === 0) return undefined;
    let alive = true;
    (async () => {
      const all = await getAlbumFingerprint(ALL_ALBUM_ID, 'video');
      if (!alive) return;
      const totals = { [ALL_ALBUM_ID]: all.assetCount || 0 };
      albums.forEach((album) => {
        if (album.id !== ALL_ALBUM_ID && album.assetCount != null) {
          totals[album.id] = album.assetCount;
        }
      });
      setTotalCounts(totals);
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [albums]);

  // (Re)load whenever the album filter changes — restarts cleaning.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setCompleted(false);
    setIndex(0);
    setProcessedGroups(0);
    setVideoProgress(0);
    viewedRef.current = new Set();
    markStackRef.current = [];
    finishedRef.current = false;
    (async () => {
      // CRASH-BISECT MARKERS: each step is written to DISK before running,
      // so a native crash's last log line identifies the killing step.
      await logSync('video', 'step1:load-list');
      // Local index first: unchanged album = instant open, no scanning.
      let assets = await getCachedAssetList(albumId, 'video');
      if (!alive) return;
      if (!assets) {
        assets = await getAssets(albumId, 'video');
        if (!alive) return;
        saveCachedAssetList(albumId, 'video', assets);
      }
      if (!alive) return;
      await logSync('video', `step2:list-ok n=${assets.length}`);
      setTotalCount(assets.length);
      setRemaining(assets);
      setMarkedIds(new Set());
      await logSync('video', 'step3:render-feed'); // players mount after this
      setLoading(false);

      await logSync('video', 'step4:snapshot'); // native getSizes inside
      const before = await getAlbumSnapshot(albumId, 'video', assets);
      if (!alive) return;
      await logSync('video', 'step5:snapshot-ok');
      const pending = await sessionManager.getPendingSession('video');
      // Every await above is a chance for the user to switch albums. Without
      // these guards the losing run still wrote sessionRef and clobbered
      // @mediacleaner/active_session_video — the previous album's paused
      // progress and "before" snapshot vanished without ever being finished,
      // and sessionRef could end up describing a different album than the
      // one on screen.
      if (!alive) return;
      if (pending && pending.albumId === albumId && pending.type === 'video') {
        sessionRef.current = pending;
      } else {
        // Hand over cleanly: close out the previous album's session (which
        // records its stats) before startSession overwrites the slot.
        if (pending && pending.albumId !== albumId) {
          await sessionManager.finishSession(pending).catch(() => {});
          if (!alive) return;
        }
        const started = await sessionManager.startSession({
          type: 'video',
          albumId,
          albumTitle,
          groupSize,
          before,
        });
        if (!alive) return;
        sessionRef.current = started;
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumId]);

  // ---- Group-at-a-time model ----
  const currentGroup = useMemo(
    () => remaining.slice(0, groupSize),
    [remaining, groupSize]
  );
  const visibleGroup = useMemo(
    () => currentGroup.filter((v) => !markedIds.has(v.id)),
    [currentGroup, markedIds]
  );
  const current = visibleGroup[Math.min(index, Math.max(0, visibleGroup.length - 1))] || null;
  const currentIndex = Math.min(index, Math.max(0, visibleGroup.length - 1));
  const stack = useMemo(() => {
    const out = [];
    for (let i = currentIndex - 1; i <= currentIndex + 1; i++) {
      if (i >= 0 && i < visibleGroup.length) {
        out.push({ asset: visibleGroup[i], index: i });
      }
    }
    return out;
  }, [visibleGroup, currentIndex]);
  const restOffset = -currentIndex * width;
  const deleteProgress = useDerivedValue(() =>
    Math.min(1, Math.max(0, -ty.value / Math.max(1, deleteThreshold)))
  );

  useEffect(() => {
    const target = -currentIndex * width;
    if (Math.abs(offset.value - target) > 0.5) offset.value = target;
    dragId.value = '';
    if (ty.value !== 0) ty.value = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, visibleGroup.length, width]);

  useEffect(() => {
    if (current) {
      viewedRef.current.add(current.id);
      // Crash forensics: if the app dies during playback, the last logged
      // id identifies the toxic video.
      log('video', `active id=${current.id}`);
    }
    setVideoProgress(0);
  }, [current]);

  // Neighbour posters keep the stack responsive without mounting extra
  // video players. The same cache is reused by the confirmation sheet.
  useEffect(() => {
    let alive = true;
    const targets = stack
      .map(({ asset }) => asset)
      .filter((asset) => asset && !videoThumbs[asset.id]);
    (async () => {
      for (const asset of targets) {
        try {
          const uri = await getVideoThumbnail(asset);
          if (!alive) return;
          setVideoThumbs((currentThumbs) => ({
            ...currentThumbs,
            [asset.id]: uri,
          }));
        } catch (e) {
          // A poster is optional; the player still has its own fallback.
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [stack, videoThumbs]);

  // Load-failure fallback WITHOUT touching live players: remount the card
  // with the MediaStore content:// uri; if that fails too, an unplayable
  // placeholder is shown instead of a player.
  const [altUris, setAltUris] = useState({}); // id -> alternate uri | null(dead)
  const handleLoadError = useCallback(async (item) => {
    log('video', `loadError id=${item.id}`);
    let alt = null;
    try {
      const info = await MediaLibrary.getAssetInfoAsync(item.id);
      alt = info.localUri || info.uri || null;
    } catch (e) {
      // Fall through to the deterministic MediaStore URI below.
    }
    if (!alt || alt === item.uri) {
      const rawId = String(item.id).split('/')[0];
      alt =
        Platform.OS === 'android' && /^\d+$/.test(rawId)
          ? `content://media/external/video/media/${rawId}`
          : null;
    }
    setAltUris((m) => {
      if (m[item.id] !== undefined) return { ...m, [item.id]: null };
      return { ...m, [item.id]: alt };
    });
  }, []);

  useEffect(() => {
    if (sessionRef.current) {
      sessionManager.saveProgress({ groupIndex: processedGroups }, 'video');
    }
  }, [processedGroups]);

  const watchedInGroup = currentGroup.filter((v) =>
    viewedRef.current.has(v.id)
  ).length;

  // ---- Mark / undo ----
  const markCurrent = useCallback(() => {
    if (!current) return;
    markStackRef.current.push(current.id);
    setMarkedIds((s) => new Set(s).add(current.id));
    const remainingVisible = visibleGroup.length - 1;
    if (remainingVisible === 0) setShowConfirm(true);
    else if (currentIndex >= remainingVisible) {
      setIndex(Math.max(0, remainingVisible - 1));
    }
  }, [current, visibleGroup.length, currentIndex]);

  const undo = useCallback(() => {
    const id = markStackRef.current.pop();
    if (!id) return;
    setMarkedIds((currentMarks) => {
      const next = new Set(currentMarks);
      next.delete(id);
      return next;
    });
  }, []);

  const endGroupRef = useRef(() => {});

  const onSwipeNext = useCallback(() => {
    if (currentIndex < visibleGroup.length - 1) {
      setIndex(currentIndex + 1);
    } else {
      endGroupRef.current();
    }
  }, [currentIndex, visibleGroup.length]);

  const onSwipePrev = useCallback(() => {
    if (currentIndex > 0) setIndex(currentIndex - 1);
  }, [currentIndex]);

  const onSwipeDelete = useCallback(() => {
    if (current) markCurrent();
  }, [current, markCurrent]);

  const onSwipeDown = useCallback(() => {
    if (current) setShowMove(true);
  }, [current]);

  const gestureHandlersRef = useRef({});
  gestureHandlersRef.current = {
    next: onSwipeNext,
    prev: onSwipePrev,
    del: onSwipeDelete,
    down: onSwipeDown,
  };
  const callNext = useCallback(() => gestureHandlersRef.current.next(), []);
  const callPrev = useCallback(() => gestureHandlersRef.current.prev(), []);
  const callDelete = useCallback(() => gestureHandlersRef.current.del(), []);
  const callDown = useCallback(() => gestureHandlersRef.current.down(), []);
  const currentId = current ? current.id : '';

  const pan = Gesture.Pan()
    .enabled(!showConfirm && !showMove && !!current)
    .onStart(() => {
      'worklet';
      ty.value = 0;
      dragId.value = currentId;
    })
    .onUpdate((event) => {
      'worklet';
      if (Math.abs(event.translationX) > Math.abs(event.translationY)) {
        offset.value = restOffset + event.translationX;
        ty.value = 0;
      } else {
        dragId.value = currentId;
        ty.value = event.translationY;
        offset.value = restOffset;
      }
    })
    .onEnd((event) => {
      'worklet';
      const horizontal = Math.abs(event.translationX) > Math.abs(event.translationY);
      if (horizontal) {
        const goNext = event.translationX < -SWIPE_X || event.velocityX < -800;
        const goPrev = event.translationX > SWIPE_X || event.velocityX > 800;
        if (goNext && currentIndex < visibleGroup.length - 1) {
          offset.value = withTiming(restOffset - width, { duration: 110 }, (finished) => {
            if (finished) runOnJS(callNext)();
          });
        } else if (goPrev && currentIndex > 0) {
          offset.value = withTiming(restOffset + width, { duration: 110 }, (finished) => {
            if (finished) runOnJS(callPrev)();
          });
        } else if (goNext) {
          offset.value = withTiming(restOffset, EASE);
          runOnJS(callNext)();
        } else {
          offset.value = withTiming(restOffset, EASE);
        }
      } else if (
        event.translationY < -deleteThreshold ||
        (event.translationY < -60 && event.velocityY < FLICK_VELOCITY)
      ) {
        ty.value = withTiming(-viewportHeight, { duration: 140 }, (finished) => {
          if (finished) runOnJS(callDelete)();
        });
      } else if (event.translationY > MOVE_THRESHOLD) {
        ty.value = withTiming(0, EASE);
        runOnJS(callDown)();
      } else {
        ty.value = withTiming(0, EASE);
      }
    });

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

  // ---- Group advance (ONLY after the user confirms) ----
  const advanceGroup = useCallback(() => {
    setShowConfirm(false);
    const groupIds = new Set(currentGroup.map((v) => v.id));
    markStackRef.current = markStackRef.current.filter((id) => !groupIds.has(id));
    setMarkedIds((prev) => new Set([...prev].filter((id) => !groupIds.has(id))));
    setRemaining((r) => r.filter((v) => !groupIds.has(v.id)));
    setProcessedGroups((g) => g + 1);
    setIndex(0);
    setVideoProgress(0);
  }, [currentGroup]);

  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false); // ignore extra taps while the system dialog is up
  const deleteMarkedNow = async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      const targets = currentGroup.filter((a) => markedIds.has(a.id));
      if (targets.length > 0) {
        try {
          // SINGLE system deletion dialog for the whole group.
          const { count, bytes, skipped } = await batchDelete(targets, {
            useRecycleBin: recycleBinActive,
          });
          cleanedRef.current.count += count;
          cleanedRef.current.bytes += bytes;
          if (count > 0) recordCleaned('video', count, bytes);
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
          return; // user cancelled the system dialog — keep marks
        }
      }
      advanceGroup();
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  // End of group: confirm sheet ONLY if something is marked for deletion;
  // otherwise advance straight to the next group. A per-group latch stops
  // repeated overscroll events from advancing several groups at once.
  const groupEndFiredRef = useRef(false);
  useEffect(() => {
    groupEndFiredRef.current = false;
  }, [currentGroup]);

  const endGroup = useCallback(() => {
    if (groupEndFiredRef.current || showConfirm) return;
    groupEndFiredRef.current = true;
    const stack = new Set(markStackRef.current);
    if (currentGroup.some((v) => stack.has(v.id))) setShowConfirm(true);
    else advanceGroup();
  }, [currentGroup, advanceGroup, showConfirm]);
  endGroupRef.current = endGroup;

  const closeConfirm = () => {
    if (visibleGroup.length === 0) {
      // Every video in the group is marked and the user backed out —
      // advance (advanceGroup clears the group's marks; nothing is deleted).
      advanceGroup();
      return;
    }
    setShowConfirm(false);
    groupEndFiredRef.current = false; // allow re-triggering after a back-out
  };

  // Thumbnails for the confirm sheet (expo-image can't render video URIs).
  useEffect(() => {
    if (!showConfirm) return undefined;
    let alive = true;
    (async () => {
      const targets = currentGroup.filter(
        (v) => markedIds.has(v.id) && !videoThumbs[v.id]
      );
      for (const v of targets) {
        try {
          const uri = await getVideoThumbnail(v); // persistent cache
          if (!alive) return;
          setVideoThumbs((m) => ({ ...m, [v.id]: uri }));
        } catch (e) {
          // thumbnail failed — sheet shows a blank cell, still tappable
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showConfirm]);

  // ---- Quick-categorize chips (move CURRENT video) ----
  const realAlbums = useMemo(
    () => albums.filter((a) => a.id !== ALL_ALBUM_ID && a.assetCount > 0),
    [albums]
  );
  // The current video's album for the ✓ chip: a manual move wins, then the
  // asset's own albumId (Android), then the cleaning scope's album.
  const currentAssetAlbumId =
    (current && (albumOverrides[current.id] || current.albumId)) ||
    (albumId !== ALL_ALBUM_ID ? albumId : null);

  // Categorizing ≠ deleting: the video STAYS in the feed; only the ✓ chip
  // switches to the new album.
  const moveCurrentTo = async (album) => {
    if (!current) return;
    const id = current.id;
    try {
      await moveAssetsToAlbum([current], album);
      await reviewedStore.addReviewed(albumId, [id]);
      incrementUsage(album.id);
      setAlbumOverrides((m) => ({ ...m, [id]: album.id }));
    } catch (e) {
      // move failed — nothing changes
    }
  };

  const createAlbumWithCurrent = async (name) => {
    if (!current || !name) return;
    const id = current.id;
    try {
      const album = await MediaLibrary.createAlbumAsync(name, current, false);
      if (album) {
        await reviewedStore.addReviewed(albumId, [id]);
        incrementUsage(album.id);
        setAlbumOverrides((m) => ({ ...m, [id]: album.id }));
      }
      const list = await getAlbums('video', t('all_videos'));
      setAlbums(list);
    } catch (e) {
      // creation failed — video stays
    }
  };

  // ---- System share sheet for the current video ----
  const shareCurrent = async () => {
    if (!current) return;
    try {
      const info = await MediaLibrary.getAssetInfoAsync(current.id);
      const uri = info.localUri || info.uri || current.uri;
      if (Sharing && (await Sharing.isAvailableAsync())) {
        await Sharing.shareAsync(uri);
      } else if (Platform.OS === 'ios') {
        await Share.share({ url: uri });
      } else {
        await Share.share({ message: uri });
      }
    } catch (e) {
      // user dismissed the sheet / sharing unavailable
    }
  };

  // ---- Completion / exit ----
  const settleSession = () => {
    const viewed = viewedRef.current.size;
    const session = sessionRef.current;
    sessionRef.current = null;
    (async () => {
      try {
        if (viewed > 0) await recordViewed('video', viewed);
        // Reviewed ids are coalesced in memory (see reviewedStore).
        await reviewedStore.flushReviewed();
        if (session) await sessionManager.finishSession(session);
      } catch (e) {
        // stats are best-effort
      }
    })();
  };

  const finishAll = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setFinalStats({ ...cleanedRef.current });
    setCompleted(true);
    settleSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // All groups processed -> completion.
  useEffect(() => {
    if (!loading && totalCount > 0 && remaining.length === 0) finishAll();
  }, [loading, totalCount, remaining.length, finishAll]);

  const exit = () => {
    navigation.goBack();
    settleSession();
  };

  // The last video finishing its playback ends the group too.
  const onActiveEnded = useCallback(() => {
    if (currentIndex === visibleGroup.length - 1 && !showConfirm) endGroup();
  }, [currentIndex, visibleGroup.length, showConfirm, endGroup]);

  const isEmpty = !loading && !completed && totalCount === 0;

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: '#000' }]}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  if (isEmpty) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Ionicons name="videocam-off-outline" size={48} color={colors.subtext} />
        <Text style={[styles.emptyText, { color: colors.subtext }]}>
          {t('no_videos')}
        </Text>
      </View>
    );
  }

  if (completed) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Ionicons name="sparkles" size={54} color={colors.accent} />
        <Text style={[styles.doneTitle, { color: colors.text }]}>
          {t('completion_title')}
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
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <GlowingTrashBar progress={deleteProgress} />

      <GestureDetector gesture={pan}>
        <View
          style={styles.mediaArea}
          onLayout={(event) => setMediaHeight(event.nativeEvent.layout.height)}
        >
          {stack.map(({ asset, index: stackIndex }) => {
            const isCurrent = stackIndex === currentIndex;
            const alt = altUris[asset.id];
            return (
              <VideoStackLayer
                key={asset.id}
                asset={asset}
                index={stackIndex}
                screenW={width}
                offset={offset}
                ty={ty}
                dragId={dragId}
              >
                {isCurrent && focused && alt !== null ? (
                  <VideoCard
                    key={`${asset.id}${alt ? ':alt' : ''}`}
                    asset={alt ? { ...asset, uri: alt } : asset}
                    active={!showConfirm}
                    height={viewportHeight}
                    onProgress={setVideoProgress}
                    onEnded={onActiveEnded}
                    onLoadError={() => handleLoadError(asset)}
                  />
                ) : alt === null ? (
                  <View style={[styles.center, styles.videoCanvas]}>
                    <Ionicons
                      name="videocam-off-outline"
                      size={44}
                      color="rgba(255,255,255,0.5)"
                    />
                  </View>
                ) : (
                  <View style={styles.videoCanvas}>
                    <ExpoImage
                      source={{ uri: videoThumbs[asset.id] || asset.uri }}
                      style={StyleSheet.absoluteFill}
                      contentFit="contain"
                      transition={0}
                      cachePolicy="memory-disk"
                    />
                    <View style={styles.posterShade} />
                    <Ionicons
                      name="play-circle-outline"
                      size={48}
                      color="rgba(255,255,255,0.78)"
                      style={styles.posterIcon}
                    />
                  </View>
                )}
              </VideoStackLayer>
            );
          })}
        </View>
      </GestureDetector>

      {/* Top bar: album filter · group progress (x / group size) · exit */}
      <View style={[styles.topBar, { top: insets.top + 6 }]}>
        <AlbumPicker
          albums={albums}
          selected={albumId}
          totalCounts={totalCounts}
          onSelect={(a) => setAlbumId(a.id)}
        />
        <Text style={styles.topText} numberOfLines={1}>
          {t('group_of', {
            current: processedGroups + 1,
            total: Math.max(1, processedGroups + Math.ceil(remaining.length / groupSize)),
          })}{' '}
          · {Math.min(watchedInGroup, currentGroup.length)}/{currentGroup.length}
        </Text>
        <Pressable onPress={exit} hitSlop={10} style={styles.exitBtn}>
          <Ionicons name="close" size={22} color="#fff" />
        </Pressable>
      </View>

      <View
        style={[styles.overallProgressWrap, { top: insets.top + 62 }]}
        pointerEvents="none"
      >
        <View style={styles.overallProgressHeader}>
          <Text style={styles.progressLabel}>
            {t('video_progress', {
              done: Math.min(
                totalCount,
                processedGroups * groupSize + currentGroup.length - visibleGroup.length
              ),
              total: totalCount,
            })}
          </Text>
          <Text style={styles.progressLabel}>
            {currentGroup.length > 0
              ? `${Math.min(currentIndex + 1, currentGroup.length)}/${currentGroup.length}`
              : '0/0'}
          </Text>
        </View>
        <View style={styles.overallTrack}>
          <View
            style={[
              styles.overallFill,
              {
                width: `${Math.round(
                  totalCount > 0
                    ? Math.min(
                        100,
                        ((processedGroups * groupSize +
                          currentGroup.length -
                          visibleGroup.length) /
                          totalCount) *
                          100
                      )
                    : 0
                )}%`,
                backgroundColor: colors.accent,
              },
            ]}
          />
        </View>
      </View>

      {/* Right floating actions (lifted above the tab bar) */}
      <View style={[styles.actions, { bottom: insets.bottom + 205 }]}>
        <Pressable
          onPress={() => current && toggleFavorite(current.id)}
          style={styles.actionBtn}
        >
          <Ionicons
            name={current && isFavorite(current.id) ? 'heart' : 'heart-outline'}
            size={30}
            color={current && isFavorite(current.id) ? colors.heart : '#fff'}
          />
        </Pressable>
        <Pressable onPress={markCurrent} style={styles.actionBtn}>
          <Ionicons name="trash-outline" size={28} color="#fff" />
        </Pressable>
        <Pressable onPress={shareCurrent} style={styles.actionBtn}>
          <Ionicons name="share-outline" size={26} color="#fff" />
        </Pressable>
        <Pressable
          onPress={undo}
          disabled={markStackRef.current.length === 0}
          style={[styles.actionBtn, { opacity: markStackRef.current.length ? 1 : 0.35 }]}
        >
          <Ionicons name="arrow-undo" size={26} color="#fff" />
        </Pressable>
      </View>

      {/* Quick-categorize chips: [+] [✓current] [others by usage] */}
      <View
        style={[styles.chipsWrap, { bottom: Math.max(insets.bottom, 12) + 152 }]}
        pointerEvents="box-none"
      >
        <AlbumChips
          albums={realAlbums}
          currentAlbumId={currentAssetAlbumId}
          onSelect={moveCurrentTo}
          onCreate={createAlbumWithCurrent}
          dark
        />
      </View>

      {/* Playback progress bar (just above the floating time) */}
      <View
        style={[
          styles.progressTrack,
          { bottom: Math.max(insets.bottom, 12) + 138 },
        ]}
        pointerEvents="none"
      >
        <View
          style={[
            styles.progressFill,
            { width: `${Math.round(videoProgress * 100)}%`, backgroundColor: colors.accent },
          ]}
        />
      </View>

      {/* Floating date + duration (no bar), lifted above the tab bar */}
      <BottomInfoBar
        asset={current}
        subtitle={current ? formatDuration(current.duration) : null}
        onPressDate={() => current && setShowExif(true)}
        floating
        bottomOffset={80}
      />

      <EXIFModal visible={showExif} asset={current} onClose={() => setShowExif(false)} />

      <MoveSheet
        visible={showMove}
        excludeAlbumId={albumId}
        onClose={() => setShowMove(false)}
        onSelect={async (album) => {
          setShowMove(false);
          await moveCurrentTo(album);
        }}
      />

      <GroupConfirmSheet
        visible={showConfirm}
        assets={currentGroup.filter((v) => markedIds.has(v.id))}
        onUnmark={unmark}
        onRemark={remark}
        onClose={closeConfirm}
        onKeepAll={advanceGroup}
        onDelete={deleteMarkedNow}
        thumbs={videoThumbs}
        busy={deleting}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { fontSize: 15, marginTop: 12, fontWeight: '600' },
  topBar: {
    position: 'absolute',
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    zIndex: 10,
  },
  topText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  exitBtn: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 18,
    padding: 8,
  },
  mediaArea: { flex: 1, overflow: 'hidden', backgroundColor: '#000' },
  videoCanvas: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  posterShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.14)',
  },
  posterIcon: { position: 'absolute' },
  overallProgressWrap: {
    position: 'absolute',
    left: 18,
    right: 18,
    zIndex: 10,
  },
  overallProgressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 5,
  },
  progressLabel: {
    color: 'rgba(255,255,255,0.86)',
    fontSize: 11,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 3,
  },
  overallTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  overallFill: { height: 4, borderRadius: 2 },
  actions: { position: 'absolute', right: 14, gap: 18, alignItems: 'center' },
  actionBtn: {
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 26,
    padding: 12,
  },
  chipsWrap: { position: 'absolute', left: 0, right: 0 },
  progressTrack: {
    position: 'absolute',
    left: 20,
    right: 20,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
  },
  progressFill: { height: 3, borderRadius: 2 },
  doneTitle: { fontSize: 24, fontWeight: '800', marginTop: 16 },
  doneStat: { fontSize: 15, fontWeight: '600', marginTop: 14 },
  doneBtn: {
    marginTop: 24,
    borderRadius: 14,
    paddingHorizontal: 36,
    paddingVertical: 13,
  },
  doneBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
