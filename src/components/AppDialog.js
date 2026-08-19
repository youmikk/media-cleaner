import React, { useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSettings } from '../context/SettingsContext';

let presentDialog = null;

/** Alert-compatible entry point: custom on Android, native on iOS. */
export function showAppAlert(title, message, buttons, options) {
  if (Platform.OS !== 'android' || !presentDialog) {
    Alert.alert(title, message, buttons, options);
    return;
  }
  presentDialog({ title, message, buttons, options });
}

export default function AppDialogHost() {
  const { colors, t } = useSettings();
  const { width } = useWindowDimensions();
  const [requests, setRequests] = useState([]);
  const request = requests[0] || null;

  useEffect(() => {
    presentDialog = (next) => setRequests((current) => [...current, next]);
    return () => {
      presentDialog = null;
    };
  }, []);

  if (!request) return null;

  const actions =
    Array.isArray(request.buttons) && request.buttons.length > 0
      ? request.buttons
      : [{ text: t('ok') }];
  const cancelAction = actions.find((action) => action.style === 'cancel');
  const dismiss = (action = null) => {
    setRequests((current) => current.slice(1));
    if (action?.onPress) setTimeout(action.onPress, 0);
  };
  const dismissFromSystem = () => {
    // App confirmations stay explicit by default. Opt in only for genuinely
    // dismissible notices so a backdrop tap cannot approve or abandon work.
    if (request.options?.cancelable !== true) return;
    dismiss(cancelAction);
  };
  const vertical = actions.length > 2;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={dismissFromSystem}
    >
      <Pressable
        style={[styles.backdrop, { backgroundColor: colors.scrim }]}
        onPress={dismissFromSystem}
      >
        <Pressable
          style={[
            styles.dialog,
            {
              width: Math.min(380, width - 48),
              maxHeight: '82%',
              backgroundColor: colors.elevated,
              borderColor: colors.border,
            },
          ]}
          onPress={() => {}}
          accessibilityViewIsModal
        >
          {!!request.title && (
            <Text style={[styles.title, { color: colors.text }]}>
              {request.title}
            </Text>
          )}
          {!!request.message && (
            <ScrollView
              style={styles.messageScroll}
              nestedScrollEnabled
              showsVerticalScrollIndicator={false}
            >
              <Text style={[styles.message, { color: colors.subtext }]}>
                {request.message}
              </Text>
            </ScrollView>
          )}
          <View style={[styles.actions, vertical && styles.actionsVertical]}>
            {actions.map((action, index) => {
              const destructive = action.style === 'destructive';
              const cancel = action.style === 'cancel';
              return (
                <Pressable
                  key={`${action.text || 'action'}_${index}`}
                  onPress={() => dismiss(action)}
                  android_ripple={{
                    color: destructive ? colors.dangerSoft : colors.accentSoft,
                  }}
                  accessibilityRole="button"
                  style={[
                    styles.action,
                    vertical && styles.actionVertical,
                  ]}
                >
                  <Text
                    style={[
                      styles.actionText,
                      {
                        color: destructive
                          ? colors.danger
                          : cancel
                            ? colors.subtext
                            : colors.accent,
                      },
                    ]}
                  >
                    {action.text || t('ok')}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  dialog: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 12,
    elevation: 12,
  },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  messageScroll: { flexShrink: 1, marginTop: 10 },
  message: { fontSize: 14, lineHeight: 21 },
  actions: {
    minHeight: 56,
    marginTop: 16,
    marginHorizontal: -8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
  },
  actionsVertical: { alignItems: 'stretch', flexDirection: 'column' },
  action: {
    minWidth: 72,
    minHeight: 48,
    borderRadius: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  actionVertical: { alignSelf: 'stretch', alignItems: 'flex-end' },
  actionText: { fontSize: 14, fontWeight: '700' },
});
