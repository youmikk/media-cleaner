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
 * Enable the daily cleanup reminder: picks a random time between 8:00 and
 * 20:00 and schedules a repeating daily local notification.
 * Returns true when scheduled, false when permission was denied.
 */
export async function enableDailyReminder(t) {
  const granted = await ensureNotificationPermission();
  if (!granted) return false;
  await Notifications.cancelAllScheduledNotificationsAsync();
  const hour = 8 + Math.floor(Math.random() * 12); // 8..19
  const minute = Math.floor(Math.random() * 60);
  await Notifications.scheduleNotificationAsync({
    content: {
      title: t('reminder_notif_title'),
      body: t('reminder_notif_body'),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour,
      minute,
    },
  });
  return true;
}

export async function disableDailyReminder() {
  await Notifications.cancelAllScheduledNotificationsAsync();
}
