import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  AppState,
  Linking,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useDerivedValue,
  withRepeat,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useSettings } from '../context/SettingsContext';
import { ensureMediaPermission, getMediaPermission } from '../utils/permissions';
import * as PhotoMove from '../../modules/photo-move';
import GlowingTrashBar from '../components/GlowingTrashBar';
import PageIndicator from '../components/PageIndicator';
import BottomInfoBar from '../components/BottomInfoBar';
import AlbumChips from '../components/AlbumChips';

// Page 0 is permission. The drills use only local demo state: the category
// step teaches the real bottom-chip interaction without reading or changing
// the user's albums, and the unreliable swipe-down drill stays removed.
const GESTURE_STEPS = [
  { key: 'tutorial_step1', axis: 'x', dir: 0 },
  { key: 'tutorial_step2', axis: 'y', dir: -1 },
  { key: 'tutorial_step3', axis: null, dir: 0, category: true },
];
const TOTAL_PAGES = GESTURE_STEPS.length + 1;
const PASS_X = 60; // horizontal travel that counts as "browsed"
const PASS_Y = 90; // upward travel that counts as marked for deletion
const CELEBRATE_MS = 480;

const isGranted = (s) => s === 'granted' || s === 'limited';

/**
 * First-launch onboarding page: permissions FIRST, gestures after.
 *
 * Step 1 asks for photo-library access (and, on Android native builds, the
 * "All files access" that in-place categorizing needs) — the app cannot do
 * anything useful before that, so nothing else is shown until it is granted.
 * The rest are hands-on: the user performs the two core review gestures and
 * taps a demo category chip, so each interaction is learned without touching
 * real media.
 *
 * The drill pages deliberately render the SAME chrome as CleaningScreen —
 * the glowing trash bar, the top bar, the page dots and the floating info bar
 * are the real components, not lookalikes.
 *
 * `mode="permissions"` reuses only the first page — used after an OTA update
 * lands to re-check access without repeating the drills.
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
  const categoryStep = !!step?.category;
  const tutorialAlbums = useMemo(
    () => [
      { id: '__demo_a', title: t('tutorial_demo_album_a'), assetCount: 0 },
      { id: '__demo_b', title: t('tutorial_demo_album_b'), assetCount: 0 },
    ],
    [t]
  );

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
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const timerRef = useRef(null);
  const completingRef = useRef(false);
  const demoAsset = useRef({ id: '__demo', creationTime: Date.now() }).current;
  // The advance callback must not read `page` from a stale closure — it is
  // fired from a timer and from gesture callbacks.
  const pageRef = useRef(page);
  pageRef.current = page;

  const finish = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    onDone();
  }, [onDone]);

  const advance = useCallback(() => {
    const current = pageRef.current;
    if (current >= GESTURE_STEPS.length) {
      finish();
      return;
    }
    completingRef.current = false;
    setPassed(false);
    tx.value = 0;
    ty.value = 0;
    setPage(current + 1);
  }, [finish, tx, ty]);

  /** Mark the current step done, celebrate, move on. */
  const completeStep = useCallback(() => {
    if (completingRef.current) return;
    completingRef.current = true;
    setPassed(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => {}
    );
    timerRef.current = setTimeout(advance, CELEBRATE_MS);
  }, [advance]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const axis = step ? step.axis : null;
  const dir = step ? step.dir : 0;
  const swipeEnabled = !!axis && !passed;

  const pan = Gesture.Pan()
    .enabled(swipeEnabled)
    .onUpdate((e) => {
      'worklet';
      // Movement off the drilled axis is damped — the card visibly prefers
      // the direction being taught.
      if (axis === 'x') {
        tx.value = e.translationX;
        ty.value = e.translationY * 0.15;
      } else {
        tx.value = e.translationX * 0.15;
        ty.value = e.translationY;
      }
    })
    .onEnd((e) => {
      'worklet';
      const horizontal = Math.abs(e.translationX) > Math.abs(e.translationY);
      let ok;
      if (axis === 'x') ok = horizontal && Math.abs(e.translationX) > PASS_X;
      else if (dir < 0) ok = !horizontal && e.translationY < -PASS_Y;
      else ok = !horizontal && e.translationY > PASS_Y;

      if (!ok) {
        tx.value = withSpring(0, { damping: 16 });
        ty.value = withSpring(0, { damping: 16 });
        return;
      }
      if (axis === 'x') {
        const to = e.translationX < 0 ? -width : width;
        tx.value = withTiming(to, { duration: 220 }, (finished) => {
          if (finished) runOnJS(completeStep)();
        });
      } else {
        ty.value = withTiming(dir * height, { duration: 220 }, (finished) => {
          if (finished) runOnJS(completeStep)();
        });
      }
    });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }],
    opacity: interpolate(Math.abs(tx.value), [0, width], [1, 0.4], 'clamp'),
  }));

  // Same shape the cleaning screen feeds GlowingTrashBar, so the bar behaves
  // identically here: full glow exactly when the swipe would delete.
  const trashProgress = useDerivedValue(() =>
    Math.min(1, Math.max(0, -ty.value / PASS_Y))
  );

  // Looping direction hint, drawn over the card like a coach mark. It fades
  // out at the end of each cycle so the reset to the start is never visible.
  const hint = useSharedValue(0);
  useEffect(() => {
    if (!step) return undefined;
    hint.value = 0;
    hint.value = withRepeat(withTiming(1, { duration: 1100 }), -1, false);
    return () => {
      hint.value = 0;
    };
  }, [step, hint]);

  const hintStyle = useAnimatedStyle(() => {
    const fade = interpolate(hint.value, [0, 0.15, 0.75, 1], [0, 1, 1, 0], 'clamp');
    const travel = interpolate(hint.value, [0, 1], [0, 26]);
    return {
      opacity: fade,
      transform:
        axis === 'x'
          ? [{ translateX: interpolate(hint.value, [0, 1], [-16, 16]) }]
          : [{ translateY: (axis === 'y' ? dir : 1) * travel }],
    };
  }, [axis, dir]);

  const canContinue = isGranted(media);

  // ---- Page 0: permissions ----------------------------------------------
  if (page === 0) {
    return (
      <SafeAreaView
        edges={['top', 'left', 'right']}
        style={[
          styles.root,
          {
            backgroundColor: colors.background,
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
          {permissionsOnly ? (
            <Pressable
              onPress={finish}
              android_ripple={{ color: colors.accentSoft }}
              accessibilityRole="button"
              style={styles.skip}
            >
              <Text style={[styles.skipText, { color: colors.subtext }]}>
                {t('skip')}
              </Text>
            </Pressable>
          ) : (
            <View style={styles.skip} />
          )}
        </View>

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

        <Pressable
          disabled={!canContinue}
          onPress={() => (permissionsOnly ? finish() : setPage(1))}
          android_ripple={{ color: colors.accentSoft }}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canContinue }}
          style={[
            styles.cta,
            { backgroundColor: canContinue ? colors.accent : colors.chartTrack },
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
      </SafeAreaView>
    );
  }

  // ---- Pages 1..3: drills wearing the cleaning screen's clothes ----------
  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.screen, { backgroundColor: colors.background }]}
    >
      <GlowingTrashBar progress={trashProgress} />

      <View style={styles.cleanTopBar}>
        <View>
          <Text
            style={[styles.topTitle, { color: colors.text }]}
            numberOfLines={1}
          >
            {t('all_photos')}
          </Text>
          <Text style={[styles.topSub, { color: colors.subtext }]}>
            {t('group_of', { current: 1, total: 1 })} ·{' '}
            {t('photo_of', { current: page, total: GESTURE_STEPS.length })}
          </Text>
        </View>
        <Pressable
          onPress={finish}
          android_ripple={{ color: colors.accentSoft }}
          accessibilityRole="button"
          style={[
            styles.exitBtn,
            {
              backgroundColor: colors.chartTrack,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.border,
            },
          ]}
        >
          <Text style={[styles.skipText, { color: colors.text }]}>
            {t('skip')}
          </Text>
        </Pressable>
      </View>

      <GestureDetector gesture={pan}>
        <View style={styles.photoArea}>
          <Animated.View style={[StyleSheet.absoluteFill, cardStyle]}>
            <DemoCard
              colors={colors}
              t={t}
              passed={passed}
              marked={dir < 0}
              ty={ty}
            />
          </Animated.View>

          <View style={styles.coach} pointerEvents="none">
            <View style={styles.coachScrim}>
              <Animated.View style={hintStyle}>
                <Ionicons
                  name={
                    categoryStep
                      ? 'folder-open-outline'
                      : axis === 'x'
                      ? 'swap-horizontal'
                      : 'arrow-up'
                  }
                  size={28}
                  color="#fff"
                />
              </Animated.View>
              <Text style={styles.coachText}>{t(step.key)}</Text>
              <Text style={styles.coachSub}>
                {passed
                  ? t('onboarding_nice')
                  : t(categoryStep
                    ? 'onboarding_tap_category'
                    : 'onboarding_try')}
              </Text>
            </View>
          </View>
        </View>
      </GestureDetector>

      <View
        style={[
          styles.indicatorWrap,
          categoryStep && styles.indicatorWrapWithChips,
        ]}
      >
        <PageIndicator total={GESTURE_STEPS.length} index={page - 1} />
      </View>

      {categoryStep && (
        <View
          style={[
            styles.chipsWrap,
            { bottom: Math.max(insets.bottom, 12) + 80 },
          ]}
          pointerEvents={passed ? 'none' : 'auto'}
        >
          <AlbumChips
            albums={tutorialAlbums}
            currentAlbumId={null}
            onSelect={completeStep}
            onCreate={() => {}}
            showCreate={false}
            sortByUsageEnabled={false}
          />
        </View>
      )}

      <BottomInfoBar
        asset={demoAsset}
        isFavorite={false}
        onToggleFavorite={() => {}}
        onPressDate={() => {}}
        undoCount={0}
        onUndo={() => {}}
      />

    </SafeAreaView>
  );
}

/**
 * Stand-in for a real photo. Same frame, radius and badge placement as
 * PhotoCard so the drill and the cleaning screen read as the same surface.
 */
function DemoCard({ colors, t, passed, marked, ty }) {
  const badgeStyle = useAnimatedStyle(() => ({
    opacity: marked ? Math.min(1, Math.max(0, -ty.value / 40)) : 0,
  }));
  return (
    <View style={styles.card}>
      <View
        style={[
          styles.photo,
          { backgroundColor: colors.chartTrack, borderColor: colors.border },
        ]}
      >
        <Ionicons
          name={passed ? 'checkmark-circle' : 'image-outline'}
          size={72}
          color={passed ? colors.success : colors.subtext}
        />
      </View>
      <Animated.View
        pointerEvents="none"
        style={[styles.markBadge, { backgroundColor: colors.danger }, badgeStyle]}
      >
        <Ionicons name="trash" size={13} color="#fff" />
        <Text style={styles.markText}>{t('marked_for_deletion')}</Text>
      </Animated.View>
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
          android_ripple={{ color: colors.accentSoft }}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
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
  // ---- permission page ----
  root: { flex: 1, paddingHorizontal: 22 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
  },
  dots: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  dot: { height: 6, borderRadius: 3 },
  skip: {
    minWidth: 52,
    minHeight: 48,
    borderRadius: 8,
    alignItems: 'flex-end',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  skipText: { fontSize: 15, fontWeight: '600' },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hero: {
    width: 92,
    height: 92,
    borderRadius: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 24, fontWeight: '800', marginTop: 20, textAlign: 'center' },
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
  rowBtn: {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  rowBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  warn: { fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 16 },
  cta: {
    minHeight: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  ctaText: { fontSize: 16, fontWeight: '700' },

  // ---- drill pages: mirrors CleaningScreen's layout ----
  screen: { flex: 1, paddingHorizontal: 16 },
  cleanTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  topTitle: { fontSize: 18, fontWeight: '800', maxWidth: 260 },
  topSub: { fontSize: 12, marginTop: 2 },
  exitBtn: {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photoArea: { flex: 1, marginBottom: 8 },
  indicatorWrap: { paddingVertical: 8, marginBottom: 84 },
  indicatorWrapWithChips: { marginBottom: 158 },
  chipsWrap: { position: 'absolute', left: 0, right: 0 },
  card: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  photo: {
    width: '100%',
    height: '100%',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
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
  coach: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  // The coach mark floats over arbitrary media, so theme colors alone cannot
  // guarantee contrast.
  coachScrim: {
    alignItems: 'center',
    gap: 10,
    borderRadius: 20,
    paddingHorizontal: 22,
    paddingVertical: 18,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  coachText: {
    color: '#fff',
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '700',
    textAlign: 'center',
  },
  coachSub: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '600',
  },
});
