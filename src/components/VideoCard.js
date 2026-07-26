import React, { useRef, useState } from 'react';
import { View, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';

/**
 * Full-screen video cell for the vertical cleaning feed.
 * Auto-plays when `active`, tap toggles pause.
 */
export default function VideoCard({ asset, active, height }) {
  const ref = useRef(null);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);

  const toggle = async () => {
    if (!ref.current) return;
    if (paused) {
      await ref.current.playAsync();
      setPaused(false);
    } else {
      await ref.current.pauseAsync();
      setPaused(true);
    }
  };

  return (
    <Pressable style={[styles.cell, { height }]} onPress={toggle}>
      <Video
        ref={ref}
        source={{ uri: asset.uri }}
        style={StyleSheet.absoluteFill}
        resizeMode={ResizeMode.CONTAIN}
        shouldPlay={active && !paused}
        isLooping
        onLoadStart={() => setLoading(true)}
        onReadyForDisplay={() => setLoading(false)}
        useNativeControls={false}
      />
      {loading && active && (
        <View style={styles.overlay}>
          <ActivityIndicator color="#fff" />
        </View>
      )}
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
