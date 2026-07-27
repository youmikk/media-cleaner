import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  PanResponder,
  AppState,
  Linking,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSettings } from '../context/SettingsContext';
import { ensureMediaPermission, getMediaPermission } from '../utils/permissions';
import * as PhotoMove from '../../modules/photo-move';

// Page 0 is the permission step; pages 1..3 are the gesture drills, in the
// same order the user will meet them in the cleaning flow.
const GESTURE_STEPS = [
  { key: 'tutorial_step1', icon: 'swap-horizontal', axis: 'x', dir: 0 },
  { key: 'tutorial_step2', icon: 'trash', axis: 'y', dir: -1 },
  { key: 'tutorial_step3', icon: 'albums', axis: 'y', dir: 1 },
];
const TOTAL_PAGES = GESTURE_STEPS.length + 1;
const PASS_X = 60; // horizontal travel that counts as "browsed"
const PASS_Y = 90; // vertical travel that counts as delete / move
const CELEBRATE_MS = 480;

const isGranted = (s) => s === 'granted' || s === 'limited';

/**
 * First-launch onboarding page: permissions FIRST, gestures after.
 *
 * Step 1 asks for photo-library access (and, on Android native builds, the
 * "All files access" that in-place categorizing needs) — the app cannot do
 * anything useful before that, so nothing else is shown until it is granted.
 * Steps 2-4 are hands-on: the user must actually perform each swipe on a
 * dummy card to move on, so the gesture is learned rather than read.
 *
 * `mode="permissions"` reuses only the first page — used after an OTA update
 * lands to re-check access without repeating the gesture drills.
 *
 * Rendered by App.js INSTEAD of the navigator, so no alert or background
 * work can appear on top of it.
 */
export default function OnboardingScreen({ onDone, mode = 'full' }) {
  const { colors, t } = useSettings();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const permissionsOnly = mode === 'permissions';
  const [page, setPage] = useState(0);
  const [media, setMedia] = useState('undetermined');
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState(false);
  const [passed, setPassed] = useState(false);

  // Android-only, and only in builds that actually contain the module.
  const showFilesRow = Platform.OS === 'android' && PhotoMove.isAvailable();
  const step = page > 0 ? GESTURE_STEPS[page - 1] : null;

  const refreshPermissions = useCallback(async () => {
    const status = await getMediaPermission();
    setMedia(status);
    if (showFilesRow) setFiles(PhotoMove.hasAllFilesPermission());
  }, [showFilesRow]);

  useEffect(() => {
    refreshPermissions();
    // "All files access" is granted on a SYSTEM settings screen, so the only
    // signal that it worked is the app coming back to the foreground.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refreshPermissions();
    });
    return () => sub.remove();
  }, [refreshPermissions]);

  const requestMedia = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await ensureMediaPermission();
      // A plain 'denied' may mean "asked and refused" or "can never ask
      // again" — re-read to find out which, so we can offer Settings.
      setMedia(result === 'denied' ? await getMediaPermission() : result);
    } catch (e) {
      setMedia('denied');
    } finally {
      setBusy(false);
    }
  };

  // ---- Gesture drill ----------------------------------------------------
  const pos = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const hint = useRef(new Animated.Value(0)).current;
  const timerRef = useRef(null);
  // PanResponder is created once; its callbacks would otherwise capture the
  // first render's page/passed forever.
  const liveRef = useRef({ page, passed });
  liveRef.current = { page, passed };
  const releaseRef = useRef(() => {});
  const moveRef = useRef(() => {});

  const finish = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    onDone();
  }, [onDone]);

  const advance = useCallback(() => {
    const current = liveRef.current.page;
    if (current >= GESTURE_STEPS.length) {
      finish();
      return;
    }
    pos.setValue({ x: 0, y: 0 });
    setPassed(false);
    setPage(current + 1);
  }, [finish, pos]);

  const springBack = useCallback(() => {
    Animated.spring(pos, {
      toValue: { x: 0, y: 0 },
      // JS-driven on purpose: `pos` is also setValue()'d from the pan
      // handler and read back through interpolations for the trash bar —
      // mixing that with the native driver is exactly the combination RN
      // refuses at runtime.
      useNativeDriver: false,
      friction: 7,
      tension: 70,
    }).start();
  }, [pos]);

  moveRef.current = (g) => {
    const s = GESTURE_STEPS[liveRef.current.page - 1];
    if (!s || liveRef.current.passed) return;
    // Movement off the drilled axis is damped — the card visibly prefers the
    // direction being taught.
    if (s.axis === 'x') pos.setValue({ x: g.dx, y: g.dy * 0.15 });
    else pos.setValue({ x: g.dx * 0.15, y: g.dy });
  };

  releaseRef.current = (g) => {
    const s = GESTURE_STEPS[liveRef.current.page - 1];
    if (!s || liveRef.current.passed) return;
    const horizontal = Math.abs(g.dx) > Math.abs(g.dy);
    let ok;
    if (s.axis === 'x') ok = horizontal && Math.abs(g.dx) > PASS_X;
    else if (s.dir < 0) ok = !horizontal && g.dy < -PASS_Y;
    else ok = !horizontal && g.dy > PASS_Y;

    if (!ok) {
      springBack();
      return;
    }
    setPassed(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => {}
    );
    const fly =
      s.axis === 'x'
        ? { x: Math.sign(g.dx) * width, y: 0 }
        : { x: 0, y: s.dir * height };
    Animated.timing(pos, {
      toValue: fly,
      duration: 220,
      useNativeDriver: false,
    }).start(() => {
      timerRef.current = setTimeout(advance, CELEBRATE_MS);
    });
  };

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8,
      onPanResponderMove: (_, g) => moveRef.current(g),
      onPanResponderRelease: (_, g) => releaseRef.current(g),
      onPanResponderTerminate: () => springBack(),
    })
  ).current;

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Looping direction hint. It fades out at the end of each cycle so the
  // reset to the start position is never visible.
  useEffect(() => {
    if (!step) return undefined;
    hint.setValue(0);
    const loop = Animated.loop(
      Animated.timing(hint, {
        toValue: 1,
        duration: 1100,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [step, hint]);

  const hintStyle = {
    opacity: hint.interpolate({
      inputRange: [0, 0.15, 0.75, 1],
      outputRange: [0, 1, 1, 0],
    }),
    transform: [
      step && step.axis === 'x'
        ? {
            translateX: hint.interpolate({
              inputRange: [0, 1],
              outputRange: [-16, 16],
            }),
          }
        : {
            translateY: hint.interpolate({
              inputRange: [0, 1],
              outputRange: [0, (step ? step.dir : 1) * 26],
            }),
          },
    ],
  };

  // Delete drill: the red bar tracks the upward drag, exactly like the real
  // GlowingTrashBar in the cleaning screen.
  const trashProgress = pos.y.interpolate({
    inputRange: [-PASS_Y * 2, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  const canContinue = isGranted(media);

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 20,
        },
      ]}
    >
      <View style={styles.topBar}>
        <View style={styles.dots}>
          {permissionsOnly
            ? null
            : Array.from({ length: TOTAL_PAGES }).map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.dot,
                    {
                      backgroundColor:
                        i === page ? colors.accent : colors.chartTrack,
                      width: i === page ? 20 : 6,
                    },
                  ]}
                />
              ))}
        </View>
        {page > 0 || permissionsOnly ? (
          <Pressable onPress={finish} hitSlop={12} style={styles.skip}>
            <Text style={[styles.skipText, { color: colors.subtext }]}>
              {t('skip')}
            </Text>
          </Pressable>
        ) : (
          <View style={styles.skip} />
        )}
      </View>

      {page === 0 ? (
        <View style={styles.body}>
          <View style={[styles.hero, { backgroundColor: colors.accentSoft }]}>
            <Ionicons
              name={permissionsOnly ? 'sparkles' : 'shield-checkmark'}
              size={44}
              color={colors.accent}
            />
          </View>
          <Text style={[styles.title, { color: colors.text }]}>
            {t(
              permissionsOnly
                ? 'onboarding_recheck_title'
                : 'onboarding_welcome_title'
            )}
          </Text>
          <Text style={[styles.subtitle, { color: colors.subtext }]}>
            {t(
              permissionsOnly
                ? 'onboarding_recheck_sub'
                : 'onboarding_welcome_sub'
            )}
          </Text>

          <View style={styles.rows}>
            <PermRow
              icon="images"
              title={t('onboarding_perm_photos')}
              desc={t('onboarding_perm_photos_desc')}
              granted={isGranted(media)}
              disabled={busy}
              actionLabel={
                media === 'blocked'
                  ? t('onboarding_open_settings')
                  : t('onboarding_grant')
              }
              onPress={
                media === 'blocked'
                  ? () => Linking.openSettings().catch(() => {})
                  : requestMedia
              }
              colors={colors}
              t={t}
            />
            {showFilesRow ? (
              <PermRow
                icon="folder-open"
                title={t('onboarding_perm_files')}
                desc={t('onboarding_perm_files_desc')}
                granted={files}
                optional
                actionLabel={t('onboarding_grant')}
                onPress={() => PhotoMove.requestAllFilesPermission()}
                colors={colors}
                t={t}
              />
            ) : null}
          </View>

          {media === 'blocked' ? (
            <Text style={[styles.warn, { color: colors.danger }]}>
              {t('permission_denied')}
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.body} {...pan.panHandlers}>
          {step.dir < 0 ? (
            <Animated.View
              style={[
                styles.trashBar,
                {
                  backgroundColor: colors.danger,
                  opacity: trashProgress,
                  transform: [
                    {
                      translateY: trashProgress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [-70, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
              <Ionicons name="trash" size={22} color="#fff" />
            </Animated.View>
          ) : null}

          <Animated.View
            style={[
              styles.card,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                transform: pos.getTranslateTransform(),
              },
            ]}
          >
            <View
              style={[
                styles.cardIcon,
                {
                  backgroundColor: passed
                    ? 'rgba(48,209,88,0.15)'
                    : step.icon === 'trash'
                      ? colors.dangerSoft
                      : colors.accentSoft,
                },
              ]}
            >
              <Ionicons
                name={passed ? 'checkmark' : step.icon}
                size={40}
                color={
                  passed
                    ? colors.success
                    : step.icon === 'trash'
                      ? colors.danger
                      : colors.accent
                }
              />
            </View>
            <Text style={[styles.cardHint, { color: colors.subtext }]}>
              {passed ? t('onboarding_nice') : t('onboarding_try')}
            </Text>
          </Animated.View>

          <Animated.View style={[styles.arrow, hintStyle]}>
            <Ionicons
              name={
                step.axis === 'x'
                  ? 'swap-horizontal'
                  : step.dir < 0
                    ? 'arrow-up'
                    : 'arrow-down'
              }
              size={26}
              color={colors.accent}
            />
          </Animated.View>

          <Text style={[styles.stepText, { color: colors.text }]}>
            {t(step.key)}
          </Text>
        </View>
      )}

      {page === 0 ? (
        <Pressable
          disabled={!canContinue}
          onPress={() => (permissionsOnly ? finish() : setPage(1))}
          style={[
            styles.cta,
            {
              backgroundColor: canContinue ? colors.accent : colors.chartTrack,
            },
          ]}
        >
          <Text
            style={[
              styles.ctaText,
              { color: canContinue ? '#fff' : colors.subtext },
            ]}
          >
            {!canContinue
              ? t('onboarding_perm_required')
              : t(permissionsOnly ? 'done' : 'onboarding_continue')}
          </Text>
        </Pressable>
      ) : (
        <Text style={[styles.footNote, { color: colors.subtext }]}>
          {t('onboarding_gesture_foot')}
        </Text>
      )}
    </View>
  );
}

function PermRow({
  icon,
  title,
  desc,
  granted,
  optional,
  actionLabel,
  onPress,
  disabled,
  colors,
  t,
}) {
  return (
    <View style={[styles.row, { backgroundColor: colors.card }]}>
      <View style={[styles.rowIcon, { backgroundColor: colors.accentSoft }]}>
        <Ionicons name={icon} size={20} color={colors.accent} />
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: colors.text }]}>
          {title}
          {optional ? (
            <Text style={{ color: colors.subtext }}>
              {` · ${t('onboarding_optional')}`}
            </Text>
          ) : null}
        </Text>
        <Text style={[styles.rowDesc, { color: colors.subtext }]}>{desc}</Text>
      </View>
      {granted ? (
        <View style={styles.rowAction}>
          <Ionicons name="checkmark-circle" size={24} color={colors.success} />
        </View>
      ) : (
        <Pressable
          disabled={disabled}
          onPress={onPress}
          style={[
            styles.rowBtn,
            { backgroundColor: colors.accent, opacity: disabled ? 0.5 : 1 },
          ]}
        >
          <Text style={styles.rowBtnText}>{actionLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 22 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 34,
  },
  dots: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  dot: { height: 6, borderRadius: 3 },
  skip: { minWidth: 52, alignItems: 'flex-end' },
  skipText: { fontSize: 15, fontWeight: '600' },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hero: {
    width: 92,
    height: 92,
    borderRadius: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    marginTop: 20,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: 10,
    paddingHorizontal: 8,
  },
  rows: { alignSelf: 'stretch', marginTop: 28, gap: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 18,
    padding: 14,
    gap: 12,
  },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  rowDesc: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  rowAction: { width: 24, alignItems: 'center' },
  rowBtn: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8 },
  rowBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  warn: { fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 16 },
  card: {
    width: 200,
    height: 260,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  cardIcon: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardHint: { fontSize: 14, fontWeight: '600' },
  arrow: { marginTop: 22, height: 30 },
  stepText: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 18,
    minHeight: 72,
  },
  trashBar: {
    position: 'absolute',
    top: 0,
    left: -22,
    right: -22,
    height: 62,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 10,
  },
  cta: {
    borderRadius: 16,
    paddingVertical: 15,
    alignItems: 'center',
  },
  ctaText: { fontSize: 16, fontWeight: '700' },
  footNote: { fontSize: 13, textAlign: 'center' },
});
