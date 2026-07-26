import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '../context/SettingsContext';
import { useApp } from '../context/AppContext';
import * as trashManager from '../utils/trashManager';
import { formatBytes } from '../utils/albumHelpers';

/**
 * Recycle bin: 30-day retention list with multi-select restore / permanent
 * delete. Items with fewer than 7 days remaining are shown in red.
 */
export default function RecycleBinScreen({ navigation }) {
  const { colors, t } = useSettings();
  const { trash, refreshTrash } = useApp();
  const [selected, setSelected] = useState({});

  useFocusEffect(
    useCallback(() => {
      refreshTrash();
    }, [refreshTrash])
  );

  const selectedEntries = trash.filter((e) => selected[e.fileUri]);
  const allSelected = trash.length > 0 && selectedEntries.length === trash.length;

  const toggleAll = () => {
    if (allSelected) setSelected({});
    else {
      const next = {};
      trash.forEach((e) => {
        next[e.fileUri] = true;
      });
      setSelected(next);
    }
  };

  const restoreSelected = async () => {
    for (const entry of selectedEntries) {
      try {
        await trashManager.restoreFromTrash(entry);
      } catch (e) {
        // file missing — skip
      }
    }
    setSelected({});
    refreshTrash();
  };

  const deleteSelected = () => {
    Alert.alert(t('delete_forever'), '', [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('delete_forever'),
        style: 'destructive',
        onPress: async () => {
          for (const entry of selectedEntries) {
            await trashManager.removeFromTrash(entry);
          }
          setSelected({});
          refreshTrash();
        },
      },
    ]);
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.topBar}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>
          {t('recycle_bin')}
        </Text>
        <View style={{ width: 26 }} />
      </View>

      {trash.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="trash-bin-outline" size={48} color={colors.subtext} />
          <Text style={[styles.emptyText, { color: colors.subtext }]}>
            {t('recycle_empty')}
          </Text>
        </View>
      ) : (
        <>
          <Pressable style={styles.selectAll} onPress={toggleAll}>
            <Ionicons
              name={allSelected ? 'checkbox' : 'square-outline'}
              size={20}
              color={colors.accent}
            />
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>
              {t('select_all')}
            </Text>
          </Pressable>

          <FlatList
            data={trash}
            keyExtractor={(item) => item.fileUri}
            contentContainerStyle={{ paddingBottom: 140 }}
            renderItem={({ item }) => {
              const isSel = !!selected[item.fileUri];
              const urgent = item.daysLeft < 7;
              return (
                <Pressable
                  style={[styles.row, { backgroundColor: colors.card }]}
                  onPress={() =>
                    setSelected((s) => ({ ...s, [item.fileUri]: !s[item.fileUri] }))
                  }
                >
                  <Ionicons
                    name={isSel ? 'checkbox' : 'square-outline'}
                    size={20}
                    color={isSel ? colors.accent : colors.subtext}
                  />
                  <Ionicons
                    name={item.mediaType === 'video' ? 'videocam' : 'image'}
                    size={20}
                    color={colors.subtext}
                  />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}
                      numberOfLines={1}
                    >
                      {item.filename}
                    </Text>
                    <Text style={{ color: colors.subtext, fontSize: 12, marginTop: 2 }}>
                      {formatBytes(item.size)}
                    </Text>
                  </View>
                  <Text
                    style={{
                      color: urgent ? colors.danger : colors.subtext,
                      fontSize: 12,
                      fontWeight: urgent ? '800' : '500',
                    }}
                  >
                    {t('days_left', { days: item.daysLeft })}
                  </Text>
                </Pressable>
              );
            }}
          />

          {selectedEntries.length > 0 && (
            <View style={styles.actions}>
              <Pressable
                style={[styles.actionBtn, { backgroundColor: colors.accent }]}
                onPress={restoreSelected}
              >
                <Ionicons name="refresh" size={16} color="#fff" />
                <Text style={styles.actionText}>
                  {t('restore')} ({selectedEntries.length})
                </Text>
              </Pressable>
              <Pressable
                style={[styles.actionBtn, { backgroundColor: colors.danger }]}
                onPress={deleteSelected}
              >
                <Ionicons name="trash" size={16} color="#fff" />
                <Text style={styles.actionText}>
                  {t('delete_forever')} ({selectedEntries.length})
                </Text>
              </Pressable>
            </View>
          )}
        </>
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
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyText: { fontSize: 14 },
  selectAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
  },
  actions: {
    position: 'absolute',
    bottom: 30,
    left: 16,
    right: 16,
    flexDirection: 'row',
    gap: 10,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 14,
    paddingVertical: 13,
  },
  actionText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
