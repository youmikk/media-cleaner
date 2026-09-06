import { Platform, StyleSheet } from 'react-native';
import { iosShapes } from '../theme/shapes';

/**
 * ONE geometry for every control in the album-select controls row: the album
 * picker, the time picker and the group-size stepper.
 *
 * They used to carry their own paddings and maxWidths, so the row was three
 * visibly different sizes — and the album button, which also hosts a count
 * and a progress ring, was taller than the rest. Share a compact minimum
 * height while allowing large system text to grow instead of spilling out.
 */
export const PICKER_HEIGHT = Platform.OS === 'android' ? 48 : 44;

export const pickerStyles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: PICKER_HEIGHT,
    maxWidth: '100%',
    minWidth: 0,
    flexShrink: 1,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 14,
    ...iosShapes.control,
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: { fontSize: 14, fontWeight: '600', flexShrink: 1, minWidth: 0 },
});
