import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  PanResponder,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';

const STEPS = [
  { icon: 'swap-horizontal', key: 'tutorial_step1' },
  { icon: 'trash', key: 'tutorial_step2' },
  { icon: 'albums', key: 'tutorial_step3' },
];

/**
 * First-launch tutorial overlay: 3 gesture steps + "Got it".
 */
export default function TutorialOverlay({ visible, onDone }) {
  const { colors, t } = useSettings();
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;

  // Swipe left/right to move through steps (practising the gesture itself).
  const stateRef = useRef({ step, onDone });
  stateRef.current = { step, onDone };
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 12,
      onPanResponderRelease: (_, g) => {
        const { step: s, onDone: done } = stateRef.current;
        if (g.dx < -40) {
          if (s === STEPS.length - 1) {
            setStep(0);
            done();
          } else {
            setStep(s + 1);
          }
        } else if (g.dx > 40 && s > 0) {
          setStep(s - 1);
        }
      },
    })
  ).current;

  if (!visible) return null;

  return (
    // Absolute in-app overlay (NOT a Modal) — immune to Android's
    // modal-vs-dialog touch conflicts. Swipe ANYWHERE to move through steps.
    <View style={styles.overlay} pointerEvents="auto">
      <BlurView
        intensity={40}
        tint={colors.glassTint}
        style={styles.backdrop}
        {...pan.panHandlers}
      >
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          <View
            style={[
              styles.iconWrap,
              {
                backgroundColor:
                  STEPS[step].icon === 'trash' ? colors.dangerSoft : colors.accentSoft,
              },
            ]}
          >
            <Ionicons
              name={STEPS[step].icon}
              size={40}
              color={STEPS[step].icon === 'trash' ? colors.danger : colors.accent}
            />
          </View>
          <Text style={[styles.text, { color: colors.text }]}>
            {t(STEPS[step].key)}
          </Text>
          <View style={styles.dots}>
            {STEPS.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  {
                    backgroundColor: i === step ? colors.accent : colors.chartTrack,
                    width: i === step ? 18 : 6,
                  },
                ]}
              />
            ))}
          </View>
          <Pressable
            style={[styles.btn, { backgroundColor: colors.accent }]}
            onPress={() => {
              if (isLast) {
                setStep(0);
                onDone();
              } else {
                setStep(step + 1);
              }
            }}
          >
            <Text style={styles.btnText}>
              {isLast ? t('got_it') : '→'}
            </Text>
          </Pressable>
        </View>
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000,
    elevation: 1000,
  },
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  card: {
    width: '100%',
    borderRadius: 24,
    padding: 28,
    alignItems: 'center',
  },
  iconWrap: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  text: {
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
    fontWeight: '600',
    minHeight: 72,
  },
  dots: {
    flexDirection: 'row',
    gap: 5,
    alignItems: 'center',
    marginVertical: 16,
  },
  dot: { height: 6, borderRadius: 3 },
  btn: {
    borderRadius: 14,
    paddingHorizontal: 40,
    paddingVertical: 13,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
