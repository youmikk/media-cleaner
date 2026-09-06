import React, { useId, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings } from '../context/SettingsContext';
import { surfaceShapes } from '../theme/shapes';
import IconButton from './IconButton';
import GlassBackdrop from './GlassBackdrop';
import GlassSurface from './GlassSurface';
import { useGlassEffects } from '../context/GlassEffectsContext';

/** Shared Android sheet for app-owned choices; system workflows stay native. */
export default function AppBottomSheet({
  visible,
  title,
  onClose,
  children,
  glassHeader = false,
  renderContent,
}) {
  const { colors, t } = useSettings();
  const { reduceMotion } = useGlassEffects();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const instanceId = useId();
  const sourceKey = `picker-sheet-${instanceId}`;
  const [headerHeight, setHeaderHeight] = useState(72);
  const floatingHeader = glassHeader && typeof renderContent === 'function';
  const bottomPadding = Math.max(insets.bottom, 16);
  const sheetMaxHeight = Math.max(0, Math.min(height * 0.88, height - insets.top - 16));
  const contentHeight = Math.max(0, Math.min(480, sheetMaxHeight - bottomPadding - 8));
  const header = (
    <>
      <View style={[styles.handle, { backgroundColor: colors.border }]} />
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">
          {title}
        </Text>
        <IconButton
          name="close"
          label={t('close')}
          onPress={onClose}
          color={floatingHeader ? colors.glassSubtext : colors.subtext}
          iconSize={22}
          style={styles.close}
        />
      </View>
    </>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reduceMotion ? 'none' : 'fade'}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable
        style={[styles.backdrop, { backgroundColor: colors.scrim }]}
        onPress={onClose}
        accessible={false}
      >
        <Pressable
          style={[
            styles.sheet,
            {
              backgroundColor: colors.elevated,
              paddingBottom: bottomPadding,
              paddingLeft: 16 + insets.left,
              paddingRight: 16 + insets.right,
            },
            floatingHeader && { maxHeight: sheetMaxHeight },
          ]}
          onPress={() => {}}
          accessible={false}
          accessibilityViewIsModal
        >
          {floatingHeader ? (
            <View style={{ height: contentHeight }}>
              <GlassSurface
                androidSource={sourceKey}
                effectEnabled={visible}
                style={styles.floatingHeader}
                onLayout={(event) => {
                  const measured = Math.ceil(event.nativeEvent.layout.height);
                  if (measured > 0) {
                    setHeaderHeight((current) => current === measured ? current : measured);
                  }
                }}
              >
                {header}
              </GlassSurface>
              <GlassBackdrop sourceKey={sourceKey}>
                {renderContent({
                  style: styles.scrollList,
                  contentContainerStyle: { paddingTop: headerHeight },
                  scrollIndicatorInsets: { top: headerHeight },
                })}
              </GlassBackdrop>
            </View>
          ) : (
            <>
              {header}
              <View style={styles.content}>
                {typeof renderContent === 'function' ? renderContent({}) : children}
              </View>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '88%',
    ...surfaceShapes.sheet,
    paddingHorizontal: 16,
    paddingTop: 8,
    elevation: 12,
  },
  content: { flexShrink: 1 },
  scrollList: { flex: 1, maxHeight: '100%' },
  floatingHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
    paddingBottom: 8,
  },
  handle: {
    width: 32,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 4,
  },
  header: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: { flex: 1, fontSize: 20, fontWeight: '700' },
  close: { flexShrink: 0 },
});
