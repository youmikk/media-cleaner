import { StyleSheet } from 'react-native';

/**
 * ONE geometry for every control in the album-select controls row: the album
 * picker, the time picker and the group-size stepper.
 *
 * They used to carry their own paddings and maxWidths, so the row was three
 * visibly different sizes — and the album button, which also hosts a count
 * and a progress ring, was taller than the rest. Pinning the height here is
 * what keeps them identical, and keeps the card stack below at the same y on
 * the photos and videos tabs.
 */
export const PICKER_HEIGHT = 44;

export const pickerStyles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: PICKER_HEIGHT,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
});
