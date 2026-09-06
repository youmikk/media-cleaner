import { Platform } from 'react-native';

// iOS 26 uses rounder, continuous outlines with nested controls following
// their container. These are app choices based on the HIG, not system metrics.
// Keep Android's existing dimensions and radii independently configurable.
const continuous = { borderCurve: 'continuous' };
export const iosShapes = Platform.OS === 'ios' ? {
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
} : {
  control: {}, floating: {}, toolbar: {}, group: {}, menu: {}, sheet: {},
};
