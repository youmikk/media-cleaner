import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Linking,
  Share,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import { useFavorites, useStats, useTrash } from '../context/AppContext';
import SuggestionCard from '../components/SuggestionCard';
import StorageChart from '../components/StorageChart';
import OptionPicker from '../components/OptionPicker';
import DeletionModePicker from '../components/DeletionModePicker';
import SettingsRow from '../components/SettingsRow';
import AppSwitch from '../components/AppSwitch';
import { showAppAlert } from '../components/AppDialog';
import { LANGUAGES } from '../i18n';
import {
  getAssets,
  getAssetSizes,
  getAssetsByIds,
  getLibrarySize,
  findAlbumByTitle,
  formatBytes,
  ALL_ALBUM_ID,
} from '../utils/albumHelpers';
import analyzer from '../utils/chunkedAnalyzer';
import * as suggestionStore from '../utils/suggestionStore';
import * as suggestionCache from '../utils/suggestionCache';
import * as statsManager from '../utils/statsManager';
import * as cacheManager from '../utils/cacheManager';
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
  canMirror,
  mirrorUrl,
  fetchLatestChangelog,
} from '../utils/updateChecker';

import { getLogFileUri, log as diagLog } from '../utils/logger';

// expo-sharing (system share sheet for FILES) — guarded for Expo Go.
let Sharing = null;
try {
  // eslint-disable-next-line global-require
  Sharing = require('expo-sharing');
} catch (e) {
  Sharing = null;
}

// useUpdates reports a DOWNLOADED-but-not-applied update (the launch-time
// auto-check downloads silently; only a restart applies it). Guarded so
// Expo Go keeps working.
let useUpdatesHook = null;
try {
  // eslint-disable-next-line global-require
  useUpdatesHook = require('expo-updates').useUpdates;
} catch (e) {
  useUpdatesHook = null;
}

const GITHUB_URL = 'https://github.com/youmikk/media-cleaner';
const SUPPORT_EMAIL = 'support@example.com';
const VERSION = `v${APP_VERSION}`;
const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
const SIZE_SCAN_CAP = 300;
const UPDATE_CHECK_TIMEOUT_MS = 15000;

// Smart-suggestion discovery belongs to the library, not to a particular
// ProfileScreen mount. Keep it alive while the user visits another tab so a
// costly scan is saved once and the next visit can join the same work.
const smartSuggestionListeners = new Set();
let activeSmartSuggestionJob = null;
let smartSuggestionProgress = null;
let lastSmartSuggestionResult = null;

function smartSuggestionFingerprintKey(fingerprint) {
  return JSON.stringify(fingerprint || {});
}

function publishSmartSuggestionProgress(next) {
  smartSuggestionProgress = next;
  for (const listener of smartSuggestionListeners) listener(next);
}

function subscribeSmartSuggestionProgress(listener) {
  smartSuggestionListeners.add(listener);
  return () => smartSuggestionListeners.delete(listener);
}

function scanSmartSuggestions(fingerprint) {
  const fingerprintKey = smartSuggestionFingerprintKey(fingerprint);
  if (lastSmartSuggestionResult?.fingerprintKey === fingerprintKey) {
    return Promise.resolve(lastSmartSuggestionResult.data);
  }
  if (activeSmartSuggestionJob?.fingerprintKey === fingerprintKey) {
    return activeSmartSuggestionJob.promise;
  }
  if (activeSmartSuggestionJob) {
    // Only one metadata/size scan at a time. If the library changes during a
    // scan, finish saving the old fingerprint before starting the new one so
    // an older result can never overwrite the newer cache entry.
    return activeSmartSuggestionJob.promise
      .catch(() => null)
      .then(() => scanSmartSuggestions(fingerprint));
  }

  let task;
  task = (async () => {
    publishSmartSuggestionProgress({ fingerprintKey, done: 0, total: 6 });

    // 1) Largest files only needs a recent sample. Fetching the complete
    // photo and video libraries in parallel here was the main source of the
    // 5-180 second PhotoKit stalls in the iOS log.
    const recentPhotos = await getAssets(
      ALL_ALBUM_ID,
      'photo',
      SIZE_SCAN_CAP,
      'background'
    );
    const recentVideos = await getAssets(
      ALL_ALBUM_ID,
      'video',
      SIZE_SCAN_CAP,
      'background'
    );
    publishSmartSuggestionProgress({ fingerprintKey, done: 1, total: 6 });
    const pool = [
      ...recentPhotos,
      ...recentVideos,
    ];
    const sizeMap = await getAssetSizes(pool, { priority: 'background' });
    publishSmartSuggestionProgress({ fingerprintKey, done: 2, total: 6 });
    const sized = pool.map((asset) => ({
      id: asset.id,
      uri: asset.uri,
      size: sizeMap[asset.id] || 0,
      mediaType: asset.mediaType,
    }));
    const largest = sized.sort((a, b) => b.size - a.size).slice(0, 10);

    // 2) Burst groups need the complete photo timeline, but the scan is
    // serialized behind foreground media work.
    const photos =
      recentPhotos.length < SIZE_SCAN_CAP
        ? recentPhotos
        : await getAssets(ALL_ALBUM_ID, 'photo', undefined, 'background');
    const bursts = groupBursts(photos).slice(0, 30);
    const burstThumb =
      bursts.length > 0
        ? photos.find((photo) => photo.id === bursts[0].ids[0])?.uri
        : null;
    publishSmartSuggestionProgress({ fingerprintKey, done: 3, total: 6 });

    // 3) Old screenshots (90+ days untouched).
    let screenshots = [];
    const shotsAlbum = await findAlbumByTitle('Screenshots');
    if (shotsAlbum) {
      const shots = await getAssets(
        shotsAlbum.id,
        'photo',
        undefined,
        'background'
      );
      const cutoff = Date.now() - NINETY_DAYS;
      screenshots = shots
        .filter(
          (shot) =>
            (shot.modificationTime || shot.creationTime || 0) < cutoff
        )
        .map((shot) => ({ id: shot.id, uri: shot.uri }));
    }
    publishSmartSuggestionProgress({ fingerprintKey, done: 4, total: 6 });

    // 4) Duplicate videos: same duration (within 0.5 s), resolution and size.
    const videos =
      recentVideos.length < SIZE_SCAN_CAP
        ? recentVideos
        : await getAssets(ALL_ALBUM_ID, 'video', undefined, 'background');
    const videoDupes = [];
    const videoBuckets = new Map();
    for (const video of videos) {
      const key = `${Math.round((video.duration || 0) * 2)}_${video.width}x${video.height}`;
      if (!videoBuckets.has(key)) videoBuckets.set(key, []);
      videoBuckets.get(key).push(video);
    }
    const dupeCandidates = [];
    for (const members of videoBuckets.values()) {
      if (members.length >= 2) dupeCandidates.push(...members);
    }
    const dupeSizes = await getAssetSizes(dupeCandidates, {
      priority: 'background',
    });
    for (const members of videoBuckets.values()) {
      if (members.length < 2) continue;
      const bySize = new Map();
      for (const video of members) {
        const size = dupeSizes[video.id] || 0;
        if (!bySize.has(size)) bySize.set(size, []);
        bySize.get(size).push(video.id);
      }
      for (const [size, ids] of bySize.entries()) {
        if (size > 0 && ids.length >= 2) videoDupes.push({ ids });
      }
    }
    publishSmartSuggestionProgress({ fingerprintKey, done: 5, total: 6 });

    const data = {
      largest,
      bursts: bursts.map((burst) => ({ ...burst, thumb: burstThumb })),
      screenshots: screenshots.slice(0, suggestionCache.MAX_SCREENSHOTS),
      videoDupes: videoDupes.slice(
        0,
        suggestionCache.MAX_VIDEO_DUPE_GROUPS
      ),
    };
    publishSmartSuggestionProgress({ fingerprintKey, done: 6, total: 6 });
    // Save before resolving. A screen that has already blurred no longer
    // controls whether this expensive result reaches persistent storage.
    await suggestionCache.saveSuggestions(data, fingerprint);
    lastSmartSuggestionResult = { fingerprintKey, data };
    return data;
  })().finally(() => {
    if (activeSmartSuggestionJob?.promise === task) {
      activeSmartSuggestionJob = null;
    }
    if (smartSuggestionProgress?.fingerprintKey === fingerprintKey) {
      publishSmartSuggestionProgress(null);
    }
  });

  activeSmartSuggestionJob = { fingerprintKey, promise: task };
  return task;
}

function withDeadline(promise, deadline) {
  const remaining = Math.max(1, deadline - Date.now());
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('update check timed out')), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Profile: smart suggestions, storage chart, usage stats, recycle bin,
 * settings and footer.
 */
export default function ProfileScreen({ navigation }) {
  const { colors, t, settings, setSetting, isAndroid } = useSettings();
  const { stats } = useStats();
  const { favorites } = useFavorites();
  const { trash, refreshTrash } = useTrash();

  useEffect(() => {
    diagLog('profile', 'mounted');
  }, []);

  const [suggestions, setSuggestions] = useState({
    largest: [],
    bursts: [],
    screenshots: [],
    videoDupes: [],
  });
  const [expandedStat, setExpandedStat] = useState(null);
  const [analysisState, setAnalysisState] = useState(null);
  const [suggestionProgress, setSuggestionProgress] = useState(null);
  const [reviewedSuggestions, setReviewedSuggestions] = useState({
    largest: [],
    screenshots: [],
    lowQuality: [],
  });
  const analysisWasRunningRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      refreshTrash();
      let alive = true;
      Promise.all([
        suggestionStore.getReviewed('largest'),
        suggestionStore.getReviewed('screenshots'),
        suggestionStore.getReviewed('lowQuality'),
      ]).then(([largest, screenshots, lowQualityIds]) => {
        if (!alive) return;
        setReviewedSuggestions({
          largest: [...largest],
          screenshots: [...screenshots],
          lowQuality: [...lowQualityIds],
        });
      }).catch(() => {});
      return () => {
        alive = false;
      };
    }, [refreshTrash])
  );

  useEffect(() => analyzer.subscribe((next) => {
    setAnalysisState(next);
    if (next?.running) analysisWasRunningRef.current = true;
  }), []);

  // Real gallery size, measured off the system index. It used to come from
  // stats.originalSizeBytes, which is only written when a cleaning session
  // FINISHES and even then holds one album's extrapolated estimate — so a
  // user who had not finished a session saw "0 B", and on Android the
  // sampled estimate behind it read 0 anyway.
  const [librarySize, setLibrarySize] = useState(null);
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      // Same reason as the caches below: let the tab transition paint first.
      const timer = setTimeout(() => {
        getLibrarySize()
          .then((size) => {
            if (alive && size && size.bytes > 0) setLibrarySize(size);
          })
          .catch(() => {});
      }, 500);
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }, [])
  );

  // "Original" = what the library would weigh if we had deleted nothing.
  // Persisted as the lifetime reference so builds without the native query
  // (Expo Go, older binaries) still have a number to show.
  const measuredOriginal =
    librarySize && librarySize.bytes > 0
      ? librarySize.bytes + (stats.spaceSavedBytes || 0)
      : 0;
  useEffect(() => {
    if (measuredOriginal > 0) {
      statsManager.setOriginalSize(measuredOriginal).catch(() => {});
    }
  }, [measuredOriginal]);

  // Low-quality photos AND exact duplicates come from the chunked
  // analyzer's cached metrics.
  const [lowQuality, setLowQuality] = useState({ ids: [], thumb: null });
  const [photoDupes, setPhotoDupes] = useState({ groups: [], thumb: null });
  const loadAnalysisCache = useCallback(async (isAlive = () => true) => {
    const cache = await analyzer.getCached(ALL_ALBUM_ID, 'photo');
    if (!isAlive()) return;
    if (!cache) {
      setLowQuality({ ids: [], thumb: null });
      setPhotoDupes({ groups: [], thumb: null });
      if (settings.similarDetection && !analysisState?.running) {
        analyzer.analyzeAlbum(ALL_ALBUM_ID, { mediaType: 'photo' });
      }
      return;
    }
    const processed = await suggestionStore.getReviewed('lowQuality');
    if (!isAlive()) return;
    const ids = (cache.lowQuality || [])
      .map((item) => item.id)
      .filter((id) => !processed.has(id));
    let thumb = null;
    if (ids.length > 0) {
      const first = await getAssetsByIds(ids.slice(0, 1));
      thumb = first[0]?.uri || null;
    }
    if (isAlive()) setLowQuality({ ids, thumb });
    if (cache.duplicates) {
      let dupeThumb = null;
      if (cache.duplicates.length > 0) {
        const first = await getAssetsByIds(cache.duplicates[0].slice(0, 1));
        dupeThumb = first[0]?.uri || null;
      }
      if (isAlive()) setPhotoDupes({ groups: cache.duplicates, thumb: dupeThumb });
    }
  }, [analysisState?.running, settings.similarDetection]);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      // Let the tab transition PAINT first — parsing the (multi-MB)
      // analysis cache synchronously during the switch blanks the screen
      // on slower Androids.
      const timer = setTimeout(() => {
        if (alive) loadAnalysisCache(() => alive).catch(() => {});
      }, 400);
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }, [loadAnalysisCache])
  );

  useEffect(() => {
    if (!analysisState?.running && analysisWasRunningRef.current) {
      analysisWasRunningRef.current = false;
      loadAnalysisCache().catch(() => {});
    }
  }, [analysisState?.running, loadAnalysisCache]);

  // ---- Smart suggestions (cached by the actual library fingerprint) ----
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      let fingerprint = null;
      let fingerprintKey = null;
      const unsubscribe = subscribeSmartSuggestionProgress((next) => {
        if (!alive) return;
        if (next && next.fingerprintKey !== fingerprintKey) return;
        setSuggestionProgress(
          next ? { done: next.done, total: next.total } : null
        );
      });
      const timer = setTimeout(() => {
        (async () => {
          try {
            // Paint first; an uncached rescan performs full metadata fetches
            // plus hundreds of native size lookups.
            fingerprint = await suggestionCache.getLibraryFingerprint();
            fingerprintKey = smartSuggestionFingerprintKey(fingerprint);
            if (!alive) return;
            const cached = await suggestionCache.getSuggestions(fingerprint);
            if (cached) {
              setSuggestions(cached);
              setSuggestionProgress(null);
              return;
            }
            const active = smartSuggestionProgress;
            if (active?.fingerprintKey === fingerprintKey) {
              setSuggestionProgress({ done: active.done, total: active.total });
            }
            const data = await scanSmartSuggestions(fingerprint);
            if (!alive) return;
            setSuggestions(data);
          } catch (e) {
            // Permissions or I/O issue: keep the previous suggestions.
          } finally {
            if (alive) setSuggestionProgress(null);
          }
        })();
      }, 600);
      return () => {
        alive = false;
        clearTimeout(timer);
        unsubscribe();
      };
    }, [])
  );

  // ---- Update check: OTA first (silent hot update), then GitHub APK ----
  const updatesState = useUpdatesHook ? useUpdatesHook() : {};
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const onCheckUpdate = async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    const deadline = Date.now() + UPDATE_CHECK_TIMEOUT_MS;
    try {
      let ota = await withDeadline(checkOTA(), deadline);
      // Launch auto-check already downloaded it? Then the server says
      // "nothing newer" but a restart IS pending — treat as ready.
      if (ota !== 'applied' && updatesState.isUpdatePending) ota = 'applied';
      if (ota === 'applied') {
        // Show the changelog (from the repo) above the restart choice.
        let body = t('update_ota_ready');
        try {
          const log = await withDeadline(fetchLatestChangelog(), deadline);
          if (log && Array.isArray(log.notes) && log.notes.length > 0) {
            body = `${log.notes.map((n) => `• ${n}`).join('\n')}\n\n${t(
              'update_ota_ready'
            )}`;
          }
        } catch (e) {
          // changelog unavailable — generic message
        }
        showAppAlert(t('check_update'), body, [
          { text: t('cancel'), style: 'cancel' },
          {
            text: t('update_restart'),
            // Delay past the dialog dismissal — reloadAsync races the
            // closing dialog on Android and silently fails otherwise.
            onPress: () =>
              setTimeout(async () => {
                const ok = await reloadWithUpdate();
                if (!ok) {
                  showAppAlert(t('check_update'), t('update_restart_manual'));
                }
              }, 400),
          },
        ]);
        return;
      }
      const info = await withDeadline(checkGitHubRelease(), deadline);
      if (info.hasUpdate) {
        // GitHub downloads crawl (or stall outright) on mainland networks,
        // so the accelerated link is offered first and the direct one kept
        // as the fallback for anyone the proxy fails.
        const buttons = [{ text: t('cancel'), style: 'cancel' }];
        if (canMirror(info.url)) {
          buttons.push({
            text: t('update_download_mirror'),
            onPress: () => Linking.openURL(mirrorUrl(info.url)),
          });
        }
        buttons.push({
          text: t('update_download'),
          onPress: () => Linking.openURL(info.url),
        });
        showAppAlert(t('update_available', { version: info.version }), '', buttons);
      } else {
        diagLog('update', `manual check: current ${APP_VERSION} is latest`);
        showAppAlert(t('check_update'), t('update_latest'));
      }
    } catch (e) {
      diagLog('update', `manual check failed: ${(e && e.message) || e}`);
      showAppAlert(t('check_update'), t('update_check_failed'));
    } finally {
      setCheckingUpdate(false);
    }
  };

  // ---- Cache housekeeping ----------------------------------------------
  // Size is computed ON TAP, never on render: reading it pulls the whole
  // analysis cache (megabytes) through JSON, which is exactly the kind of
  // work that makes this screen janky.
  const [clearingCache, setClearingCache] = useState(false);
  const onClearCache = async () => {
    if (clearingCache) return;
    setClearingCache(true);
    let info = { bytes: 0, entries: 0 };
    try {
      info = await cacheManager.getCacheSize();
    } catch (e) {
      info = { bytes: 0, entries: 0 };
    }
    setClearingCache(false);
    if (info.entries === 0) {
      showAppAlert(t('clear_cache'), t('clear_cache_none'));
      return;
    }
    showAppAlert(
      t('clear_cache'),
      t('clear_cache_message', { size: formatBytes(info.bytes) }),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('clear_cache_confirm'),
          style: 'destructive',
          onPress: async () => {
            setClearingCache(true);
            const freed = await cacheManager.clearCaches();
            setClearingCache(false);
            showAppAlert(
              t('clear_cache'),
              t('clear_cache_done', { size: formatBytes(freed.bytes) })
            );
          },
        },
      ]
    );
  };

  const onExportLog = async () => {
    try {
      const uri = await getLogFileUri();
      if (Sharing && (await Sharing.isAvailableAsync())) {
        await Sharing.shareAsync(uri, { mimeType: 'text/plain' });
      } else if (Platform.OS === 'ios') {
        await Share.share({ url: uri });
      } else {
        // last resort: share the tail as text
        const FileSystem = require('expo-file-system/legacy');
        const content = await FileSystem.readAsStringAsync(uri);
        await Share.share({ message: content.slice(-8000) });
      }
    } catch (e) {
      // user dismissed the sheet / sharing unavailable
    }
  };

  // ---- Settings handlers ----
  const scheduleReminder = async (hour) => {
    const ok = await enableDailyReminder(t, hour, 0);
    if (!ok) {
      showAppAlert(t('setting_reminder'), t('permission_denied'));
      return false;
    }
    return true;
  };

  const onToggleReminder = async (value) => {
    if (value) {
      if (!(await scheduleReminder(settings.reminderHour || 19))) return;
    } else {
      await disableDailyReminder();
    }
    setSetting('dailyReminder', value);
  };

  const onReminderHourChange = async (value) => {
    setSetting('reminderHour', value);
    if (settings.dailyReminder) await scheduleReminder(value);
  };

  const onDeleteModeChange = (value) => {
    if (value === settings.recycleBin) return;
    showAppAlert(
      t('delete_mode_warning_title'),
      t(value ? 'delete_mode_warning_recycle' : 'delete_mode_warning_direct'),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('create'),
          onPress: () => setSetting('recycleBin', value),
        },
      ]
    );
  };

  const cleanAssets = (assetIds, title, sizesById = null, suggestionKey = null) => {
    navigation.navigate('SmartCleaning', {
      albumId: ALL_ALBUM_ID,
      albumTitle: title,
      assetIds,
      sizesById,
      suggestionKey,
    });
  };

  const Section = ({ title, children }) => (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{title}</Text>
      {children}
    </View>
  );

  // Settings used to be one 11-row card mixing group sizes, playback, delete
  // mode, reminders and appearance — impossible to scan. SubGroup breaks it
  // into captioned cards so related switches sit together.
  const SubGroup = ({ title, children }) => (
    <View style={styles.subGroup}>
      <Text style={[styles.subGroupTitle, { color: colors.subtext }]}>
        {title}
      </Text>
      <View style={[styles.settingsCard, { backgroundColor: colors.card }]}>
        {children}
      </View>
    </View>
  );

  const ToggleRow = ({ label, value, onChange, divider = true }) => (
    <SettingsRow
      title={label}
      divider={divider}
      accessory={null}
      compact
      trailing={
        <AppSwitch
          value={value}
          onValueChange={onChange}
          label={label}
        />
      }
    />
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

  // Suggestions the user has already been through are dropped from the
  // cards. The ids are recorded by CleaningScreen when a group is confirmed
  // (kept photos included) — otherwise the very same "10 largest files" came
  // back on the next visit, since the daily suggestion cache is unaware that
  // anything was reviewed. lowQuality is filtered where it is loaded, because
  // its thumbnail is resolved from the surviving ids.
  const visibleSuggestions = useMemo(() => {
    const drop = (list, reviewed) => {
      if (!reviewed || reviewed.length === 0) return list;
      const seen = new Set(reviewed);
      return list.filter((item) => !seen.has(item.id));
    };
    return {
      largest: drop(suggestions.largest || [], reviewedSuggestions.largest),
      screenshots: drop(
        suggestions.screenshots || [],
        reviewedSuggestions.screenshots
      ),
    };
  }, [suggestions.largest, suggestions.screenshots, reviewedSuggestions]);

  // Analysis progress for the low-quality card: that suggestion is the only
  // one that has to wait on the pixel analyser, so without a bar it just
  // reads "needs analysis" for several minutes with no sign of life.
  const lowQualityProgress =
    analysisState?.running && analysisState.mediaType !== 'video'
      ? {
          label: t('analyzing_short'),
          done: analysisState.done || 0,
          total: analysisState.total || 0,
        }
      : null;
  const activeSuggestionProgress = suggestionProgress
    ? { ...suggestionProgress, label: t('analyzing_short') }
    : lowQualityProgress;

  const suggestionCards = [
    {
      key: 'largest',
      thumb: visibleSuggestions.largest[0]?.uri,
      node: (
        <SuggestionCard
          icon="albums-outline"
          title={t('suggestion_largest')}
          description={t('suggestion_largest_desc')}
          thumbnailUri={visibleSuggestions.largest[0]?.uri}
          count={visibleSuggestions.largest.length}
          progress={activeSuggestionProgress}
          onClean={() => cleanAssets(visibleSuggestions.largest.map((a) => a.id), t('suggestion_largest'), Object.fromEntries(visibleSuggestions.largest.map((a) => [a.id, a.size])), 'largest')}
        />
      ),
    },
    {
      key: 'burst',
      thumb: suggestions.bursts[0]?.thumb,
      node: (
        <SuggestionCard
          icon="camera-outline"
          title={t('suggestion_burst')}
          description={t('suggestion_burst_desc')}
          thumbnailUri={suggestions.bursts[0]?.thumb}
          count={suggestions.bursts.length}
          progress={activeSuggestionProgress}
          onClean={() => navigation.navigate('BurstClean', { groups: suggestions.bursts.map((b) => ({ ids: b.ids })) })}
        />
      ),
    },
    {
      key: 'screenshots',
      thumb: visibleSuggestions.screenshots[0]?.uri,
      node: (
        <SuggestionCard
          icon="phone-portrait-outline"
          title={t('suggestion_screenshots')}
          description={t('suggestion_screenshots_desc')}
          thumbnailUri={visibleSuggestions.screenshots[0]?.uri}
          count={visibleSuggestions.screenshots.length}
          progress={activeSuggestionProgress}
          onClean={() => cleanAssets(visibleSuggestions.screenshots.map((a) => a.id), t('suggestion_screenshots'), null, 'screenshots')}
        />
      ),
    },
    {
      key: 'dupes',
      thumb: photoDupes.thumb,
      node: (
        <SuggestionCard
          icon="copy-outline"
          title={t('suggestion_dupes')}
          description={photoDupes.groups.length > 0 ? t('suggestion_dupes_desc') : t('lowquality_need_analysis')}
          thumbnailUri={photoDupes.thumb}
          count={photoDupes.groups.length}
          progress={activeSuggestionProgress}
          onClean={() => navigation.navigate('BurstClean', { groups: photoDupes.groups.map((ids) => ({ ids })), mode: 'duplicate' })}
        />
      ),
    },
    {
      key: 'video-dupes',
      thumb: null,
      node: (
        <SuggestionCard
          icon="film-outline"
          title={t('suggestion_video_dupes')}
          description={t('suggestion_video_dupes_desc')}
          thumbnailUri={null}
          count={(suggestions.videoDupes || []).length}
          progress={activeSuggestionProgress}
          onClean={() => navigation.navigate('BurstClean', { groups: suggestions.videoDupes, mode: 'duplicate' })}
        />
      ),
    },
    {
      key: 'low-quality',
      thumb: lowQuality.thumb,
      node: (
        <SuggestionCard
          icon="eye-off-outline"
          title={t('suggestion_lowquality')}
          description={lowQuality.ids.length > 0 ? t('suggestion_lowquality_desc') : t('lowquality_need_analysis')}
          thumbnailUri={lowQuality.thumb}
          count={lowQuality.ids.length}
          progress={activeSuggestionProgress}
          onClean={() => cleanAssets(lowQuality.ids.slice(0, 500), t('suggestion_lowquality'), null, 'lowQuality')}
        />
      ),
    },
    // Keep authored order stable. Re-sorting as thumbnails arrive changes
    // child positions during a horizontal gesture and snaps the list to item 1.
  ];

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
      >
        <Text style={[styles.header, { color: colors.text }]}>
          {t('profile_title')}
        </Text>

        {/* Smart suggestions */}
        <Section title={t('suggestions_title')}>
          <ScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator={false}
          >
            {suggestionCards.map(({ key, node }) => React.cloneElement(node, { key }))}
          </ScrollView>
        </Section>

        {/* Tools: photography profile & compressor */}
        <Section title={t('tools_title')}>
          <View style={[styles.listCard, { backgroundColor: colors.card }]}>
            <SettingsRow
              icon="heart-outline"
              iconColor={colors.heart}
              title={t('my_favorites')}
              value={String(Object.keys(favorites || {}).length)}
              onPress={() => navigation.navigate('Favorites')}
            />
            <SettingsRow
              icon="analytics-outline"
              title={t('insights_title')}
              subtitle={t('insights_desc')}
              onPress={() => navigation.navigate('Insights')}
            />
            <SettingsRow
              icon="archive-outline"
              title={t('compress_title')}
              subtitle={t('compress_desc')}
              onPress={() => navigation.navigate('Compress')}
            />
            <SettingsRow
              icon="refresh-outline"
              title={checkingUpdate ? t('update_checking') : t('check_update')}
              value={VERSION}
              onPress={onCheckUpdate}
              disabled={checkingUpdate}
              accessory={checkingUpdate ? null : 'chevron'}
              trailing={
                checkingUpdate ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : null
              }
            />
            <SettingsRow
              icon="document-text-outline"
              title={t('export_log')}
              subtitle={t('export_log_desc')}
              onPress={onExportLog}
              accessory="share"
            />
            <SettingsRow
              icon="trash-bin-outline"
              title={clearingCache ? t('clear_cache_working') : t('clear_cache')}
              subtitle={t('clear_cache_desc')}
              onPress={onClearCache}
              disabled={clearingCache}
              divider={false}
              accessory={clearingCache ? null : 'chevron'}
              trailing={
                clearingCache ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : null
              }
            />
          </View>
        </Section>

        {/* Storage comparison */}
        <Section title={t('storage_title')}>
          <StorageChart
            savedBytes={stats.spaceSavedBytes}
            originalBytes={measuredOriginal || stats.originalSizeBytes}
          />
        </Section>

        {/* Usage statistics */}
        <Section title={t('stats_title')}>
          <View style={styles.statRow}>
            {statCards.map((card) => (
              <Pressable
                key={card.key}
                accessibilityRole="button"
                accessibilityState={{ expanded: expandedStat === card.key }}
                style={({ pressed }) => [
                  styles.statCard,
                  {
                    backgroundColor: pressed ? colors.chartTrack : colors.card,
                  },
                ]}
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
            <View style={[styles.listCard, { backgroundColor: colors.card }]}>
              <SettingsRow
                icon="trash-bin-outline"
                title={t('recycle_bin')}
                value={String(trash.length)}
                divider={false}
                onPress={() => navigation.navigate('RecycleBin')}
              />
            </View>
          </Section>
        )}

        {/* Settings */}
        <Section title={t('settings_title')}>
          <SubGroup title={t('settings_group_cleaning')}>
            <OptionPicker
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
              divider={false}
            />
          </SubGroup>

          {!isAndroid && (
            <SubGroup title={t('settings_group_playback')}>
              <ToggleRow
                label={t('setting_live_autoplay')}
                value={settings.liveAutoplay}
                onChange={(v) => setSetting('liveAutoplay', v)}
              />
              <ToggleRow
                label={t('setting_live_muted')}
                value={settings.liveMuted !== false}
                onChange={(v) => setSetting('liveMuted', v)}
                divider={false}
              />
            </SubGroup>
          )}

          {isAndroid && (
            <SubGroup title={t('settings_group_deletion')}>
              <DeletionModePicker
                value={settings.recycleBin}
                onChange={onDeleteModeChange}
              />
            </SubGroup>
          )}

          <SubGroup title={t('settings_group_reminder')}>
            <ToggleRow
              label={t('setting_reminder')}
              value={settings.dailyReminder}
              onChange={onToggleReminder}
              divider={settings.dailyReminder}
            />
            {settings.dailyReminder && (
              <OptionPicker
                label={t('setting_reminder_time')}
                value={settings.reminderHour || 19}
                onChange={onReminderHourChange}
                options={[8, 12, 18, 19, 20, 21].map((hour) => ({
                  value: hour,
                  label: `${String(hour).padStart(2, '0')}:00`,
                }))}
                divider={false}
              />
            )}
          </SubGroup>

          <SubGroup title={t('settings_group_appearance')}>
            <OptionPicker
              label={t('setting_theme')}
              value={settings.theme}
              onChange={(v) => setSetting('theme', v)}
              options={[
                { value: 'system', label: t('theme_system') },
                { value: 'light', label: t('theme_light') },
                { value: 'dark', label: t('theme_dark') },
              ]}
            />
            <OptionPicker
              label={t('setting_language')}
              value={settings.language || 'system'}
              onChange={(v) => setSetting('language', v)}
              options={[
                { value: 'system', label: t('follow_system') },
                ...LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
              ]}
              divider={false}
            />
          </SubGroup>
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
  subGroup: { marginBottom: 14 },
  subGroupTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginBottom: 6,
    marginLeft: 4,
  },
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
  listCard: { borderRadius: 12, overflow: 'hidden' },
  settingsCard: { borderRadius: 12, paddingHorizontal: 14 },
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
