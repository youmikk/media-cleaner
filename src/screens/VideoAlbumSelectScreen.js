import React from 'react';
import AlbumSelectScreen from './AlbumSelectScreen';

/**
 * Videos tab entry — the SAME screen the Photos tab uses. It only differs by
 * media type, so sharing it is what keeps the two tabs offering the same
 * controls (album · time · group size) at the same size and position.
 */
export default function VideoAlbumSelectScreen({ navigation }) {
  return (
    <AlbumSelectScreen
      navigation={navigation}
      mediaType="video"
      cleaningRoute="VideoCleaning"
    />
  );
}
