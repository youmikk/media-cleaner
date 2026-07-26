import React from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import { useSettings } from '../context/SettingsContext';

/**
 * "Album content has changed. Re-analyze?" prompt.
 */
export default function CacheStalePrompt({ visible, onReanalyze, onUseStale }) {
  const { colors, t } = useSettings();
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          <Text style={[styles.title, { color: colors.text }]}>
            {t('cache_stale_title')}
          </Text>
          <Text style={[styles.message, { color: colors.subtext }]}>
            {t('cache_stale_message')}
          </Text>
          <View style={styles.row}>
            <Pressable
              style={[styles.btn, { backgroundColor: colors.chartTrack }]}
              onPress={onUseStale}
            >
              <Text style={[styles.btnText, { color: colors.text }]}>
                {t('use_stale')}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.btn, { backgroundColor: colors.accent }]}
              onPress={onReanalyze}
            >
              <Text style={[styles.btnText, { color: '#fff' }]}>
                {t('reanalyze')}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 32,
  },
  card: { borderRadius: 20, padding: 20 },
  title: { fontSize: 17, fontWeight: '700', marginBottom: 8 },
  message: { fontSize: 14, lineHeight: 20, marginBottom: 16 },
  row: { flexDirection: 'row', gap: 10 },
  btn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  btnText: { fontSize: 15, fontWeight: '600' },
});
