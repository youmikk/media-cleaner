import { ensureNotificationPermission } from './permissions';

let Notifications = null;
try {
  // eslint-disable-next-line global-require
  Notifications = require('expo-notifications');
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
} catch (e) {
  Notifications = null;
}

/**
 * Enable the daily cleanup reminder at the user's chosen local hour.
 * Returns true when scheduled, false when permission was denied.
 */
export async function enableDailyReminder(t, hour = 19, minute = 0) {
  if (!Notifications?.scheduleNotificationAsync) return false;
  const granted = await ensureNotificationPermission();
  if (!granted) return false;
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
    const safeHour = Math.max(0, Math.min(23, Number(hour) || 0));
    const safeMinute = Math.max(0, Math.min(59, Number(minute) || 0));
    await Notifications.scheduleNotificationAsync({
      content: {
        title: t('reminder_notif_title'),
        body: t('reminder_notif_body'),
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: safeHour,
        minute: safeMinute,
      },
    });
    return true;
  } catch (e) {
    return false;
  }
}

export async function disableDailyReminder() {
  if (!Notifications?.cancelAllScheduledNotificationsAsync) return;
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch (e) {
    // Best effort: the setting can still be disabled when native scheduling
    // is unavailable in Expo Go or an older binary.
  }
}
