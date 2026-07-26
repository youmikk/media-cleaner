import React from 'react';
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

/**
 * End-of-group confirmation sheet: shows every item of the group with its
 * delete mark; the user can toggle marks, then Skip / Delete All Marked /
 * Move All Marked to an album. `onClose` (X button, backdrop tap, Android
 * back) dismisses WITHOUT advancing to the next group.
 */
export default function GroupConfirmSheet({
  visible,
  assets,
  markedIds,
  onToggleMark,
  onClose,
  onSkip,
  onDeleteMarked,
  onMoveMarked,
}) {
  const { colors, t } = useSettings();
  const { width } = useWindowDimensions();
  const cell = (width - 16 * 2 - 8 * 3) / 4;
  const markedCount = assets.filter((a) => markedIds.has(a.id)).length;
  const handleClose = onClose || onSkip;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
    >
      <Pressable style={styles.backdrop} onPress={handleClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.card }]}
          onPress={() => {}}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>
              {t('group_review_title')}
            </Text>
            <Pressable onPress={handleClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.subtext} />
            </Pressable>
          </View>
          <FlatList
            data={assets}
            numColumns={4}
            keyExtractor={(item) => item.id}
            columnWrapperStyle={{ gap: 8 }}
            contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
            style={{ maxHeight: 300 }}
            renderItem={({ item }) => {
              const marked = markedIds.has(item.id);
              return (
                <Pressable
                  onPress={() => onToggleMark(item.id)}
                  style={{ width: cell, height: cell }}
                >
                  <Image
                    source={{ uri: item.uri }}
                    style={[styles.thumb, marked && { opacity: 0.5 }]}
                  />
                  <View
                    style={[
                      styles.mark,
                      { backgroundColor: marked ? colors.danger : 'rgba(0,0,0,0.35)' },
                    ]}
                  >
                    <Ionicons
                      name={marked ? 'trash' : 'checkmark'}
                      size={13}
                      color="#fff"
                    />
                  </View>
                </Pressable>
              );
            }}
          />
          <View style={styles.buttons}>
            <Pressable
              style={[styles.btn, { backgroundColor: colors.chartTrack }]}
              onPress={onSkip}
            >
              <Text style={[styles.btnText, { color: colors.text }]}>{t('skip')}</Text>
            </Pressable>
            <Pressable
              disabled={markedCount === 0}
              style={[
                styles.btn,
                {
                  backgroundColor:
                    markedCount === 0 ? colors.chartTrack : colors.danger,
                },
              ]}
              onPress={onDeleteMarked}
            >
              <Text
                style={[
                  styles.btnText,
                  { color: markedCount === 0 ? colors.subtext : '#fff' },
                ]}
              >
                {t('delete_all_marked')} ({markedCount})
              </Text>
            </Pressable>
          </View>
          <Pressable
            disabled={markedCount === 0}
            style={[
              styles.moveBtn,
              { borderColor: markedCount === 0 ? colors.border : colors.accent },
            ]}
            onPress={onMoveMarked}
          >
            <Text
              style={[
                styles.btnText,
                { color: markedCount === 0 ? colors.subtext : colors.accent },
              ]}
            >
              {t('move_all_marked')}
            </Text>
          </Pressable>
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
  mark: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 10 },
  btn: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
  },
  moveBtn: {
    marginTop: 10,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1.5,
  },
  btnText: { fontSize: 14, fontWeight: '700' },
});
