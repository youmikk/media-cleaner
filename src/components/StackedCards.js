import React from 'react';
import { View, Pressable, StyleSheet, Platform } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

/**
 * Fanned card stack for the home preview.
 *
 * Three rounded cards share one frame. The front one sits square and sharp;
 * the other two splay out to either side — tilted in the picture plane, not
 * turned in 3D — the way a hand of cards spreads. Each is nudged down a
 * little so their corners break the front card's outline at top and bottom,
 * which is what makes the pile read as physical rather than as three images
 * pasted together.
 *
 * Everything here is STATIC and native:
 * - the transforms are fixed values on plain Views: no animation driver, no
 *   worklet, no per-frame work at all. A flat rotate is also cheaper than the
 *   perspective rotateY this replaced, which forced 3D layer handling;
 * - the blur is expo-image's `blurRadius`, applied once by the native decoder
 *   (SDWebImage / Glide) while producing the bitmap — unlike a BlurView it
 *   costs nothing to keep on screen;
 * - the haze is a flat colour layer, not an opacity animation.
 */

// index 0 is the front card. `x`/`y` are fractions of the card's own size.
//
// `res` is the fraction of full size the view is LAID OUT at. expo-image
// sizes its decode from the layout box, not from the final transform, so a
// back card laid out full-size would decode a full-size bitmap for a sliver
// that is mostly hidden. Laying it out smaller and scaling back up by the
// same factor is identical on screen at about half the decoded pixels.
const LEVELS = [
  { x: 0, y: 0, rotate: '0deg', scale: 1, haze: 0, blur: 0, res: 1 },
  { x: -0.1, y: 0.035, rotate: '-6deg', scale: 0.97, haze: 0.42, blur: 3, res: 0.7 },
  { x: 0.105, y: 0.05, rotate: '6.5deg', scale: 0.97, haze: 0.5, blur: 4, res: 0.7 },
];
// Room for the fan: a card rotated by θ needs W·cosθ + H·sinθ, plus the
// sideways nudge, plus a little for the shadow.
const FRAME_W = 1.38;
const FRAME_H = 1.2;
const RADIUS = 20;

export default function StackedCards({
  items = [],
  cardWidth,
  ratio = 1.45,
  isVideo = false,
  onPress,
}) {
  const { colors } = useSettings();
  const cardHeight = Math.round(cardWidth * ratio);
  const frameW = Math.round(cardWidth * FRAME_W);
  const frameH = Math.round(cardHeight * FRAME_H);

  return (
    <Pressable onPress={onPress} style={{ width: frameW, height: frameH }}>
      {/* Painted back-to-front: later siblings draw on top, which is the one
          stacking rule that behaves the same on both platforms (zIndex and
          elevation disagree on Android). */}
      {[2, 1, 0].map((i) => {
        const level = LEVELS[i];
        const item = items[i];
        const laidW = Math.round(cardWidth * level.res);
        const laidH = Math.round(cardHeight * level.res);
        return (
          <View
            key={i}
            style={[
              styles.card,
              depthShadow(i),
              {
                width: laidW,
                height: laidH,
                borderRadius: RADIUS * level.res,
                backgroundColor: colors.card,
                // Centred in the frame, so scaling about the centre needs no
                // correction — the offsets below are the only displacement.
                left: Math.round((frameW - laidW) / 2),
                top: Math.round((frameH - laidH) / 2),
                transform: [
                  { translateX: level.x * cardWidth },
                  { translateY: level.y * cardHeight },
                  { scale: level.scale / level.res },
                  { rotate: level.rotate },
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
              {level.haze > 0 && (
                // Hazing TOWARD the page colour, not toward black: the back
                // cards should recede into the background in either theme,
                // and a fixed dark scrim only reads as depth on a dark one.
                <View
                  pointerEvents="none"
                  style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: colors.background, opacity: level.haze },
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

/** The front card is the one lifted off the pile, so it casts the most. */
function depthShadow(i) {
  if (Platform.OS === 'android') return { elevation: i === 0 ? 12 : 5 };
  return {
    shadowColor: '#000',
    shadowOpacity: i === 0 ? 0.34 : 0.2,
    shadowRadius: i === 0 ? 18 : 10,
    shadowOffset: { width: 0, height: i === 0 ? 10 : 5 },
  };
}

const styles = StyleSheet.create({
  card: { position: 'absolute' },
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
