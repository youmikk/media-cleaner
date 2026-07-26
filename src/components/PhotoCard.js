import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Text, Platform } from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as MediaLibrary from 'expo-media-library';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

// expo-live-photo is iOS-only; guard so Android/Expo Go degrade gracefully.
let LivePhotoView = null;
try {
  // eslint-disable-next-line global-require
  LivePhotoView = require('expo-live-photo').LivePhotoView;
} catch (e) {
  LivePhotoView = null;
}

const pairedCache = {}; // asset id -> {photoUri, pairedVideoUri} | null

function isLivePhoto(asset) {
  return (
    !!asset &&
    Array.isArray(asset.mediaSubtypes) &&
    asset.mediaSubtypes.some((s) => String(s).toLowerCase().includes('live'))
  );
}

/** Resolve the Live Photo's paired video URI (cached per asset). */
function usePairedLivePhoto(asset, enabled) {
  const [source, setSource] = useState(null);
  useEffect(() => {
    let alive = true;
    setSource(null);
    if (!enabled || !asset || Platform.OS !== 'ios' || !LivePhotoView) {
      return undefined;
    }
    if (!isLivePhoto(asset)) return undefined;
    if (pairedCache[asset.id] !== undefined) {
      setSource(pairedCache[asset.id]);
      return undefined;
    }
    (async () => {
      try {
        const info = await MediaLibrary.getAssetInfoAsync(asset.id);
        const paired =
          (info.pairedVideoAsset &&
            (info.pairedVideoAsset.localUri || info.pairedVideoAsset.uri)) ||
          info.pairedVideoUri ||
          null;
        const val = paired
          ? { photoUri: info.localUri || info.uri, pairedVideoUri: paired }
          : null;
        pairedCache[asset.id] = val;
        if (alive) setSource(val);
      } catch (e) {
        pairedCache[asset.id] = null;
      }
    })();
    return () => {
      alive = false;
    };
  }, [asset?.id, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return source;
}

/**
 * Full-bleed media display for the cleaning flow. The photo keeps its
 * ORIGINAL aspect ratio, centered on a theme-adaptive background.
 * - Videos render an inline expo-video player.
 * - iOS Live Photos auto-play (hint style) when the setting is on.
 */
function formatDuration(seconds) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function PhotoCard({ asset, isFavorite, marked, sizeLabel }) {
  const { colors, t, settings } = useSettings();
  const isVideo = asset ? asset.mediaType === 'video' : false;
  const player = useVideoPlayer(isVideo ? asset.uri : null, (p) => {
    p.loop = true;
    p.muted = true; // autoplay politely muted; native controls can unmute
  });
  // AUTO-PLAY videos (e.g. in the Largest Files flow) so it's obvious
  // they're videos, with a badge as a second cue.
  useEffect(() => {
    if (isVideo && player) {
      try {
        player.play();
      } catch (e) {
        // best effort
      }
    }
  }, [isVideo, player, asset?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveSource = usePairedLivePhoto(asset, settings.liveAutoplay && !isVideo);
  const liveRef = useRef(null);

  // Stop Live Photo playback the moment the photo changes / unmounts —
  // no lingering audio from the previous photo.
  useEffect(() => {
    return () => {
      try {
        liveRef.current?.stopPlayback();
      } catch (e) {
        // best effort
      }
    };
  }, [asset?.id]);

  if (!asset) return null;
  const aspectRatio =
    asset.width && asset.height ? asset.width / asset.height : 1;

  return (
    <View style={styles.card}>
      {isVideo ? (
        <VideoView
          player={player}
          style={styles.fill}
          contentFit="contain"
          nativeControls
        />
      ) : liveSource ? (
        <LivePhotoView
          key={asset.id} // force remount per photo — no cross-photo playback
          ref={liveRef}
          source={liveSource}
          isMuted={settings.liveMuted !== false}
          style={[styles.image, { aspectRatio }]}
          onLoadComplete={() => {
            try {
              liveRef.current?.startPlayback('hint');
            } catch (e) {
              // playback is best-effort
            }
          }}
        />
      ) : (
        <Image
          source={{ uri: asset.uri }}
          style={[styles.image, { aspectRatio }]}
          contentFit="contain"
          cachePolicy="memory-disk"
          recyclingKey={asset.id}
          transition={60}
        />
      )}
      {isVideo && (
        <View style={styles.liveBadge}>
          <Ionicons name="videocam" size={12} color="#fff" />
          <Text style={styles.liveText}>
            {formatDuration(asset.duration) || 'VIDEO'}
          </Text>
        </View>
      )}
      {isLivePhoto(asset) && !isVideo && (
        <View style={styles.liveBadge}>
          <Ionicons name="radio-button-on" size={11} color="#fff" />
          <Text style={styles.liveText}>LIVE</Text>
        </View>
      )}
      {isFavorite && (
        <View style={styles.favBadge}>
          <Ionicons name="heart" size={18} color={colors.heart} />
        </View>
      )}
      {marked && (
        <View style={[styles.markBadge, { backgroundColor: colors.danger }]}>
          <Ionicons name="trash" size={13} color="#fff" />
          <Text style={styles.markText}>{t('marked_for_deletion')}</Text>
        </View>
      )}
      {!!sizeLabel && (
        <View style={styles.sizeBadge}>
          <Ionicons name="server-outline" size={12} color="#fff" />
          <Text style={styles.sizeText}>{sizeLabel}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fill: { ...StyleSheet.absoluteFillObject },
  image: {
    width: '100%',
    maxHeight: '100%',
    borderRadius: 14,
  },
  liveBadge: {
    position: 'absolute',
    top: 14,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  liveText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  favBadge: {
    position: 'absolute',
    top: 14,
    left: 14,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 14,
    padding: 6,
  },
  markBadge: {
    position: 'absolute',
    top: 14,
    right: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  markText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  sizeBadge: {
    position: 'absolute',
    bottom: 14,
    left: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  sizeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
