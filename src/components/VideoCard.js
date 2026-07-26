import React, { useEffect, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';

/**
 * Full-screen video cell for the vertical cleaning feed (expo-video).
 * Auto-plays when `active`, tap toggles pause.
 */
export default function VideoCard({ asset, active, height }) {
  const [paused, setPaused] = useState(false);
  const player = useVideoPlayer(asset.uri, (p) => {
    p.loop = true;
    p.muted = false;
  });

  useEffect(() => {
    if (active && !paused) {
      player.play();
    } else {
      player.pause();
    }
  }, [active, paused, player]);

  // Reset pause state when the cell scrolls out.
  useEffect(() => {
    if (!active) setPaused(false);
  }, [active]);

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
