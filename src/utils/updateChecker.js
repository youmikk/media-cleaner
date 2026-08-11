import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

export const APP_VERSION = '1.20.0';
const REPO = 'youmikk/media-cleaner';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const LAST_CHECK_KEY = '@mediacleaner/last_update_check';
const UPDATE_ID_KEY = '@mediacleaner/last_update_id';
const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // silent auto-check once a day
const NET_TIMEOUT = 5000;

// api.github.com is slow or outright unreachable from mainland China, and an
// update check that hangs is the same as no update check. So: try the API
// briefly (it is the only source that knows the exact .apk asset URL), then
// fall back to a tiny manifest committed to the repo and served by a CDN
// that IS reachable there — the same jsDelivr path the changelog already
// uses successfully.
const RELEASE_URLS = [
  `https://cdn.jsdelivr.net/gh/${REPO}@main/release.json`,
  `https://raw.githubusercontent.com/${REPO}/main/release.json`,
];

// Download accelerators. Release assets are NOT served by jsDelivr, so a
// generic proxy is the only option for them. More than one because these
// come and go.
const DOWNLOAD_MIRRORS = [
  'https://ghproxy.net/',
  'https://gh-proxy.com/',
];

/** True when a mirrored download is worth offering for this url. */
export function canMirror(url) {
  return !!url && /^https:\/\/github\.com\//.test(url);
}

/** Same asset through a China-friendly proxy. */
export function mirrorUrl(url, index = 0) {
  if (!canMirror(url)) return url;
  const prefix = DOWNLOAD_MIRRORS[index] || DOWNLOAD_MIRRORS[0];
  return prefix + url;
}

/**
 * fetch + JSON with a hard deadline. Without the timeout a blocked host
 * leaves the check pending until the OS gives up, which on the settings
 * screen looks like the button is simply broken.
 */
async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NET_TIMEOUT);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null; // offline, blocked, rate-limited or timed out
  } finally {
    clearTimeout(timer);
  }
}

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
    // Only fetch after a positive availability check. Calling fetch after a
    // negative result races the native update controller and can make a later
    // manual check miss an available update.
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
 * True EXACTLY ONCE after a new JS bundle became active, then false again.
 *
 * Keyed on the running bundle's updateId rather than a flag set before
 * reloadAsync, because an OTA can also land without us doing anything:
 * expo-updates downloads at launch and activates on the NEXT start, with no
 * code of ours in between. Comparing ids catches both routes.
 *
 * The very first run only records the id — a fresh install is not an update.
 */
export async function consumeUpdateApplied() {
  try {
    // null while the embedded bundle is running (no OTA active, Expo Go).
    const current = String((Updates && Updates.updateId) || 'embedded');
    const seen = await AsyncStorage.getItem(UPDATE_ID_KEY);
    if (seen !== current) await AsyncStorage.setItem(UPDATE_ID_KEY, current);
    if (!seen) return false;
    return seen !== current;
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
  `https://cdn.jsdelivr.net/gh/${REPO}@main/CHANGELOG.json`,
  `https://raw.githubusercontent.com/${REPO}/main/CHANGELOG.json`,
];

export async function fetchLatestChangelog() {
  for (const url of CHANGELOG_URLS) {
    // eslint-disable-next-line no-await-in-loop
    const list = await fetchJson(url, { 'Cache-Control': 'no-cache' });
    if (Array.isArray(list) && list.length > 0 && list[0].notes) {
      return list[0];
    }
  }
  return null;
}

/**
 * B) New-package check against GitHub Releases.
 * Returns { hasUpdate, version, url } — url prefers the platform's install
 * package and falls back to the release page. Pair it with mirrorUrl() when
 * offering the actual download.
 */
export async function checkGitHubRelease(platform = Platform.OS) {
  // The API is the only source that knows the exact asset URL, so it goes
  // first — but on a short leash, because it is also the one most likely to
  // hang from mainland China.
  const release = await fetchJson(RELEASES_API, {
    Accept: 'application/vnd.github+json',
  });
  if (release && (release.tag_name || release.name)) {
    const version = release.tag_name || release.name || '';
    const extension =
      platform === 'ios' ? '.ipa' : platform === 'android' ? '.apk' : null;
    const packageAsset = extension
      ? (release.assets || []).find((a) =>
          (a.name || '').toLowerCase().endsWith(extension)
        )
      : null;
    return {
      // Do not offer an Android-only release to iOS (or vice versa).
      hasUpdate: isNewer(version, APP_VERSION) && (!extension || !!packageAsset),
      version,
      url:
        (packageAsset && packageAsset.browser_download_url) ||
        release.html_url,
    };
  }

  // API blocked or rate-limited: the committed manifest still answers "is
  // there a newer version", which is the part the user needs to know. It
  // cannot name the asset (the filename carries a build number), so this
  // path points at the release page instead.
  for (const url of RELEASE_URLS) {
    // eslint-disable-next-line no-await-in-loop
    const manifest = await fetchJson(url, { 'Cache-Control': 'no-cache' });
    if (manifest && manifest.version) {
      const tag = manifest.tag || `v${manifest.version}`;
      return {
        hasUpdate: isNewer(manifest.version, APP_VERSION),
        version: tag,
        url: `https://github.com/${REPO}/releases/tag/${tag}`,
      };
    }
  }
  throw new Error('update check unreachable');
}

/**
 * Silent daily auto-check (call on app launch). Invokes `onUpdate(info)`
 * only when a newer release exists. Never throws.
 */
export async function autoCheckDaily(onUpdate, platform = Platform.OS) {
  try {
    const last = parseInt(
      (await AsyncStorage.getItem(LAST_CHECK_KEY)) || '0',
      10
    );
    const now = new Date().getTime();
    if (now - last < CHECK_INTERVAL) return;
    const info = await checkGitHubRelease(platform);
    // Only record a completed request. Previously a temporary offline or
    // GitHub-rate-limit failure suppressed all automatic checks for 24 hours.
    await AsyncStorage.setItem(LAST_CHECK_KEY, String(now));
    if (info.hasUpdate && onUpdate) onUpdate(info);
  } catch (e) {
    // offline / rate-limited — try again another day
  }
}
