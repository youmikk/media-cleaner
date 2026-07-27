import * as MediaLibrary from 'expo-media-library';
import * as Notifications from 'expo-notifications';

/**
 * Request media-library permission. Returns 'granted' | 'denied' | 'limited'.
 */
export async function ensureMediaPermission() {
  const current = await MediaLibrary.getPermissionsAsync();
  if (current.granted) return current.accessPrivileges === 'limited' ? 'limited' : 'granted';
  const asked = await MediaLibrary.requestPermissionsAsync();
  if (asked.granted) return asked.accessPrivileges === 'limited' ? 'limited' : 'granted';
  return 'denied';
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
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}
