import React from 'react';
import AlbumSelectBase from './AlbumSelectBase';

export default function AlbumSelectScreen({ navigation }) {
  return (
    <AlbumSelectBase
      mediaType="photo"
      cleaningRoute="Cleaning"
      navigation={navigation}
    />
  );
}
