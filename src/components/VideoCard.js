import React, { useEffect, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, Platform } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

/**
 * Full-screen video cell for the vertical cleaning feed (expo-video).
 * Auto-plays when `active`, tap toggles pause. Reports playback progress
 * (`onProgress(0..1)`) and end-of-video (`onEnded`) to the parent.
 *
 * Android notes:
 * - surfaceType="textureView": multiple SurfaceViews in one list conflict
 *   on Android (black screens) — TextureView composits correctly.
 * - Source fallback: if the file:// path fails under scoped storage, retry
 *   with the asset's localUri and then the MediaStore content:// uri.
 */
export default function VideoCard({
  asset,
  active,
  height,
  onProgress,
  onEnded,
  onLoadError, // load failed BEFORE first frame — parent remounts with an
  // alternate uri. We never touch a live player (replace on a
  // running/releasing player can crash natively).
}) {
  const [paused, setPaused] = useState(false);
  const hadPlayedRef = useRef(false); // reached readyToPlay at least once
  const errorFiredRef = useRef(false);
  const player = useVideoPlayer(asset.uri, (p) => {
    p.loop = true;
    p.muted = false;
    p.timeUpdateEventInterval = 0.25;
    // OOM guard (Android OutOfMemoryError in the feed): ExoPlayer's default
    // load control pre-buffers ~50s of media — for high-bitrate videos that
    // is tens of MB per player. Cap both duration and bytes.
    try {
      p.bufferOptions = {
        preferredForwardBufferDuration: 6,
        maxBufferBytes: 12 * 1024 * 1024, // Android only, 0 = automatic
        prioritizeTimeOverSizeThresholds: false,
      };
    } catch (e) {
      // older runtime without bufferOptions — keep defaults
    }
  });

  // A released player throws on any call during list unmounts — never let
  // that escape.
  useEffect(() => {
    try {
      if (active && !paused) player.play();
      else player.pause();
    } catch (e) {
      // player already released
    }
  }, [active, paused, player]);

  useEffect(() => {
    if (!active) setPaused(false);
  }, [active]);

  // Load-time failure -> report ONCE to the parent, which remounts this
  // card with an alternate uri (or a can't-play placeholder). No player
  // mutation from inside the error path.
  useEffect(() => {
    let sub;
    try {
      sub = player.addListener('statusChange', (e) => {
        if (e.status === 'readyToPlay') hadPlayedRef.current = true;
        if (e.status !== 'error') return;
        if (hadPlayedRef.current || errorFiredRef.current) return;
        errorFiredRef.current = true;
        if (onLoadError) {
          setTimeout(() => onLoadError(), 0); // never re-enter the event
        }
      });
    } catch (e) {
      sub = null;
    }
    return () => {
      if (sub) sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, asset.id]);

  // Progress + end-of-playback reporting (active card only).
  useEffect(() => {
    if (!active) return undefined;
    let timeSub;
    let endSub;
    try {
      timeSub = player.addListener('timeUpdate', (e) => {
        try {
          const d = player.duration || asset.duration || 0;
          if (d > 0 && onProgress) {
            onProgress(Math.min(1, (e.currentTime || 0) / d));
          }
        } catch (err) {
          // player released mid-event
        }
      });
      endSub = player.addListener('playToEnd', () => {
        if (onEnded) onEnded();
      });
    } catch (e) {
      // events unavailable — progress bar simply stays empty
    }
    return () => {
      if (timeSub) timeSub.remove();
      if (endSub) endSub.remove();
    };
  }, [active, player, asset.duration, onProgress, onEnded]);

  return (
    <Pressable style={[styles.cell, { height }]} onPress={() => setPaused((p) => !p)}>
      {Platform.OS === 'android' && (
        // Poster frame behind the TextureView (transparent until the first
        // decoded frame) — hides the load gap now that neighbours no longer
        // pre-mount players. Glide decodes video posters cheaply.
        <Image
          source={{ uri: asset.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={0}
        />
      )}
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        nativeControls={false}
        surfaceType={Platform.OS === 'android' ? 'textureView' : undefined}
      />
      {paused && (
        <View style={styles.overlay}>
          <Ionicons name="play" size={56} color="rgba(255,255,255,0.85)" />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cell: { width: '100%', backgroundColor: '#000' },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
