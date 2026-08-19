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
import * as MediaLibrary from 'expo-media-library';
import { useSettings } from '../context/SettingsContext';
import IconButton from './IconButton';
import { formatBytes, formatDate, getAssetSize } from '../utils/albumHelpers';
import { reverseGeocode } from '../utils/geocode';
import { parseExif } from '../utils/exifParser';
import * as PhotoMove from '../../modules/photo-move';
import { log, logError } from '../utils/logger';
import { runMediaWork } from '../utils/mediaWorkScheduler';

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
      // Each basic row is pushed through `row()`, which swallows its own
      // failure. They used to share one try block, so a single bad value
      // (the log showed a bare "undefined is not a function" here) replaced
      // filename, dates, dimensions and size with one Debug line.
      const row = (label, produce) => {
        try {
          const value = produce();
          if (value !== null && value !== undefined && value !== '') {
            out.push([label, value]);
          }
        } catch (e) {
          logError('exif.row', e);
        }
      };
      try {
        let systemInfo = null;
        try {
          systemInfo = await runMediaWork(
            () => MediaLibrary.getAssetInfoAsync(asset.id),
            'interactive'
          );
        } catch (e) {
          // The asset may have been deleted or temporarily unavailable. The
          // list asset still carries enough data for all basic rows.
        }
        const info = systemInfo || asset;
        if (!systemInfo) {
          log('exif.basic', `asset-info unavailable id=${asset.id}; fallback`);
        }
        row(t('exif_file'), () => info.filename || '—');
        row(t('exif_created'), () => formatDate(info.creationTime, language));
        row(t('exif_modified'), () => formatDate(info.modificationTime, language));
        row(t('exif_dimensions'), () => `${info.width} × ${info.height}`);
        row(t('exif_duration'), () =>
          info.duration ? `${Number(info.duration).toFixed(1)}s` : null
        );
        let size = 0;
        try {
          size = await getAssetSize(info);
        } catch (e) {
          size = 0;
        }
        row(t('exif_size'), () => (size ? formatBytes(size) : null));
        // PROGRESSIVE: show the basic rows IMMEDIATELY — camera fields and
        // the (network-bound) location row stream in as they resolve.
        if (alive) setRows([...out]);

        // Location: coordinates shown right away, geocoding upgrades the
        // row when it answers within 4s — it must never block the modal.
        const lat = info.location && Number(info.location.latitude);
        const lng = info.location && Number(info.location.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const coords = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
          const locIndex = out.length;
          out.push([t('exif_location'), coords]);
          if (alive) setRows([...out]);
          Promise.race([
            reverseGeocode(lat, lng, language),
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
                const nativeExif = await runMediaWork(
                  () => PhotoMove.readExif(fileUri),
                  'interactive'
                );
                if (nativeExif) {
                  fields = { ...extractCameraFields(nativeExif), ...fields };
                }
              } catch (e) {
                // fall through to the JS parser
              }
            }
            if (!fields.camera) {
              try {
                const parsed = await runMediaWork(
                  () => parseExif(fileUri),
                  'interactive'
                );
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
        }
      } catch (e) {
        // basic info failed — fall through with whatever we collected
        logError('exif.basic', e);
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
            <IconButton
              name="close"
              label={t('close')}
              onPress={onClose}
              color={colors.subtext}
              iconSize={22}
              style={styles.closeButton}
            />
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
  closeButton: { marginVertical: -10, marginRight: -10 },
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
