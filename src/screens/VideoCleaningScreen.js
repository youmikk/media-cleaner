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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import { useApp } from '../context/AppContext';
import VideoCard from '../components/VideoCard';
import UndoButton from '../components/UndoButton';
import GroupConfirmSheet from '../components/GroupConfirmSheet';
import MoveSheet from '../components/MoveSheet';
import { SoftDeleteManager } from '../utils/deletionManager';
import * as sessionManager from '../utils/sessionManager';
import {
  getAssets,
  getAlbumSnapshot,
  moveAssetsToAlbum,
  formatBytes,
} from '../utils/albumHelpers';

/**
 * Vertical full-screen video cleaning feed.
 * Swipe up/down switches videos; floating Delete & Like buttons on the right.
 */
export default function VideoCleaningScreen({ route, navigation }) {
  const { albumId, albumTitle, groupSize, resumeGroupIndex = 0 } = route.params;
  const { colors, t, recycleBinActive } = useSettings();
  const { recordCleaned, recordViewed, toggleFavorite, isFavorite } = useApp();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [videos, setVideos] = useState([]);
  const [index, setIndex] = useState(0);
  const [undoCount, setUndoCount] = useState(0);
  const [softDeletedIds, setSoftDeletedIds] = useState(new Set());
  const [showConfirm, setShowConfirm] = useState(false);
  const [moveMarkedMode, setMoveMarkedMode] = useState(false);
  const [confirmedUpTo, setConfirmedUpTo] = useState(
    resumeGroupIndex * groupSize
  );
  const [completed, setCompleted] = useState(false);
  const [finalStats, setFinalStats] = useState({ count: 0, bytes: 0 });

  const listRef = useRef(null);
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
        recordCleaned('video', 1, bytes);
      },
      onChange: setUndoCount,
    });
  }
  managerRef.current.setOptions({ useRecycleBin: recycleBinActive });

  useEffect(() => {
    let alive = true;
    (async () => {
      const assets = await getAssets(albumId, 'video');
      if (!alive) return;
      setVideos(assets);
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
  }, []);

  const visible = useMemo(
    () => videos.filter((v) => !softDeletedIds.has(v.id)),
    [videos, softDeletedIds]
  );
  const current = visible[index] || null;

  useEffect(() => {
    if (current) viewedRef.current.add(current.id);
  }, [current]);

  // Group confirmation every `groupSize` viewed videos.
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

  const softDelete = useCallback(() => {
    if (!current) return;
    managerRef.current.softDelete(current);
    setSoftDeletedIds((s) => new Set(s).add(current.id));
    // Auto-advance: the list shrinks, so the same index shows the next video
    // and auto-plays it. Clamp at the end.
    const remaining = visible.length - 1;
    if (remaining === 0) finishAll();
    else if (index >= remaining) setIndex(remaining - 1);
  }, [current, visible.length, index]); // eslint-disable-line react-hooks/exhaustive-deps

  const undo = useCallback(() => {
    const asset = managerRef.current.undoLast();
    if (!asset) return;
    setSoftDeletedIds((s) => {
      const next = new Set(s);
      next.delete(asset.id);
      return next;
    });
  }, []);

  const toggleMark = (id) => {
    setSoftDeletedIds((s) => {
      const next = new Set(s);
      if (next.has(id)) {
        next.delete(id);
        managerRef.current.undoById(id);
      } else {
        next.add(id);
        const asset = videos.find((v) => v.id === id);
        if (asset) managerRef.current.softDelete(asset);
      }
      return next;
    });
  };

  const closeConfirm = () => {
    setShowConfirm(false);
    setConfirmedUpTo((c) => c + groupSize);
  };

  const deleteMarkedNow = async () => {
    for (const asset of currentGroupAssets) {
      if (softDeletedIds.has(asset.id)) {
        await managerRef.current.finalizeById(asset.id);
      }
    }
    closeConfirm();
  };

  const moveMarked = async (album) => {
    setMoveMarkedMode(false);
    const targets = currentGroupAssets.filter((a) => softDeletedIds.has(a.id));
    targets.forEach((a) => managerRef.current.undoById(a.id));
    try {
      await moveAssetsToAlbum(targets, album);
      setVideos((v) => v.filter((x) => !targets.some((a) => a.id === x.id)));
      setSoftDeletedIds((s) => {
        const next = new Set(s);
        targets.forEach((a) => next.delete(a.id));
        return next;
      });
    } catch (e) {
      // ignore
    }
    closeConfirm();
  };

  const finishAll = async () => {
    await managerRef.current.flushAll();
    const viewed = viewedRef.current.size;
    if (viewed > 0) recordViewed('video', viewed);
    if (sessionRef.current) await sessionManager.finishSession(sessionRef.current);
    setFinalStats({ ...cleanedRef.current });
    setCompleted(true);
  };

  const exit = async () => {
    await managerRef.current.flushAll();
    const viewed = viewedRef.current.size;
    if (viewed > 0) recordViewed('video', viewed);
    if (sessionRef.current) await sessionManager.finishSession(sessionRef.current);
    navigation.goBack();
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
      <SafeAreaView style={[styles.center, { backgroundColor: colors.background }]}>
        <Ionicons name="sparkles" size={54} color={colors.accent} />
        <Text style={[styles.doneTitle, { color: colors.text }]}>
          {t('completion_title')}
        </Text>
        <Text style={[styles.doneSub, { color: colors.subtext }]}>
          {completed ? t('completion_subtitle') : t('no_videos')}
        </Text>
        {completed && (
          <Text style={[styles.doneStat, { color: colors.text }]}>
            {t('completion_deleted', { count: finalStats.count })} ·{' '}
            {t('completion_saved', { size: formatBytes(finalStats.bytes) })}
          </Text>
        )}
        <Pressable
          style={[styles.doneBtn, { backgroundColor: colors.accent }]}
          onPress={() => (completed ? navigation.goBack() : exit())}
        >
          <Text style={styles.doneBtnText}>{t('done')}</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <FlatList
        ref={listRef}
        data={visible}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index: i }) => (
          <VideoCard asset={item} active={i === index} height={height} />
        )}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        getItemLayout={(_, i) => ({ length: height, offset: height * i, index: i })}
      />

      {/* Top bar */}
      <View style={[styles.topBar, { top: insets.top + 6 }]}>
        <Text style={styles.topText} numberOfLines={1}>
          {albumTitle} · {t('videos_watched', { current: index + 1, total: visible.length })}
        </Text>
        <Pressable onPress={exit} hitSlop={10} style={styles.exitBtn}>
          <Ionicons name="close" size={22} color="#fff" />
        </Pressable>
      </View>

      {/* Right floating actions */}
      <View style={[styles.actions, { bottom: insets.bottom + 110 }]}>
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
        <Pressable onPress={softDelete} style={styles.actionBtn}>
          <Ionicons name="trash-outline" size={28} color="#fff" />
        </Pressable>
      </View>

      <View style={[styles.undoWrap, { bottom: insets.bottom + 30 }]}>
        <UndoButton count={undoCount} onPress={undo} />
      </View>

      <MoveSheet
        visible={moveMarkedMode}
        excludeAlbumId={albumId}
        onClose={() => setMoveMarkedMode(false)}
        onSelect={moveMarked}
      />

      <GroupConfirmSheet
        visible={showConfirm && !moveMarkedMode}
        assets={currentGroupAssets}
        markedIds={softDeletedIds}
        onToggleMark={toggleMark}
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
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
    marginRight: 12,
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
  undoWrap: { position: 'absolute', alignSelf: 'center' },
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
