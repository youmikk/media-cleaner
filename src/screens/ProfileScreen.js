import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Switch,
  StyleSheet,
  Linking,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSettings } from '../context/SettingsContext';
import { useApp } from '../context/AppContext';
import SuggestionCard from '../components/SuggestionCard';
import StorageChart from '../components/StorageChart';
import { LANGUAGES } from '../i18n';
import {
  getAssets,
  getAssetSize,
  getAssetsByIds,
  findAlbumByTitle,
  formatBytes,
  ALL_ALBUM_ID,
} from '../utils/albumHelpers';
import analyzer from '../utils/chunkedAnalyzer';
import { groupBursts } from '../utils/burstDetection';
import {
  enableDailyReminder,
  disableDailyReminder,
} from '../utils/notificationScheduler';
import {
  APP_VERSION,
  checkOTA,
  reloadWithUpdate,
  checkGitHubRelease,
} from '../utils/updateChecker';

const GITHUB_URL = 'https://github.com/youmikk/media-cleaner';
const SUPPORT_EMAIL = 'support@example.com';
const VERSION = `v${APP_VERSION}`;
const SUGGESTIONS_KEY = 'analysis_suggestions_v2';
const SUGGESTIONS_TTL = 24 * 60 * 60 * 1000; // refresh daily
const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
const SIZE_SCAN_CAP = 300;

/**
 * Profile: smart suggestions, storage chart, usage stats, recycle bin,
 * settings and footer.
 */
export default function ProfileScreen({ navigation }) {
  const { colors, t, settings, setSetting, isAndroid } = useSettings();
  const { stats, trash, refreshTrash } = useApp();

  const [suggestions, setSuggestions] = useState({
    largest: [],
    bursts: [],
    screenshots: [],
    videoDupes: [],
  });
  const [expandedStat, setExpandedStat] = useState(null);

  useFocusEffect(
    useCallback(() => {
      refreshTrash();
    }, [refreshTrash])
  );

  // Low-quality photos AND exact duplicates come from the chunked
  // analyzer's cached metrics.
  const [lowQuality, setLowQuality] = useState({ ids: [], thumb: null });
  const [photoDupes, setPhotoDupes] = useState({ groups: [], thumb: null });
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      analyzer
        .getCached(ALL_ALBUM_ID, 'photo')
        .then(async (cache) => {
          if (!alive || !cache) return;
          if (cache.lowQuality) {
            const ids = cache.lowQuality.map((x) => x.id);
            let thumb = null;
            if (ids.length > 0) {
              const first = await getAssetsByIds(ids.slice(0, 1));
              thumb = first[0]?.uri || null;
            }
            if (alive) setLowQuality({ ids, thumb });
          }
          if (cache.duplicates) {
            let thumb = null;
            if (cache.duplicates.length > 0) {
              const first = await getAssetsByIds(cache.duplicates[0].slice(0, 1));
              thumb = first[0]?.uri || null;
            }
            if (alive) setPhotoDupes({ groups: cache.duplicates, thumb });
          }
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, [])
  );

  // ---- Smart suggestions (cached, refreshed daily) ----
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(SUGGESTIONS_KEY);
        if (raw) {
          const cached = JSON.parse(raw);
          if (
            alive &&
            new Date().getTime() - cached.createdAt < SUGGESTIONS_TTL
          ) {
            setSuggestions(cached.data);
            return;
          }
        }

        // 1) Largest files: photos + videos, sizes sampled on recent assets.
        const [photos, videos] = await Promise.all([
          getAssets(ALL_ALBUM_ID, 'photo'),
          getAssets(ALL_ALBUM_ID, 'video'),
        ]);
        const pool = [...photos.slice(0, SIZE_SCAN_CAP), ...videos.slice(0, SIZE_SCAN_CAP)];
        const sized = [];
        for (const a of pool) {
          if (!alive) return;
          const size = await getAssetSize(a);
          sized.push({ id: a.id, uri: a.uri, size, mediaType: a.mediaType });
        }
        const largest = sized.sort((x, y) => y.size - x.size).slice(0, 10);

        // 2) Burst groups (timestamp clustering — cheap, no pixel work here).
        const bursts = groupBursts(photos).slice(0, 30);
        const burstThumb =
          bursts.length > 0
            ? photos.find((p) => p.id === bursts[0].ids[0])?.uri
            : null;

        // 3) Old screenshots (Screenshots album, 90+ days untouched).
        let screenshots = [];
        const shotsAlbum = await findAlbumByTitle('Screenshots');
        if (shotsAlbum) {
          const shots = await getAssets(shotsAlbum.id, 'photo');
          const cutoff = new Date().getTime() - NINETY_DAYS;
          screenshots = shots
            .filter(
              (s) => (s.modificationTime || s.creationTime || 0) < cutoff
            )
            .map((s) => ({ id: s.id, uri: s.uri }));
        }

        // 4) Duplicate videos: same duration (±0.5s), resolution and size.
        const videoDupes = [];
        const vBuckets = new Map();
        for (const v of videos) {
          const key = `${Math.round((v.duration || 0) * 2)}_${v.width}x${v.height}`;
          if (!vBuckets.has(key)) vBuckets.set(key, []);
          vBuckets.get(key).push(v);
        }
        for (const members of vBuckets.values()) {
          if (members.length < 2) continue;
          const bySize = new Map();
          for (const v of members) {
            if (!alive) return;
            const size = await getAssetSize(v);
            if (!bySize.has(size)) bySize.set(size, []);
            bySize.get(size).push(v.id);
          }
          for (const [size, ids] of bySize.entries()) {
            if (size > 0 && ids.length >= 2) videoDupes.push({ ids });
          }
        }

        const data = {
          largest,
          bursts: bursts.map((b) => ({ ...b, thumb: burstThumb })),
          screenshots,
          videoDupes,
        };
        if (!alive) return;
        setSuggestions(data);
        await AsyncStorage.setItem(
          SUGGESTIONS_KEY,
          JSON.stringify({ createdAt: new Date().getTime(), data })
        );
      } catch (e) {
        // permissions or IO issue — suggestions stay empty
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ---- Update check: OTA first (silent hot update), then GitHub APK ----
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const onCheckUpdate = async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const ota = await checkOTA();
      if (ota === 'applied') {
        Alert.alert(t('check_update'), t('update_ota_ready'), [
          { text: t('cancel'), style: 'cancel' },
          { text: t('update_restart'), onPress: () => reloadWithUpdate() },
        ]);
        return;
      }
      const info = await checkGitHubRelease();
      if (info.hasUpdate) {
        Alert.alert(t('update_available', { version: info.version }), '', [
          { text: t('cancel'), style: 'cancel' },
          {
            text: t('update_download'),
            onPress: () => Linking.openURL(info.url),
          },
        ]);
      } else {
        Alert.alert(t('check_update'), t('update_latest'));
      }
    } catch (e) {
      Alert.alert(t('check_update'), t('update_latest'));
    } finally {
      setCheckingUpdate(false);
    }
  };

  // ---- Settings handlers ----
  const onToggleReminder = async (value) => {
    if (value) {
      const ok = await enableDailyReminder(t);
      if (!ok) {
        Alert.alert(t('setting_reminder'), t('permission_denied'));
        return;
      }
    } else {
      await disableDailyReminder();
    }
    setSetting('dailyReminder', value);
  };

  const cleanAssets = (assetIds, title, sizesById = null) => {
    navigation.navigate('PhotosTab', {
      screen: 'Cleaning',
      params: {
        albumId: ALL_ALBUM_ID,
        albumTitle: title,
        assetIds, // group size comes from the global setting
        sizesById, // shown as a size badge on each photo (Largest Files)
      },
    });
  };

  const Section = ({ title, children }) => (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{title}</Text>
      {children}
    </View>
  );

  const SegmentedRow = ({ label, options, value, onChange }) => (
    <View style={[styles.row, { borderColor: colors.border }]}>
      <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
      <View style={[styles.segmented, { backgroundColor: colors.chartTrack }]}>
        {options.map((opt) => (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            style={[
              styles.segment,
              value === opt.value && { backgroundColor: colors.card },
            ]}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: '600',
                color: value === opt.value ? colors.accent : colors.subtext,
              }}
            >
              {opt.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );

  const ToggleRow = ({ label, value, onChange }) => (
    <View style={[styles.row, { borderColor: colors.border }]}>
      <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.accent }}
      />
    </View>
  );

  const statCards = [
    {
      key: 'photos',
      label: t('stat_photos_cleaned'),
      value: stats.photosCleaned,
      detail: [
        [t('stat_viewed'), stats.photosViewed],
        [t('stat_deleted'), stats.photosCleaned],
      ],
    },
    {
      key: 'videos',
      label: t('stat_videos_cleaned'),
      value: stats.videosCleaned,
      detail: [
        [t('stat_viewed'), stats.videosViewed],
        [t('stat_deleted'), stats.videosCleaned],
      ],
    },
    {
      key: 'space',
      label: t('stat_space_saved'),
      value: formatBytes(stats.spaceSavedBytes),
      detail: [[t('stat_size'), formatBytes(stats.spaceSavedBytes)]],
    },
  ];

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.header, { color: colors.text }]}>
          {t('profile_title')}
        </Text>

        {/* Smart suggestions */}
        <Section title={t('suggestions_title')}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <SuggestionCard
              icon="albums-outline"
              title={t('suggestion_largest')}
              description={t('suggestion_largest_desc')}
              thumbnailUri={suggestions.largest[0]?.uri}
              count={suggestions.largest.length}
              onClean={() =>
                cleanAssets(
                  suggestions.largest.map((a) => a.id),
                  t('suggestion_largest'),
                  Object.fromEntries(
                    suggestions.largest.map((a) => [a.id, a.size])
                  )
                )
              }
            />
            <SuggestionCard
              icon="camera-outline"
              title={t('suggestion_burst')}
              description={t('suggestion_burst_desc')}
              thumbnailUri={suggestions.bursts[0]?.thumb}
              count={suggestions.bursts.length}
              onClean={() =>
                navigation.navigate('BurstClean', {
                  groups: suggestions.bursts.map((b) => ({ ids: b.ids })),
                })
              }
            />
            <SuggestionCard
              icon="phone-portrait-outline"
              title={t('suggestion_screenshots')}
              description={t('suggestion_screenshots_desc')}
              thumbnailUri={suggestions.screenshots[0]?.uri}
              count={suggestions.screenshots.length}
              onClean={() =>
                cleanAssets(
                  suggestions.screenshots.map((a) => a.id),
                  t('suggestion_screenshots')
                )
              }
            />
            <SuggestionCard
              icon="copy-outline"
              title={t('suggestion_dupes')}
              description={
                photoDupes.groups.length > 0
                  ? t('suggestion_dupes_desc')
                  : t('lowquality_need_analysis')
              }
              thumbnailUri={photoDupes.thumb}
              count={photoDupes.groups.length}
              onClean={() =>
                navigation.navigate('BurstClean', {
                  groups: photoDupes.groups.map((ids) => ({ ids })),
                  mode: 'duplicate',
                })
              }
            />
            <SuggestionCard
              icon="film-outline"
              title={t('suggestion_video_dupes')}
              description={t('suggestion_video_dupes_desc')}
              thumbnailUri={null}
              count={(suggestions.videoDupes || []).length}
              onClean={() =>
                navigation.navigate('BurstClean', {
                  groups: suggestions.videoDupes,
                  mode: 'duplicate',
                })
              }
            />
            <SuggestionCard
              icon="eye-off-outline"
              title={t('suggestion_lowquality')}
              description={
                lowQuality.ids.length > 0
                  ? t('suggestion_lowquality_desc')
                  : t('lowquality_need_analysis')
              }
              thumbnailUri={lowQuality.thumb}
              count={lowQuality.ids.length}
              onClean={() =>
                cleanAssets(lowQuality.ids, t('suggestion_lowquality'))
              }
            />
          </ScrollView>
        </Section>

        {/* Tools: photography profile & compressor */}
        <Section title={t('tools_title')}>
          <Pressable
            style={[styles.binRow, { backgroundColor: colors.card, marginBottom: 10 }]}
            onPress={() => navigation.navigate('Insights')}
          >
            <Ionicons name="analytics-outline" size={22} color={colors.accent} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, { color: colors.text }]}>
                {t('insights_title')}
              </Text>
              <Text style={{ color: colors.subtext, fontSize: 12, marginTop: 2 }}>
                {t('insights_desc')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.subtext} />
          </Pressable>
          <Pressable
            style={[styles.binRow, { backgroundColor: colors.card, marginBottom: 10 }]}
            onPress={() => navigation.navigate('Compress')}
          >
            <Ionicons name="archive-outline" size={22} color={colors.accent} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, { color: colors.text }]}>
                {t('compress_title')}
              </Text>
              <Text style={{ color: colors.subtext, fontSize: 12, marginTop: 2 }}>
                {t('compress_desc')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.subtext} />
          </Pressable>
          <Pressable
            style={[styles.binRow, { backgroundColor: colors.card }]}
            onPress={onCheckUpdate}
          >
            <Ionicons name="refresh-circle-outline" size={22} color={colors.accent} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, { color: colors.text }]}>
                {checkingUpdate ? t('update_checking') : t('check_update')}
              </Text>
              <Text style={{ color: colors.subtext, fontSize: 12, marginTop: 2 }}>
                {VERSION}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.subtext} />
          </Pressable>
        </Section>

        {/* Storage comparison */}
        <Section title={t('storage_title')}>
          <StorageChart
            savedBytes={stats.spaceSavedBytes}
            originalBytes={stats.originalSizeBytes}
          />
        </Section>

        {/* Usage statistics */}
        <Section title={t('stats_title')}>
          <View style={styles.statRow}>
            {statCards.map((card) => (
              <Pressable
                key={card.key}
                style={[styles.statCard, { backgroundColor: colors.card }]}
                onPress={() =>
                  setExpandedStat(expandedStat === card.key ? null : card.key)
                }
              >
                <Text style={[styles.statValue, { color: colors.accent }]}>
                  {card.value}
                </Text>
                <Text style={[styles.statLabel, { color: colors.subtext }]}>
                  {card.label}
                </Text>
              </Pressable>
            ))}
          </View>
          {expandedStat && (
            <View style={[styles.statDetail, { backgroundColor: colors.card }]}>
              {statCards
                .find((c) => c.key === expandedStat)
                .detail.map(([k, v]) => (
                  <View key={k} style={styles.statDetailRow}>
                    <Text style={{ color: colors.subtext, fontSize: 13 }}>{k}</Text>
                    <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>
                      {v}
                    </Text>
                  </View>
                ))}
            </View>
          )}
        </Section>

        {/* Recycle bin (Android with setting on, or whenever items exist) */}
        {((isAndroid && settings.recycleBin) || trash.length > 0) && (
          <Section title={t('recycle_bin')}>
            <Pressable
              style={[styles.binRow, { backgroundColor: colors.card }]}
              onPress={() => navigation.navigate('RecycleBin')}
            >
              <Ionicons name="trash-bin-outline" size={22} color={colors.accent} />
              <Text style={[styles.rowLabel, { color: colors.text, flex: 1 }]}>
                {t('recycle_bin')}
              </Text>
              <Text style={{ color: colors.subtext, fontSize: 13 }}>
                {trash.length}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.subtext} />
            </Pressable>
          </Section>
        )}

        {/* Settings */}
        <Section title={t('settings_title')}>
          <View style={[styles.settingsCard, { backgroundColor: colors.card }]}>
            <SegmentedRow
              label={t('setting_group_size')}
              value={settings.groupSize}
              onChange={(v) => setSetting('groupSize', v)}
              options={[5, 10, 15, 20].map((n) => ({ value: n, label: String(n) }))}
            />
            <SegmentedRow
              label={t('setting_order')}
              value={settings.order}
              onChange={(v) => setSetting('order', v)}
              options={[
                { value: 'random', label: t('order_random') },
                { value: 'date', label: t('order_date') },
              ]}
            />
            <ToggleRow
              label={t('setting_similar')}
              value={settings.similarDetection}
              onChange={(v) => setSetting('similarDetection', v)}
            />
            {isAndroid && (
              <ToggleRow
                label={t('setting_recycle')}
                value={settings.recycleBin}
                onChange={(v) => setSetting('recycleBin', v)}
              />
            )}
            <ToggleRow
              label={t('setting_reminder')}
              value={settings.dailyReminder}
              onChange={onToggleReminder}
            />
            <SegmentedRow
              label={t('setting_theme')}
              value={settings.theme}
              onChange={(v) => setSetting('theme', v)}
              options={[
                { value: 'system', label: t('theme_system') },
                { value: 'light', label: t('theme_light') },
                { value: 'dark', label: t('theme_dark') },
              ]}
            />
            <SegmentedRow
              label={t('setting_language')}
              value={settings.language || 'en'}
              onChange={(v) => setSetting('language', v)}
              options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
            />
          </View>
        </Section>

        {/* Footer */}
        <View style={styles.footer}>
          <Pressable
            style={styles.footerLink}
            onPress={() => Linking.openURL(GITHUB_URL)}
          >
            <Ionicons name="logo-github" size={16} color={colors.subtext} />
            <Text style={[styles.footerText, { color: colors.subtext }]}>
              {t('footer_github')}
            </Text>
          </Pressable>
          <Pressable
            style={styles.footerLink}
            onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}
          >
            <Ionicons name="mail-outline" size={16} color={colors.subtext} />
            <Text style={[styles.footerText, { color: colors.subtext }]}>
              {t('footer_support')}
            </Text>
          </Pressable>
          <Text style={[styles.footerText, { color: colors.subtext }]}>
            {t('version')} {VERSION}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16 },
  header: { fontSize: 30, fontWeight: '800', marginTop: 12, marginBottom: 6 },
  section: { marginTop: 20 },
  sectionTitle: { fontSize: 17, fontWeight: '700', marginBottom: 10 },
  statRow: { flexDirection: 'row', gap: 10 },
  statCard: {
    flex: 1,
    borderRadius: 16,
    padding: 14,
    alignItems: 'center',
  },
  statValue: { fontSize: 18, fontWeight: '800' },
  statLabel: { fontSize: 11, marginTop: 4, textAlign: 'center' },
  statDetail: { borderRadius: 14, padding: 14, marginTop: 10 },
  statDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  binRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    padding: 16,
  },
  settingsCard: { borderRadius: 16, paddingHorizontal: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  rowLabel: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  segmented: { flexDirection: 'row', borderRadius: 10, padding: 3 },
  segment: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  footer: { alignItems: 'center', marginTop: 30, gap: 10 },
  footerLink: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  footerText: { fontSize: 12 },
});
