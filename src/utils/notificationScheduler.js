import * as Notifications from 'expo-notifications';
import { ensureNotificationPermission } from './permissions';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/**
 * Enable the daily cleanup reminder at the user's chosen local hour.
 * Returns true when scheduled, false when permission was denied.
 */
export async function enableDailyReminder(t, hour = 19, minute = 0) {
  const granted = await ensureNotificationPermission();
  if (!granted) return false;
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
}

export async function disableDailyReminder() {
  await Notifications.cancelAllScheduledNotificationsAsync();
}
