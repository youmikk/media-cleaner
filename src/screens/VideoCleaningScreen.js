import React from 'react';
import CleaningScreen from './CleaningScreen';

/**
 * Preserve the existing route while using the same card-stack cleanup flow
 * as smart suggestions. The old independent video feed is intentionally gone.
 */
export default function VideoCleaningScreen({ route, navigation }) {
  return (
    <CleaningScreen
      route={{
        ...route,
        params: { ...(route.params || {}), mediaType: 'video', sizesById: null },
      }}
      navigation={navigation}
    />
  );
}
