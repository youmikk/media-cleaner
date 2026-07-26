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
  FlatList,
  StyleSheet,
  ActivityIndicator,
  useWindowDimensions,
  Share,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import { useApp } from '../context/AppContext';
import VideoCard from '../components/VideoCard';
import BottomInfoBar from '../components/BottomInfoBar';
import EXIFModal from '../components/EXIFModal';
import AlbumPicker from '../components/AlbumPicker';
import AlbumChips from '../components/AlbumChips';
import GroupConfirmSheet from '../components/GroupConfirmSheet';
import { incrementUsage } from '../utils/albumUsage';
import * as MediaLibrary from 'expo-media-library';
import { getVideoThumbnail } from '../utils/thumbCache';

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

/**
 * Videos tab — GROUP-AT-A-TIME cleaning feed.
 * The feed only contains the CURRENT group (size from settings). When the
 * last video of the group finishes (or the user swipes past it), the
 * DELETE-confirmation sheet pops up IF anything is marked — otherwise the
 * next group loads directly. Deletion is one batch per group.
 */
export default function VideoCleaningScreen({ navigation }) {
  const { colors, t, settings, recycleBinActive } = useSettings();
  const { recordCleaned, recordViewed, toggleFavorite, isFavorite } = useApp();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const groupSize = settings.videoGroupSize || settings.groupSize || 5;

  const [albums, setAlbums] = useState([]);
  const [albumId, setAlbumId] = useState(ALL_ALBUM_ID);
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
  const [showExif, setShowExif] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [focused, setFocused] = useState(false);
  const [finalStats, setFinalStats] = useState({ count: 0, bytes: 0 });
  const [videoProgress, setVideoProgress] = useState(0);

  const listRef = useRef(null);
  const sessionRef = useRef(null);
  const cleanedRef = useRef({ count: 0, bytes: 0 });
  const viewedRef = useRef(new Set());
  const markStackRef = useRef([]);
  const finishedRef = useRef(false);

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
      // Local index first: unchanged album = instant open, no scanning.
      let assets = await getCachedAssetList(albumId, 'video');
      if (!assets) {
        assets = await getAssets(albumId, 'video');
        saveCachedAssetList(albumId, 'video', assets);
      }
      if (!alive) return;
      setTotalCount(assets.length);
      setRemaining(assets);
      setMarkedIds(new Set());
      setLoading(false);

      const before = await getAlbumSnapshot(albumId, 'video', assets);
      const pending = await sessionManager.getPendingSession();
      if (pending && pending.albumId === albumId && pending.type === 'video') {
        sessionRef.current = pending;
      } else {
        sessionRef.current = await sessionManager.startSession({
          type: 'video',
          albumId,
          albumTitle,
          groupSize,
          before,
        });
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

  useEffect(() => {
    if (current) viewedRef.current.add(current.id);
    setVideoProgress(0);
  }, [current]);

  useEffect(() => {
    if (sessionRef.current) {
      sessionManager.saveProgress({ groupIndex: processedGroups });
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
    else if (index >= remainingVisible) setIndex(remainingVisible - 1);
  }, [current, visibleGroup.length, index]);

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
    if (listRef.current) listRef.current.scrollToOffset({ offset: 0, animated: false });
  }, [currentGroup]);

  const deletingRef = useRef(false); // ignore extra taps while the system dialog is up
  const deleteMarkedNow = async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    try {
      const targets = currentGroup.filter((a) => markedIds.has(a.id));
      if (targets.length > 0) {
        try {
          // SINGLE system deletion dialog for the whole group.
          const { count, bytes } = await batchDelete(targets, {
            useRecycleBin: recycleBinActive,
          });
          cleanedRef.current.count += count;
          cleanedRef.current.bytes += bytes;
          recordCleaned('video', count, bytes);
        } catch (e) {
          return; // user cancelled the system dialog — keep marks
        }
      }
      advanceGroup();
    } finally {
      deletingRef.current = false;
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
    navigation.navigate('PhotosTab'); // leave IMMEDIATELY
    settleSession();
  };

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems.length > 0) setIndex(viewableItems[0].index ?? 0);
  }).current;

  // Swiping PAST the last video of the group ends the group (confirm sheet
  // only if something is marked).
  const onScroll = (e) => {
    const y = e.nativeEvent.contentOffset.y;
    if (
      visibleGroup.length > 0 &&
      y > (visibleGroup.length - 1) * height + 40 &&
      !showConfirm
    ) {
      endGroup();
    }
  };

  // The last video finishing its playback ends the group too.
  const onActiveEnded = useCallback(() => {
    if (index === visibleGroup.length - 1 && !showConfirm) endGroup();
  }, [index, visibleGroup.length, showConfirm, endGroup]);

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
          onPress={() => navigation.navigate('PhotosTab')}
        >
          <Text style={styles.doneBtnText}>{t('done')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <FlatList
        ref={listRef}
        data={visibleGroup}
        keyExtractor={(item) => item.id}
        extraData={[index, focused, showConfirm]}
        renderItem={({ item, index: i }) => {
          // Android decoders are scarce and player init is expensive:
          // only the CURRENT video ±1 gets a real player. Everything else
          // (and the whole feed when the tab is blurred) is a black
          // placeholder — leaving the tab RELEASES every player, so the
          // photos tab stays smooth.
          const near = focused && Math.abs(i - index) <= 1;
          if (!near) {
            return <View style={{ height, backgroundColor: '#000' }} />;
          }
          return (
            <VideoCard
              asset={item}
              active={i === index && !showConfirm}
              height={height}
              onProgress={i === index ? setVideoProgress : undefined}
              onEnded={i === index ? onActiveEnded : undefined}
            />
          );
        }}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        getItemLayout={(_, i) => ({ length: height, offset: height * i, index: i })}
        onScroll={onScroll}
        scrollEventThrottle={64}
        windowSize={3}
        initialNumToRender={1}
        maxToRenderPerBatch={2}
        removeClippedSubviews
      />

      {/* Top bar: album filter · group progress (x / group size) · exit */}
      <View style={[styles.topBar, { top: insets.top + 6 }]}>
        <AlbumPicker
          albums={albums}
          selected={albumId}
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

      <GroupConfirmSheet
        visible={showConfirm}
        assets={currentGroup.filter((v) => markedIds.has(v.id))}
        onUnmark={unmark}
        onRemark={remark}
        onClose={closeConfirm}
        onKeepAll={advanceGroup}
        onDelete={deleteMarkedNow}
        thumbs={videoThumbs}
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
