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
    // The launch-time auto-check may have ALREADY downloaded the newest
    // update — the server then reports "nothing newer", but a restart is
    // still needed. Surface that as ready-to-apply instead of "latest".
    try {
      const fetched = await Updates.fetchUpdateAsync();
      if (fetched && fetched.isNew) return 'applied';
    } catch (e) {
      // nothing pending
    }
    return 'none';
  } catch (e) {
    return 'unavailable';
  }
}

/**
 * Apply the fetched update. Returns true when the reload was accepted.
 * (On Android, reloadAsync silently fails if invoked while an Alert is
 * still dismissing — callers should delay slightly and check the result.)
 */
export async function reloadWithUpdate() {
  if (!Updates || !Updates.reloadAsync) return false;
  try {
    await Updates.reloadAsync();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Latest changelog entry from the repo (CHANGELOG.json). Tried via the
 * jsDelivr CDN first (reachable in China), then GitHub raw. Returns
 * { date, notes: [...] } or null — callers fall back to a generic message.
 */
const CHANGELOG_URLS = [
  'https://cdn.jsdelivr.net/gh/youmikk/media-cleaner@main/CHANGELOG.json',
  'https://raw.githubusercontent.com/youmikk/media-cleaner/main/CHANGELOG.json',
];

export async function fetchLatestChangelog() {
  for (const url of CHANGELOG_URLS) {
    try {
      const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) continue;
      const list = await res.json();
      if (Array.isArray(list) && list.length > 0 && list[0].notes) {
        return list[0];
      }
    } catch (e) {
      // try the next mirror
    }
  }
  return null;
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
