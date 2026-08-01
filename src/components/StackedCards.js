import React from 'react';
import { View, Pressable, StyleSheet, Platform } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

/**
 * 3D layered card stack for the home preview.
 *
 * Three rounded cards share one absolute frame. The front one is untouched;
 * the two behind step to the RIGHT, shrink, and rotate on Y behind a shared
 * perspective, so they read as receding into the screen rather than merely
 * sliding sideways. Depth is sold by three cues at once — offset, scale and
 * rotation — plus a darkening scrim and a softening blur that both grow with
 * depth.
 *
 * Everything here is STATIC and native:
 * - the transforms are fixed values on plain Views, so there is no animation
 *   driver, no worklet and no per-frame work at all;
 * - the blur is expo-image's `blurRadius`, applied once by the native
 *   decoder (SDWebImage / Glide) as part of producing the bitmap — unlike a
 *   BlurView it costs nothing to keep on screen;
 * - the scrim is a flat colour layer, not an opacity animation.
 */

// index 0 is the front card. `x` is a fraction of the card width.
//
// `res` is the fraction of the full card size the view is actually LAID OUT
// at. expo-image sizes its decode from the layout box, not from the final
// transform, so a back card laid out full-size would decode a full-size
// bitmap only to have the GPU shrink it — for a sliver that is 85% hidden.
// Laying it out smaller and scaling back up by the same factor is pixel-for
// -pixel identical on screen at ~36% of the decoded pixels.
const LEVELS = [
  { x: 0, scale: 1, rotate: '0deg', dim: 0, blur: 0, res: 1 },
  { x: 0.17, scale: 0.93, rotate: '11deg', dim: 0.24, blur: 2, res: 0.6 },
  { x: 0.32, scale: 0.86, rotate: '18deg', dim: 0.4, blur: 4, res: 0.6 },
];
// Shallow enough to keep the cards readable; deeper values skew the far
// edge so hard the thumbnail stops looking like a photo.
const PERSPECTIVE = 900;
const RADIUS = 22;

export default function StackedCards({
  items = [],
  cardWidth,
  ratio = 1.45,
  isVideo = false,
  onPress,
}) {
  const { colors } = useSettings();
  const cardHeight = Math.round(cardWidth * ratio);
  const last = LEVELS[LEVELS.length - 1];
  // Room for the deepest card plus a little for its shadow.
  const width = Math.round(cardWidth * (1 + last.x) + 10);

  return (
    <Pressable onPress={onPress} style={{ width, height: cardHeight }}>
      {/* Painted back-to-front: later siblings draw on top, which is the one
          stacking rule that behaves the same on both platforms (zIndex and
          elevation disagree on Android). */}
      {[2, 1, 0].map((i) => {
        const level = LEVELS[i];
        const item = items[i];
        // Shrinking the layout box moves its centre, and scale pivots on
        // that centre — so both axes need the offset added back, or the
        // card would drift up and left out of the stack.
        const recentre = 0.5 - level.res / 2;
        return (
          <View
            key={i}
            style={[
              styles.card,
              depthShadow(i),
              {
                width: cardWidth * level.res,
                height: cardHeight * level.res,
                borderRadius: RADIUS * level.res,
                backgroundColor: colors.card,
                transform: [
                  { perspective: PERSPECTIVE },
                  { translateX: level.x * cardWidth + recentre * cardWidth },
                  { translateY: recentre * cardHeight },
                  { scale: level.scale / level.res },
                  { rotateY: level.rotate },
                ],
              },
            ]}
          >
            {/* Clipping lives on an INNER view: on iOS a rounded
                overflow:hidden container drops the shadow of the view it is
                on, so the shadow and the mask cannot share one node. */}
            <View style={[styles.clip, { borderRadius: RADIUS * level.res }]}>
              {item ? (
                <Image
                  source={{ uri: item.uri }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  recyclingKey={item.id}
                  blurRadius={level.blur}
                  transition={150}
                  priority={i === 0 ? 'high' : 'normal'}
                />
              ) : (
                <View style={styles.empty}>
                  <Ionicons
                    name={isVideo ? 'videocam-outline' : 'image-outline'}
                    size={Math.round((i === 0 ? 30 : 22) / level.res)}
                    color={colors.subtext}
                  />
                </View>
              )}
              {level.dim > 0 && (
                <View
                  pointerEvents="none"
                  style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: `rgba(0,0,0,${level.dim})` },
                  ]}
                />
              )}
            </View>
            {isVideo && item && i === 0 && (
              <View style={styles.playBadge} pointerEvents="none">
                <Ionicons name="play" size={18} color="#fff" />
              </View>
            )}
          </View>
        );
      })}
    </Pressable>
  );
}

/** Deeper cards sit further from the surface, so their shadow spreads. */
function depthShadow(i) {
  if (Platform.OS === 'android') return { elevation: 10 - i * 3 };
  return {
    shadowColor: '#000',
    shadowOpacity: 0.28 - i * 0.06,
    shadowRadius: 14 - i * 3,
    shadowOffset: { width: -2 - i, height: 6 },
  };
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  clip: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  playBadge: {
    position: 'absolute',
    alignSelf: 'center',
    top: '44%',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 20,
    padding: 8,
  },
});
