import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';
import { usePowerMode } from '../context/PowerModeContext';
import IconButton from './IconButton';

export default function LowPowerNotice() {
  const { colors, t } = useSettings();
  const { lowPower, adaptiveLowPower, active } = usePowerMode();
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(false);
  const notified = useRef(false);

  useEffect(() => {
    if (!lowPower) notified.current = false;
    if (!active || !lowPower) {
      setVisible(false);
    } else if (!notified.current) {
      notified.current = true;
      setVisible(true);
    }
  }, [lowPower, active]);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), 7000);
    return () => clearTimeout(timer);
  }, [visible]);

  const message = t(adaptiveLowPower ? 'low_power_entered_adaptive' : 'low_power_entered');
  useEffect(() => {
    if (visible && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(message);
  }, [visible, message]);

  if (!visible) return null;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, {
      top: insets.top + 8, left: insets.left + 16, right: insets.right + 16,
    }]}>
      <View style={[styles.notice, { backgroundColor: colors.elevated, borderColor: colors.border }]}>
        <Ionicons name="battery-half-outline" size={22} color={colors.warning} accessible={false} />
        <Text accessibilityLiveRegion="polite" style={[styles.message, { color: colors.text }]}>
          {message}
        </Text>
        <IconButton name="close" label={t('close')} onPress={() => setVisible(false)} color={colors.subtext} iconSize={20} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', zIndex: 100, alignItems: 'center' },
  notice: { width: '100%', maxWidth: 460, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 4, paddingVertical: 4, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, elevation: 6 },
  message: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18, paddingVertical: 6 },
});
