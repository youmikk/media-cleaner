import React, { useEffect, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';

/**
 * Full-screen video cell for the vertical cleaning feed (expo-video).
 * Auto-plays when `active`, tap toggles pause. Reports playback progress
 * (`onProgress(0..1)`) and end-of-video (`onEnded`) to the parent.
 */
export default function VideoCard({ asset, active, height, onProgress, onEnded }) {
  const [paused, setPaused] = useState(false);
  const player = useVideoPlayer(asset.uri, (p) => {
    p.loop = true;
    p.muted = false;
    p.timeUpdateEventInterval = 0.25;
  });

  useEffect(() => {
    if (active && !paused) {
      player.play();
    } else {
      player.pause();
    }
  }, [active, paused, player]);

  useEffect(() => {
    if (!active) setPaused(false);
  }, [active]);

  // Progress + end-of-playback reporting (active card only).
  useEffect(() => {
    if (!active) return undefined;
    let timeSub;
    let endSub;
    try {
      timeSub = player.addListener('timeUpdate', (e) => {
        const d = player.duration || asset.duration || 0;
        if (d > 0 && onProgress) {
          onProgress(Math.min(1, (e.currentTime || 0) / d));
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
