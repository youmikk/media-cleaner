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

const MAX_PAIRED_CACHE = 500;
const pairedCache = new Map(); // asset id -> {photoUri, pairedVideoUri} | null

function cachePaired(id, value) {
  pairedCache.delete(id);
  pairedCache.set(id, value);
  while (pairedCache.size > MAX_PAIRED_CACHE) {
    pairedCache.delete(pairedCache.keys().next().value);
  }
}

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
    if (pairedCache.has(asset.id)) {
      const cached = pairedCache.get(asset.id);
      cachePaired(asset.id, cached);
      setSource(cached);
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
        cachePaired(asset.id, val);
        if (alive) setSource(val);
      } catch (e) {
        cachePaired(asset.id, null);
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
 * - iOS Live Photos always retain the native long-press playback gesture;
 *   the setting only controls automatic hint playback.
 */
function formatDuration(seconds) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The video body — and, critically, the ONLY place useVideoPlayer is called.
 *
 * It used to live in PhotoCard itself with a `isVideo ? uri : null` source.
 * Hooks can't be conditional, so the photo flow (where nothing is a video)
 * still constructed and released a native player for every card it mounted —
 * and the cleaning screen mounts current ± 1, so that was a player created
 * and torn down on EVERY swipe.
 */
function VideoBody({ asset, active = true, onLoadError }) {
  const errorFiredRef = useRef(false);
  const player = useVideoPlayer(asset.uri, (p) => {
    p.loop = true;
    p.muted = true; // autoplay politely muted; native controls can unmute
    // ExoPlayer otherwise buffers roughly 50 seconds. One live player with
    // the default is still enough to OOM on a large 4K video.
    try {
      p.bufferOptions = {
        preferredForwardBufferDuration: 6,
        maxBufferBytes: 12 * 1024 * 1024,
        minBufferForPlayback: 1,
        minBufferForPlaybackAfterRebuffer: 2,
      };
    } catch (e) {
      // Older expo-video builds do not expose bufferOptions.
    }
  });
  // AUTO-PLAY videos (e.g. in the Largest Files flow) so it's obvious
  // they're videos, with a badge as a second cue.
  useEffect(() => {
    try {
      if (active) player.play();
      else player.pause();
    } catch (e) {
      // best effort — a released player throws
    }
  }, [active, player]);
  useEffect(() => {
    let sub;
    try {
      sub = player.addListener('statusChange', (event) => {
        if (event.status === 'error' && onLoadError && !errorFiredRef.current) {
          errorFiredRef.current = true;
          setTimeout(onLoadError, 0);
        }
      });
    } catch (e) {
      sub = null;
    }
    return () => sub?.remove();
  }, [onLoadError, player]);
  return (
    <VideoView
      player={player}
      style={styles.fill}
      contentFit="contain"
      nativeControls
      surfaceType={Platform.OS === 'android' ? 'textureView' : undefined}
    />
  );
}

/** Still image, or its Live Photo form once the paired video resolves. */
function StillBody({ asset, inactive }) {
  const { settings } = useSettings();
  const liveSource = usePairedLivePhoto(asset, !inactive);
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
  }, [asset.id]);

  if (liveSource) {
    const aspectRatio =
      asset.width && asset.height ? asset.width / asset.height : 1;
    return (
      <LivePhotoView
        key={asset.id} // force remount per photo — no cross-photo playback
        ref={liveRef}
        source={liveSource}
        isMuted={settings.liveMuted !== false}
        useDefaultGestureRecognizer
        style={[styles.image, { aspectRatio }]}
        onLoadComplete={() => {
          if (settings.liveAutoplay) {
            try {
              liveRef.current?.startPlayback('hint');
            } catch (e) {
              // playback is best-effort
            }
          }
        }}
      />
    );
  }

  return (
    <Image
      source={{ uri: asset.uri }}
      // FIXED full-size container + contain: the layout never resizes
      // between aspect ratios, so switching photos can't flash.
      //
      // The cleaning screen mounts one of these PER ASSET and keys them
      // by id, so this view's source never changes for its whole life —
      // it decodes once, off screen, and is already painted by the time
      // the card slides into view. (It used to be remounted on every
      // swipe, which threw the decoded image away and made the incoming
      // photo fade in from nothing.)
      style={styles.fillImage}
      contentFit="contain"
      cachePolicy="memory-disk"
      priority="high" // the on-screen photo beats any queued prefetch
      transition={120}
    />
  );
}

export default function PhotoCard({
  asset,
  isFavorite,
  marked,
  sizeLabel,
  inactive = false, // UNDER-card in the stack: no video/live playback
  active = !inactive,
  onLoadError,
}) {
  const { colors, t } = useSettings();
  if (!asset) return null;
  const isVideo = asset.mediaType === 'video';

  return (
    <View style={styles.card}>
      {isVideo && inactive ? (
        <View style={[styles.fill, styles.videoPlaceholder]}>
          <Ionicons name="videocam" size={40} color="rgba(255,255,255,0.5)" />
        </View>
      ) : isVideo ? (
        <VideoBody asset={asset} active={active} onLoadError={onLoadError} />
      ) : (
        <StillBody asset={asset} inactive={inactive} />
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
  videoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
    borderRadius: 14,
  },
  image: {
    width: '100%',
    maxHeight: '100%',
    borderRadius: 14,
  },
  fillImage: { width: '100%', height: '100%' },
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
