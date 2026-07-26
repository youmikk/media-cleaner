import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { useSettings } from '../context/SettingsContext';
import { formatBytes, formatDate, getAssetSize } from '../utils/albumHelpers';

/**
 * Modal with full EXIF / metadata details for an asset.
 * Uses MediaLibrary.getAssetInfoAsync (exposes EXIF on iOS); shows basic
 * asset metadata everywhere.
 */
export default function EXIFModal({ visible, asset, onClose }) {
  const { colors, t, language } = useSettings();
  const [rows, setRows] = useState(null);

  useEffect(() => {
    if (!visible || !asset) return;
    setRows(null);
    (async () => {
      const out = [];
      try {
        const info = await MediaLibrary.getAssetInfoAsync(asset.id);
        out.push(['File', info.filename || '—']);
        out.push(['Created', formatDate(info.creationTime, language)]);
        out.push(['Modified', formatDate(info.modificationTime, language)]);
        out.push(['Dimensions', `${info.width} × ${info.height}`]);
        if (info.duration) out.push(['Duration', `${info.duration.toFixed(1)}s`]);
        const size = await getAssetSize(info);
        if (size) out.push(['Size', formatBytes(size)]);
        if (info.location) {
          out.push([
            'Location',
            `${info.location.latitude.toFixed(5)}, ${info.location.longitude.toFixed(5)}`,
          ]);
        }
        if (info.exif) {
          const exif = info.exif;
          const pick = (obj, keys) =>
            keys.forEach((k) => {
              const v = k.split('.').reduce((o, p) => (o ? o[p] : undefined), obj);
              if (v !== undefined && v !== null) out.push([k.split('.').pop(), String(v)]);
            });
          pick(exif, [
            '{Exif}.LensModel',
            '{Exif}.FNumber',
            '{Exif}.ExposureTime',
            '{Exif}.ISOSpeedRatings',
            '{Exif}.FocalLength',
            '{TIFF}.Make',
            '{TIFF}.Model',
            'LensModel',
            'FNumber',
            'ExposureTime',
            'ISOSpeedRatings',
            'FocalLength',
            'Make',
            'Model',
          ]);
        }
      } catch (e) {
        // fall through with whatever we collected
      }
      setRows(out);
    })();
  }, [visible, asset, language]);

  return (
    <Modal visible={visible} transparent animationType="slide">
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.card }]} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>
              {t('exif_title')}
            </Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.subtext} />
            </Pressable>
          </View>
          {rows === null ? (
            <ActivityIndicator style={{ marginVertical: 24 }} color={colors.accent} />
          ) : rows.length === 0 ? (
            <Text style={{ color: colors.subtext, paddingVertical: 16 }}>
              {t('exif_none')}
            </Text>
          ) : (
            <ScrollView style={{ maxHeight: 380 }}>
              {rows.map(([k, v], i) => (
                <View
                  key={`${k}_${i}`}
                  style={[styles.row, { borderColor: colors.border }]}
                >
                  <Text style={[styles.key, { color: colors.subtext }]}>{k}</Text>
                  <Text style={[styles.value, { color: colors.text }]} numberOfLines={2}>
                    {v}
                  </Text>
                </View>
              ))}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 34,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: { fontSize: 17, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  key: { width: 120, fontSize: 13 },
  value: { flex: 1, fontSize: 13, fontWeight: '500' },
});
