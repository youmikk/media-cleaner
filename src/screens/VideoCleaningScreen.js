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
import GroupConfirmSheet from '../components/GroupConfirmSheet';
import MoveSheet from '../components/MoveSheet';
import { batchDelete } from '../utils/deletionManager';
import * as sessionManager from '../utils/sessionManager';
import {
  getAlbums,
  getAssets,
  getAlbumSnapshot,
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
 * Videos tab — DIRECT cleaning feed (no album-select screen).
 * The trash button MARKS a video (hidden from the feed, undoable); the
 * actual deletion happens ONCE per group via the confirmation sheet —
 * a single system dialog per batch.
 */
export default function VideoCleaningScreen({ navigation }) {
  const { colors, t, settings, recycleBinActive } = useSettings();
  const { recordCleaned, recordViewed, toggleFavorite, isFavorite } = useApp();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const groupSize = settings.groupSize || 5;

  const [albums, setAlbums] = useState([]);
  const [albumId, setAlbumId] = useState(ALL_ALBUM_ID);
  const [loading, setLoading] = useState(true);
  const [videos, setVideos] = useState([]);
  const [index, setIndex] = useState(0);
  const [markedIds, setMarkedIds] = useState(new Set());
  const [showConfirm, setShowConfirm] = useState(false);
  const [showExif, setShowExif] = useState(false);
  const [moveMarkedMode, setMoveMarkedMode] = useState(false);
  const [confirmedUpTo, setConfirmedUpTo] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [focused, setFocused] = useState(false);
  const [finalStats, setFinalStats] = useState({ count: 0, bytes: 0 });

  const listRef = useRef(null);
  const sessionRef = useRef(null);
  const cleanedRef = useRef({ count: 0, bytes: 0 });
  const viewedRef = useRef(new Set());
  const markStackRef = useRef([]);

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

  // (Re)load videos whenever the album filter changes — restarts cleaning.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setCompleted(false);
    setIndex(0);
    setConfirmedUpTo(0);
    viewedRef.current = new Set();
    markStackRef.current = [];
    (async () => {
      const assets = await getAssets(albumId, 'video');
      if (!alive) return;
      setVideos(assets);
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

  const visible = useMemo(
    () => videos.filter((v) => !markedIds.has(v.id)),
    [videos, markedIds]
  );
  const current = visible[index] || null;

  useEffect(() => {
    if (current) viewedRef.current.add(current.id);
  }, [current]);

  useEffect(() => {
    const watched = viewedRef.current.size;
    if (watched > 0 && watched >= confirmedUpTo + groupSize) {
      setShowConfirm(true);
    }
  }, [index, confirmedUpTo, groupSize]);

  useEffect(() => {
    if (sessionRef.current) {
      sessionManager.saveProgress({
        groupIndex: Math.floor(confirmedUpTo / groupSize),
      });
    }
  }, [confirmedUpTo, groupSize]);

  const currentGroupAssets = useMemo(() => {
    const ids = [...viewedRef.current].slice(confirmedUpTo, confirmedUpTo + groupSize);
    return videos.filter((v) => ids.includes(v.id));
  }, [showConfirm, videos, confirmedUpTo, groupSize]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Mark / undo (deletion is batched at group confirmation) ----
  const markCurrent = useCallback(() => {
    if (!current) return;
    markStackRef.current.push(current.id);
    setMarkedIds((s) => new Set(s).add(current.id));
    const remaining = visible.length - 1;
    if (remaining === 0) setShowConfirm(true);
    else if (index >= remaining) setIndex(remaining - 1);
  }, [current, visible.length, index]);

  const undo = useCallback(() => {
    const id = markStackRef.current.pop();
    if (!id) return;
    setMarkedIds((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }, []);

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
    const ids = new Set(currentGroupAssets.map((a) => a.id));
    setMarkedIds((s) => {
      const next = new Set(s);
      currentGroupAssets.forEach((a) => next.delete(a.id));
      return next;
    });
    markStackRef.current = markStackRef.current.filter((id) => !ids.has(id));
  };

  const closeConfirm = () => {
    clearGroupMarks(); // skip = keep everything in this group
    setShowConfirm(false);
    setConfirmedUpTo((c) => c + groupSize);
  };

  const deleteMarkedNow = async () => {
    const targets = currentGroupAssets.filter((a) => markedIds.has(a.id));
    if (targets.length > 0) {
      try {
        // SINGLE system deletion dialog for the whole group.
        const { count, bytes } = await batchDelete(targets, {
          useRecycleBin: recycleBinActive,
        });
        cleanedRef.current.count += count;
        cleanedRef.current.bytes += bytes;
        recordCleaned('video', count, bytes);
        setVideos((v) => v.filter((x) => !targets.some((a) => a.id === x.id)));
        clearGroupMarks();
      } catch (e) {
        return; // user cancelled the system dialog — keep marks
      }
    }
    setShowConfirm(false);
    setConfirmedUpTo((c) => c + groupSize);
  };

  const moveMarked = async (album) => {
    setMoveMarkedMode(false);
    const targets = currentGroupAssets.filter((a) => markedIds.has(a.id));
    try {
      await moveAssetsToAlbum(targets, album);
      setVideos((v) => v.filter((x) => !targets.some((a) => a.id === x.id)));
      clearGroupMarks();
    } catch (e) {
      // ignore
    }
    setShowConfirm(false);
    setConfirmedUpTo((c) => c + groupSize);
  };

  const finishAll = async () => {
    const viewed = viewedRef.current.size;
    if (viewed > 0) recordViewed('video', viewed);
    if (sessionRef.current) await sessionManager.finishSession(sessionRef.current);
    setFinalStats({ ...cleanedRef.current });
    setCompleted(true);
  };

  const exit = async () => {
    const viewed = viewedRef.current.size;
    if (viewed > 0) recordViewed('video', viewed);
    if (sessionRef.current) await sessionManager.finishSession(sessionRef.current);
    navigation.navigate('PhotosTab');
  };

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems.length > 0) setIndex(viewableItems[0].index ?? 0);
  }).current;

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: '#000' }]}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  if (completed || visible.length === 0) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Ionicons name="sparkles" size={54} color={colors.accent} />
        <Text style={[styles.doneTitle, { color: colors.text }]}>
          {completed ? t('completion_title') : t('no_videos')}
        </Text>
        {completed && (
          <Text style={[styles.doneStat, { color: colors.text }]}>
            {t('completion_deleted', { count: finalStats.count })} ·{' '}
            {t('completion_saved', { size: formatBytes(finalStats.bytes) })}
          </Text>
        )}
        <Pressable
          style={[styles.doneBtn, { backgroundColor: colors.accent }]}
          onPress={() => (completed ? navigation.navigate('PhotosTab') : finishAll())}
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
        data={visible}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index: i }) => (
          <VideoCard asset={item} active={focused && i === index} height={height} />
        )}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        getItemLayout={(_, i) => ({ length: height, offset: height * i, index: i })}
        windowSize={5}
        maxToRenderPerBatch={3}
      />

      <View style={[styles.topBar, { top: insets.top + 6 }]}>
        <AlbumPicker
          albums={albums}
          selected={albumId}
          onSelect={(a) => setAlbumId(a.id)}
        />
        <Text style={styles.topText} numberOfLines={1}>
          {t('videos_watched', { current: index + 1, total: visible.length })}
        </Text>
        <Pressable onPress={exit} hitSlop={10} style={styles.exitBtn}>
          <Ionicons name="close" size={22} color="#fff" />
        </Pressable>
      </View>

      <View style={[styles.actions, { bottom: insets.bottom + 170 }]}>
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
      </View>

      <BottomInfoBar
        asset={current}
        subtitle={current ? formatDuration(current.duration) : null}
        isFavorite={current ? isFavorite(current.id) : false}
        onToggleFavorite={() => current && toggleFavorite(current.id)}
        onPressDate={() => current && setShowExif(true)}
        undoCount={markStackRef.current.length}
        onUndo={undo}
      />

      <EXIFModal visible={showExif} asset={current} onClose={() => setShowExif(false)} />

      <MoveSheet
        visible={moveMarkedMode}
        excludeAlbumId={albumId}
        onClose={() => setMoveMarkedMode(false)}
        onSelect={moveMarked}
      />

      <GroupConfirmSheet
        visible={showConfirm && !moveMarkedMode}
        assets={currentGroupAssets}
        markedIds={markedIds}
        onToggleMark={toggleMark}
        onClose={() => setShowConfirm(false)}
        onSkip={closeConfirm}
        onDeleteMarked={deleteMarkedNow}
        onMoveMarked={() => setMoveMarkedMode(true)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
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
