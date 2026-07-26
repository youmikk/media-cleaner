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
import { reverseGeocode } from '../utils/geocode';
import { parseExif } from '../utils/exifParser';
import * as PhotoMove from '../../modules/photo-move';
import { log, logError } from '../utils/logger';

/**
 * Modal with full, LOCALIZED EXIF / metadata details for an asset.
 * GPS coordinates are resolved into a human-readable address.
 */
export default function EXIFModal({ visible, asset, onClose }) {
  const { colors, t, language } = useSettings();
  const [rows, setRows] = useState(null);

  useEffect(() => {
    if (!visible || !asset) return;
    setRows(null);
    let alive = true;
    (async () => {
      const out = [];
      try {
        const info = await MediaLibrary.getAssetInfoAsync(asset.id);
        out.push([t('exif_file'), info.filename || '—']);
        out.push([t('exif_created'), formatDate(info.creationTime, language)]);
        out.push([t('exif_modified'), formatDate(info.modificationTime, language)]);
        out.push([t('exif_dimensions'), `${info.width} × ${info.height}`]);
        if (info.duration)
          out.push([t('exif_duration'), `${info.duration.toFixed(1)}s`]);
        const size = await getAssetSize(info);
        if (size) out.push([t('exif_size'), formatBytes(size)]);
        // PROGRESSIVE: show the basic rows IMMEDIATELY — camera fields and
        // the (network-bound) location row stream in as they resolve.
        if (alive) setRows([...out]);

        // Location: coordinates shown right away, geocoding upgrades the
        // row when it answers within 4s — it must never block the modal.
        if (info.location) {
          const coords = `${info.location.latitude.toFixed(5)}, ${info.location.longitude.toFixed(5)}`;
          const locIndex = out.length;
          out.push([t('exif_location'), coords]);
          if (alive) setRows([...out]);
          Promise.race([
            reverseGeocode(
              info.location.latitude,
              info.location.longitude,
              language
            ),
            new Promise((r) => setTimeout(() => r(null), 4000)),
          ])
            .then((address) => {
              if (alive && address) {
                out[locIndex] = [t('exif_location'), address];
                setRows([...out]);
              }
            })
            .catch(() => {});
        }
        // Camera FIELDS from an exif object (system-shaped OR our parser's).
        // Field-based so multiple sources can be MERGED — e.g. iOS system
        // exif often has aperture/ISO but strips {TIFF} (camera model);
        // the native reader then fills exactly the missing fields.
        const extractCameraFields = (exif) => {
          const get = (keys) => {
            for (const k of keys) {
              const v = k
                .split('.')
                .reduce((o, p) => (o ? o[p] : undefined), exif);
              if (v !== undefined && v !== null && v !== '') return v;
            }
            return null;
          };
          const f = {};
          const make = get(['{TIFF}.Make', 'TIFF.Make', 'Make']);
          const model = get(['{TIFF}.Model', 'TIFF.Model', 'Model']);
          if (make || model) f.camera = [make, model].filter(Boolean).join(' ');
          const lens = get(['{Exif}.LensModel', 'Exif.LensModel', 'LensModel']);
          if (lens) f.lens = String(lens);
          const fnum = get(['{Exif}.FNumber', 'Exif.FNumber', 'FNumber']);
          if (fnum) f.aperture = `f/${Number(fnum).toFixed(1).replace(/\.0$/, '')}`;
          const exposure = get([
            '{Exif}.ExposureTime',
            'Exif.ExposureTime',
            'ExposureTime',
          ]);
          if (exposure) {
            const ex = Number(exposure);
            f.shutter = ex >= 1 ? `${ex}s` : `1/${Math.round(1 / ex)}s`;
          }
          const iso = get([
            '{Exif}.ISOSpeedRatings',
            'Exif.ISOSpeedRatings',
            'ISOSpeedRatings',
          ]);
          if (iso) f.iso = String(Array.isArray(iso) ? iso[0] : iso);
          const focal = get(['{Exif}.FocalLength', 'Exif.FocalLength', 'FocalLength']);
          const focal35 = get([
            '{Exif}.FocalLenIn35mmFilm',
            'Exif.FocalLenIn35mmFilm',
            'FocalLengthIn35mmFilm',
          ]);
          if (focal) {
            const fl = Number(focal).toFixed(1).replace(/\.0$/, '');
            f.focal = focal35 ? `${fl}mm (≈${focal35}mm)` : `${fl}mm`;
          }
          return f;
        };

        // 1) system exif (iOS sometimes returns it EMPTY — treat "extracted
        //    nothing" the same as missing), 2) native ExifInterface
        //    (Android, photoo-style — handles JPEG/HEIF/DNG), 3) the pure-JS
        //    file parser as the last resort.
        // Camera info: MERGE system exif -> native (ExifInterface/ImageIO)
        // -> pure-JS parser, per FIELD. Later sources only fill fields the
        // earlier ones missed. Photos without shooting EXIF (screenshots,
        // saved images) legitimately show nothing here.
        try {
          let fields = {};
          try {
            fields = info.exif ? extractCameraFields(info.exif) : {};
          } catch (e) {
            fields = {};
          }
          if (
            asset.mediaType !== 'video' &&
            (!fields.camera || Object.keys(fields).length === 0)
          ) {
            const fileUri = info.localUri || info.uri || asset.uri;
            if (PhotoMove.isAvailable()) {
              try {
                const nativeExif = await PhotoMove.readExif(fileUri);
                if (nativeExif) {
                  fields = { ...extractCameraFields(nativeExif), ...fields };
                }
              } catch (e) {
                // fall through to the JS parser
              }
            }
            if (!fields.camera) {
              try {
                const parsed = await parseExif(fileUri);
                if (parsed) {
                  fields = { ...extractCameraFields(parsed), ...fields };
                }
              } catch (e) {
                // parser failed — show what we have
              }
            }
          }
          if (fields.camera) out.push([t('exif_camera'), fields.camera]);
          if (fields.lens) out.push([t('exif_lens'), fields.lens]);
          if (fields.aperture) out.push([t('exif_aperture'), fields.aperture]);
          if (fields.shutter) out.push([t('exif_shutter'), fields.shutter]);
          if (fields.iso) out.push([t('exif_iso'), fields.iso]);
          if (fields.focal) out.push([t('exif_focal'), fields.focal]);
        } catch (e) {
          logError('exif.camera', e);
          out.push(['Debug', `camera:ERR ${String(e && e.message ? e.message : e).slice(0, 60)}`]);
        }
      } catch (e) {
        // basic info failed — fall through with whatever we collected
        logError('exif.basic', e);
        out.push(['Debug', `basic:ERR ${String(e && e.message ? e.message : e).slice(0, 60)}`]);
      }
      if (alive) setRows([...out]);
    })();
    return () => {
      alive = false;
    };
  }, [visible, asset, language, t]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
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
    backgroundColor: 'rgba(0,0,0,0.35)',
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
