import React from 'react';
import AlbumSelectBase from './AlbumSelectBase';

export default function VideoAlbumSelectScreen({ navigation }) {
  return (
    <AlbumSelectBase
      mediaType="video"
      cleaningRoute="VideoCleaning"
      navigation={navigation}
    />
  );
}
