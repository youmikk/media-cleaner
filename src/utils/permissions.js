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
 * Request notification permission only when the daily reminder is enabled.
 */
export async function ensureNotificationPermission() {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}
