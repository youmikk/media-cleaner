import { Platform } from 'react-native';

// Both platforms share the HIG-inspired radius hierarchy. UIKit supports
// continuous curves; Android uses native round-rect clipping with these radii.
// These are app design choices, not fixed Apple system metrics.
const continuous = Platform.OS === 'ios' ? { borderCurve: 'continuous' } : {};
export const surfaceShapes = {
  control: { ...continuous, borderRadius: 999 },
  floating: { ...continuous, borderRadius: 24 },
  toolbar: { ...continuous, borderRadius: 28 },
  group: { ...continuous, borderRadius: 20 },
  menu: { ...continuous, borderRadius: 26 },
  sheet: {
    ...continuous,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    overflow: 'hidden',
  },
};
