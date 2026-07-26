import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import { getAssets, ALL_ALBUM_ID } from '../utils/albumHelpers';

/**
 * 摄影画像 / Photography Profile — shooting-habit analytics computed from
 * asset metadata only (fast, no pixel work): totals, hour-of-day
 * distribution, busiest weekday & month, daily average.
 */
export default function GalleryInsightsScreen({ navigation }) {
  const { colors, t, language } = useSettings();
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [photos, videos] = await Promise.all([
          getAssets(ALL_ALBUM_ID, 'photo'),
          getAssets(ALL_ALBUM_ID, 'video'),
        ]);
        const all = [...photos, ...videos].filter((a) => a.creationTime);

        const hours = new Array(24).fill(0);
        const weekdays = new Array(7).fill(0);
        const months = {};
        let earliest = Infinity;
        for (const a of all) {
          const d = new Date(a.creationTime);
          hours[d.getHours()]++;
          weekdays[d.getDay()]++;
          const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          months[mk] = (months[mk] || 0) + 1;
          if (a.creationTime < earliest) earliest = a.creationTime;
        }

        const bestHour = hours.indexOf(Math.max(...hours));
        const bestWeekday = weekdays.indexOf(Math.max(...weekdays));
        const bestMonth =
          Object.entries(months).sort((a, b) => b[1] - a[1])[0] || null;
        const days = Math.max(
          1,
          Math.round((new Date().getTime() - earliest) / 86400000)
        );

        const weekdayName = new Date(2024, 0, 7 + bestWeekday) // a Sunday + offset
          .toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
            weekday: 'long',
          });

        if (!alive) return;
        setStats({
          photoCount: photos.length,
          videoCount: videos.length,
          hours,
          maxHour: Math.max(...hours, 1),
          bestHour,
          weekdayName,
          bestMonth,
          avgPerDay: (all.length / days).toFixed(1),
        });
      } catch (e) {
        if (alive) setStats({ error: true });
      }
    })();
    return () => {
      alive = false;
    };
  }, [language]);

  const Card = ({ icon, label, value }) => (
    <View style={[styles.card, { backgroundColor: colors.card }]}>
      <Ionicons name={icon} size={20} color={colors.accent} />
      <Text style={[styles.cardValue, { color: colors.text }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[styles.cardLabel, { color: colors.subtext }]}>{label}</Text>
    </View>
  );

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.topBar}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>
          {t('insights_title')}
        </Text>
        <View style={{ width: 26 }} />
      </View>

      {!stats ? (
        <ActivityIndicator style={{ marginTop: 60 }} size="large" color={colors.accent} />
      ) : stats.error ? (
        <Text style={{ color: colors.subtext, marginTop: 40, textAlign: 'center' }}>
          {t('nothing_found')}
        </Text>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 120 }}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.grid}>
            <Card
              icon="images-outline"
              label={t('insights_total_photos')}
              value={stats.photoCount}
            />
            <Card
              icon="videocam-outline"
              label={t('insights_total_videos')}
              value={stats.videoCount}
            />
            <Card
              icon="time-outline"
              label={t('insights_busiest_hour')}
              value={`${stats.bestHour}:00–${stats.bestHour + 1}:00`}
            />
            <Card
              icon="calendar-outline"
              label={t('insights_busiest_day')}
              value={stats.weekdayName}
            />
            <Card
              icon="calendar-number-outline"
              label={t('insights_busiest_month')}
              value={stats.bestMonth ? stats.bestMonth[0] : '—'}
            />
            <Card
              icon="flame-outline"
              label={t('insights_avg_per_day')}
              value={stats.avgPerDay}
            />
          </View>

          <Text style={[styles.chartTitle, { color: colors.text }]}>
            {t('insights_hour_chart')}
          </Text>
          <View style={[styles.chart, { backgroundColor: colors.card }]}>
            <View style={styles.bars}>
              {stats.hours.map((v, i) => (
                <View key={i} style={styles.barWrap}>
                  <View
                    style={[
                      styles.bar,
                      {
                        height: Math.max(3, (v / stats.maxHour) * 90),
                        backgroundColor:
                          i === stats.bestHour ? colors.accent : colors.chartTrack,
                      },
                    ]}
                  />
                </View>
              ))}
            </View>
            <View style={styles.axis}>
              {[0, 6, 12, 18, 23].map((h) => (
                <Text key={h} style={[styles.axisLabel, { color: colors.subtext }]}>
                  {h}
                </Text>
              ))}
            </View>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 16 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  title: { fontSize: 18, fontWeight: '800' },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 8,
  },
  card: {
    width: '48%',
    flexGrow: 1,
    borderRadius: 16,
    padding: 14,
    gap: 4,
  },
  cardValue: { fontSize: 18, fontWeight: '800' },
  cardLabel: { fontSize: 11 },
  chartTitle: { fontSize: 15, fontWeight: '700', marginTop: 22, marginBottom: 10 },
  chart: { borderRadius: 16, padding: 14 },
  bars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 96,
    gap: 2,
  },
  barWrap: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: 2 },
  axis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  axisLabel: { fontSize: 10 },
});
