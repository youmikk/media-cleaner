import AsyncStorage from '@react-native-async-storage/async-storage';

export const APP_VERSION = '1.0.0';
const RELEASES_API =
  'https://api.github.com/repos/youmikk/media-cleaner/releases/latest';
const LAST_CHECK_KEY = '@mediacleaner/last_update_check';
const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // silent auto-check once a day

// expo-updates is a native module — absent in Expo Go; guard the import.
let Updates = null;
try {
  // eslint-disable-next-line global-require
  Updates = require('expo-updates');
} catch (e) {
  Updates = null;
}

function parseVersion(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

function isNewer(remote, local) {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

/**
 * A) OTA hot update via expo-updates (EAS Update).
 * Returns 'applied' (update fetched — call Updates.reloadAsync next),
 * 'none' (already current) or 'unavailable' (Expo Go / dev).
 */
export async function checkOTA() {
  if (!Updates || !Updates.checkForUpdateAsync) return 'unavailable';
  try {
    if (Updates.isEmbeddedLaunch === undefined && !Updates.channel) {
      // running in Expo Go / dev client without update config
      return 'unavailable';
    }
    const result = await Updates.checkForUpdateAsync();
    if (result.isAvailable) {
      await Updates.fetchUpdateAsync();
      return 'applied';
    }
    return 'none';
  } catch (e) {
    return 'unavailable';
  }
}

export async function reloadWithUpdate() {
  if (Updates && Updates.reloadAsync) await Updates.reloadAsync();
}

/**
 * B) New-APK check against GitHub Releases.
 * Returns { hasUpdate, version, url } — url prefers the APK asset,
 * falling back to the release page.
 */
export async function checkGitHubRelease() {
  const res = await fetch(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const release = await res.json();
  const version = release.tag_name || release.name || '';
  const apk = (release.assets || []).find((a) =>
    (a.name || '').toLowerCase().endsWith('.apk')
  );
  return {
    hasUpdate: isNewer(version, APP_VERSION),
    version,
    url: (apk && apk.browser_download_url) || release.html_url,
  };
}

/**
 * Silent daily auto-check (call on app launch). Invokes `onUpdate(info)`
 * only when a newer release exists. Never throws.
 */
export async function autoCheckDaily(onUpdate) {
  try {
    const last = parseInt(
      (await AsyncStorage.getItem(LAST_CHECK_KEY)) || '0',
      10
    );
    const now = new Date().getTime();
    if (now - last < CHECK_INTERVAL) return;
    await AsyncStorage.setItem(LAST_CHECK_KEY, String(now));
    const info = await checkGitHubRelease();
    if (info.hasUpdate && onUpdate) onUpdate(info);
  } catch (e) {
    // offline / rate-limited — try again another day
  }
}
