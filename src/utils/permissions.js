import * as MediaLibrary from 'expo-media-library';

let Notifications = null;
try {
  // Notifications are unavailable in Expo Go on Android 13+ and may also be
  // absent from an older installed binary receiving a newer JS bundle.
  // eslint-disable-next-line global-require
  Notifications = require('expo-notifications');
} catch (e) {
  Notifications = null;
}

/**
 * Request media-library permission. Returns 'granted' | 'denied' | 'limited'.
 */
export async function ensureMediaPermission() {
  try {
    const current = await MediaLibrary.getPermissionsAsync();
    if (current.granted) return current.accessPrivileges === 'limited' ? 'limited' : 'granted';
    const asked = await MediaLibrary.requestPermissionsAsync();
    if (asked.granted) return asked.accessPrivileges === 'limited' ? 'limited' : 'granted';
    return asked.canAskAgain === false ? 'blocked' : 'denied';
  } catch (e) {
    return 'denied';
  }
}

/**
 * Read the CURRENT media-library permission without prompting.
 * Returns 'granted' | 'limited' | 'undetermined' | 'blocked' — 'blocked'
 * meaning the system will no longer show a dialog, so the only way forward
 * is the settings app.
 */
export async function getMediaPermission() {
  try {
    const current = await MediaLibrary.getPermissionsAsync();
    if (current.granted) {
      return current.accessPrivileges === 'limited' ? 'limited' : 'granted';
    }
    return current.canAskAgain === false ? 'blocked' : 'undetermined';
  } catch (e) {
    return 'undetermined';
  }
}

/**
 * Request notification permission only when the daily reminder is enabled.
 */
export async function ensureNotificationPermission() {
  if (!Notifications?.getPermissionsAsync || !Notifications?.requestPermissionsAsync) {
    return false;
  }
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    const asked = await Notifications.requestPermissionsAsync();
    return asked.granted;
  } catch (e) {
    return false;
  }
}
