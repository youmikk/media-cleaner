import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import {
  GestureHandlerRootView,
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';

const MAX_SCALE = 6;

/**
 * One zoomable page. Pinch to zoom, double-tap to toggle 2.5x, pan when
 * zoomed. When NOT zoomed a horizontal fling goes to the previous / next
 * item. Keyed by asset id from the parent so zoom state resets per photo.
 */
function ZoomablePage({ uri, width, height, onPrev, onNext }) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  const clamp = () => {
    'worklet';
    const maxX = (width * (scale.value - 1)) / 2;
    const maxY = (height * (scale.value - 1)) / 2;
    tx.value = Math.min(maxX, Math.max(-maxX, tx.value));
    ty.value = Math.min(maxY, Math.max(-maxY, ty.value));
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      'worklet';
      scale.value = Math.min(MAX_SCALE, Math.max(1, savedScale.value * e.scale));
    })
    .onEnd(() => {
      'worklet';
      savedScale.value = scale.value;
      clamp();
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      'worklet';
      const target = scale.value > 1.02 ? 1 : 2.5;
      scale.value = withTiming(target, { duration: 180 });
      savedScale.value = target;
      tx.value = withTiming(0, { duration: 180 });
      ty.value = withTiming(0, { duration: 180 });
      savedTx.value = 0;
      savedTy.value = 0;
    });

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      'worklet';
      if (scale.value <= 1.02) return; // not zoomed — handled on release
      tx.value = savedTx.value + e.translationX;
      ty.value = savedTy.value + e.translationY;
      clamp();
    })
    .onEnd((e) => {
      'worklet';
      if (scale.value <= 1.02) {
        // Not zoomed: a horizontal swipe pages between items.
        if (e.translationX < -60 || e.velocityX < -800) runOnJS(onNext)();
        else if (e.translationX > 60 || e.velocityX > 800) runOnJS(onPrev)();
        return;
      }
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  const gesture = Gesture.Race(
    doubleTap,
    Gesture.Simultaneous(pinch, pan)
  );

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[{ width, height }, style]}>
        <Image
          source={{ uri }}
          style={{ width: '100%', height: '100%' }}
          contentFit="contain"
          cachePolicy="memory-disk"
        />
      </Animated.View>
    </GestureDetector>
  );
}

/**
 * Full-screen photo viewer for grid screens (similar clusters, bursts,
 * duplicates). Swipe / chevrons to move through the group, pinch or
 * double-tap to zoom, optional mark-for-deletion toggle at the bottom.
 */
export default function PhotoViewer({
  visible,
  assets = [],
  initialIndex = 0,
  onClose,
  selected = null, // {id: bool} — enables the mark toggle when provided
  onToggleSelect = null,
  thumbs = {},
  bestId = null,
}) {
  const { colors, t } = useSettings();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(initialIndex);

  useEffect(() => {
    if (visible) setIndex(initialIndex);
  }, [visible, initialIndex]);

  const asset = assets[Math.min(index, Math.max(0, assets.length - 1))] || null;
  const isSel = asset && selected ? !!selected[asset.id] : false;

  const goPrev = () => setIndex((i) => Math.max(0, i - 1));
  const goNext = () => setIndex((i) => Math.min(assets.length - 1, i + 1));

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="fade"
      onRequestClose={onClose}
    >
      <GestureHandlerRootView style={styles.root}>
        {asset && (
          <ZoomablePage
            key={asset.id}
            uri={thumbs[asset.id] || asset.uri}
            width={width}
            height={height}
            onPrev={goPrev}
            onNext={goNext}
          />
        )}

        {/* Top bar: close · counter · badges */}
        <View style={[styles.topBar, { top: insets.top + 8 }]}>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            style={styles.roundBtn}
            accessibilityRole="button"
            accessibilityLabel={t('close')}
          >
            <Ionicons name="close" size={22} color="#fff" />
          </Pressable>
          <Text style={styles.counter}>
            {Math.min(index + 1, assets.length)}/{assets.length}
          </Text>
          <View style={styles.badges}>
            {asset && asset.mediaType === 'video' && (
              <View style={styles.badge}>
                <Ionicons name="videocam" size={13} color="#fff" />
              </View>
            )}
            {asset && bestId === asset.id && (
              <View style={[styles.badge, { backgroundColor: colors.success }]}>
                <Ionicons name="star" size={13} color="#fff" />
              </View>
            )}
          </View>
        </View>

        {/* Side chevrons (in addition to swiping) */}
        {index > 0 && (
          <Pressable
            onPress={goPrev}
            hitSlop={10}
            style={[styles.chev, { left: 8 }]}
            accessibilityRole="button"
            accessibilityLabel={t('previous')}
          >
            <Ionicons name="chevron-back" size={26} color="#fff" />
          </Pressable>
        )}
        {index < assets.length - 1 && (
          <Pressable
            onPress={goNext}
            hitSlop={10}
            style={[styles.chev, { right: 8 }]}
            accessibilityRole="button"
            accessibilityLabel={t('next')}
          >
            <Ionicons name="chevron-forward" size={26} color="#fff" />
          </Pressable>
        )}

        {/* Mark-for-deletion toggle */}
        {selected && onToggleSelect && asset && (
          <Pressable
            onPress={() => onToggleSelect(asset.id)}
            accessibilityRole="button"
            accessibilityState={{ selected: isSel }}
            accessibilityLabel={isSel ? t('viewer_marked') : t('viewer_mark')}
            style={[
              styles.markBtn,
              {
                bottom: Math.max(insets.bottom, 16) + 12,
                backgroundColor: isSel ? colors.danger : 'rgba(0,0,0,0.45)',
              },
            ]}
          >
            <Ionicons
              name={isSel ? 'trash' : 'trash-outline'}
              size={17}
              color="#fff"
            />
            <Text style={styles.markText}>
              {isSel ? t('viewer_marked') : t('viewer_mark')}
            </Text>
          </Pressable>
        )}
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topBar: {
    position: 'absolute',
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 10,
  },
  roundBtn: {
    backgroundColor: 'rgba(0,0,0,0.45)', // readable over white photos too
    borderRadius: 18,
    padding: 8,
  },
  counter: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  badges: { flexDirection: 'row', gap: 6, minWidth: 38, justifyContent: 'flex-end' },
  badge: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  chev: {
    position: 'absolute',
    top: '50%',
    marginTop: -18,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 18,
    padding: 5,
    zIndex: 10,
  },
  markBtn: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 11,
    zIndex: 10,
  },
  markText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
