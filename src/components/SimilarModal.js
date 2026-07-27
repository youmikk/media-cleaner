import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import PhotoViewer from './PhotoViewer';
import { getAssetsByIds } from '../utils/albumHelpers';

/**
 * Grid modal of all photos in a similarity cluster (whole album scope).
 * Tap a photo to view it FULL SCREEN (zoomable); tap its circle badge to
 * (de)select. Soft-deletes the selection via `onDeleteSelected`.
 */
export default function SimilarModal({ visible, clusterIds, onClose, onDeleteSelected }) {
  const { colors, t } = useSettings();
  const { width } = useWindowDimensions();
  const [assets, setAssets] = useState([]);
  const [selected, setSelected] = useState({});
  const [viewerIndex, setViewerIndex] = useState(null); // null = closed

  useEffect(() => {
    if (!visible || !clusterIds) return undefined;
    setSelected({});
    setViewerIndex(null);
    setAssets([]);
    // Guarded: getAssetsByIds does up to 600 getAssetInfoAsync calls, so
    // closing and reopening on a different cluster could land the FIRST
    // request's results after the second's — the sheet then showed the
    // previous cluster's photos and any deletion acted on the wrong assets.
    let alive = true;
    getAssetsByIds(clusterIds).then((list) => {
      if (alive) setAssets(list);
    });
    return () => {
      alive = false;
    };
  }, [visible, clusterIds]);

  const cell = (width - 16 * 2 - 8 * 2) / 3;
  const selectedIds = Object.keys(selected).filter((k) => selected[k]);

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: colors.card }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>
              {t('similar_title')}
            </Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.subtext} />
            </Pressable>
          </View>
          <FlatList
            data={assets}
            numColumns={3}
            keyExtractor={(item) => item.id}
            columnWrapperStyle={{ gap: 8 }}
            contentContainerStyle={{ gap: 8, paddingBottom: 12 }}
            style={{ maxHeight: 420 }}
            renderItem={({ item, index }) => {
              const isSel = !!selected[item.id];
              return (
                <Pressable
                  onPress={() => setViewerIndex(index)} // tap = view full screen
                  style={{ width: cell, height: cell }}
                >
                  <Image
                    source={{ uri: item.uri }}
                    style={[styles.thumb, isSel && { opacity: 0.55 }]}
                  />
                  {/* circle badge = (de)select */}
                  <Pressable
                    hitSlop={8}
                    onPress={() =>
                      setSelected((s) => ({ ...s, [item.id]: !s[item.id] }))
                    }
                    style={[
                      styles.check,
                      {
                        backgroundColor: isSel ? colors.danger : 'rgba(0,0,0,0.35)',
                      },
                    ]}
                  >
                    <Ionicons
                      name={isSel ? 'trash' : 'ellipse-outline'}
                      size={14}
                      color="#fff"
                    />
                  </Pressable>
                </Pressable>
              );
            }}
          />
          <Pressable
            disabled={selectedIds.length === 0}
            onPress={() => {
              const ids = selectedIds;
              setSelected({});
              onDeleteSelected(assets.filter((a) => ids.includes(a.id)));
            }}
            style={[
              styles.deleteBtn,
              {
                backgroundColor:
                  selectedIds.length === 0 ? colors.chartTrack : colors.danger,
              },
            ]}
          >
            <Text
              style={[
                styles.deleteText,
                { color: selectedIds.length === 0 ? colors.subtext : '#fff' },
              ]}
            >
              {t('delete_selected', { count: selectedIds.length })}
            </Text>
          </Pressable>
        </View>
      </View>

      <PhotoViewer
        visible={viewerIndex !== null}
        assets={assets}
        initialIndex={viewerIndex || 0}
        onClose={() => setViewerIndex(null)}
        selected={selected}
        onToggleSelect={(id) =>
          setSelected((s) => ({ ...s, [id]: !s[id] }))
        }
      />
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
    padding: 16,
    paddingBottom: 30,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: { fontSize: 17, fontWeight: '700' },
  thumb: { width: '100%', height: '100%', borderRadius: 10 },
  check: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtn: {
    marginTop: 10,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
  },
  deleteText: { fontSize: 15, fontWeight: '700' },
});
