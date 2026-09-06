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
 * Enable one reminder per day inside the user's chosen local time window.
 * Seven weekly triggers allow a different time on each weekday while staying
 * scheduled indefinitely without a background task.
 * Returns true when scheduled, false when permission was denied.
 */
export async function enableDailyReminder(
  t,
  startMinute = 18 * 60,
  endMinute = 21 * 60
) {
  if (!Notifications?.scheduleNotificationAsync) return false;
  const granted = await ensureNotificationPermission();
  if (!granted) return false;
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
    const normalize = (value) =>
      ((Math.round(Number(value) || 0) % 1440) + 1440) % 1440;
    const start = normalize(startMinute);
    const end = normalize(endMinute);
    const span = (end - start + 1440) % 1440;
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      const offset = span > 0 ? Math.floor(Math.random() * (span + 1)) : 0;
      const minuteOfDay = (start + offset) % 1440;
      // eslint-disable-next-line no-await-in-loop
      await Notifications.scheduleNotificationAsync({
        content: {
          title: t('reminder_notif_title'),
          body: t('reminder_notif_body'),
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
          weekday,
          hour: Math.floor(minuteOfDay / 60),
          minute: minuteOfDay % 60,
        },
      });
    }
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
