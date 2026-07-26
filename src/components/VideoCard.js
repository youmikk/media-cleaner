import React, { useEffect, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, Platform } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as MediaLibrary from 'expo-media-library';
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
export default function VideoCard({ asset, active, height, onProgress, onEnded }) {
  const [paused, setPaused] = useState(false);
  const fallbackStepRef = useRef(0);
  const hadPlayedRef = useRef(false); // reached readyToPlay at least once
  const aliveRef = useRef(true);
  const player = useVideoPlayer(asset.uri, (p) => {
    p.loop = true;
    p.muted = false;
    p.timeUpdateEventInterval = 0.25;
  });

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

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

  // Playback-error fallback chain: uri -> localUri -> content:// (Android).
  // ONLY for load-time failures. If the video already played and THEN
  // errors, the file was most likely just deleted — retrying against a
  // dead file (or a released player) is what crashes, so we bail.
  useEffect(() => {
    let sub;
    try {
      sub = player.addListener('statusChange', (e) => {
        if (e.status === 'readyToPlay') hadPlayedRef.current = true;
        if (e.status !== 'error') return;
        if (hadPlayedRef.current) return; // deleted mid-session — no retry
        const step = fallbackStepRef.current;
        if (step >= 2) return; // out of options
        fallbackStepRef.current = step + 1;
        (async () => {
          let alt = null;
          if (step === 0) {
            try {
              const info = await MediaLibrary.getAssetInfoAsync(asset.id);
              alt = info.localUri || info.uri;
              if (alt === asset.uri) alt = null; // same thing — skip ahead
            } catch (err) {
              alt = null;
            }
          }
          if (!alt && Platform.OS === 'android') {
            const rawId = String(asset.id).split('/')[0];
            if (/^\d+$/.test(rawId)) {
              alt = `content://media/external/video/media/${rawId}`;
            }
          }
          if (alt && aliveRef.current) {
            try {
              player.replace(alt);
              if (active && !paused) player.play();
            } catch (err) {
              // give up quietly
            }
          }
        })();
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
