import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import LiquidTabBar from '../components/LiquidTabBar';
import AlbumSelectScreen from '../screens/AlbumSelectScreen';
import CleaningScreen from '../screens/CleaningScreen';
import VideoAlbumSelectScreen from '../screens/VideoAlbumSelectScreen';
import VideoCleaningScreen from '../screens/VideoCleaningScreen';
import ProfileScreen from '../screens/ProfileScreen';
import RecycleBinScreen from '../screens/RecycleBinScreen';
import BurstCleanScreen from '../screens/BurstCleanScreen';

const Tab = createBottomTabNavigator();
const PhotosStack = createNativeStackNavigator();
const VideosStack = createNativeStackNavigator();
const ProfileStack = createNativeStackNavigator();

function PhotosNavigator() {
  return (
    <PhotosStack.Navigator screenOptions={{ headerShown: false }}>
      <PhotosStack.Screen name="AlbumSelect" component={AlbumSelectScreen} />
      <PhotosStack.Screen
        name="Cleaning"
        component={CleaningScreen}
        options={{ gestureEnabled: false }}
      />
    </PhotosStack.Navigator>
  );
}

function VideosNavigator() {
  return (
    <VideosStack.Navigator screenOptions={{ headerShown: false }}>
      <VideosStack.Screen
        name="VideoAlbumSelect"
        component={VideoAlbumSelectScreen}
      />
      <VideosStack.Screen
        name="VideoCleaning"
        component={VideoCleaningScreen}
        options={{ gestureEnabled: false }}
      />
    </VideosStack.Navigator>
  );
}

function ProfileNavigator() {
  return (
    <ProfileStack.Navigator screenOptions={{ headerShown: false }}>
      <ProfileStack.Screen name="Profile" component={ProfileScreen} />
      <ProfileStack.Screen name="RecycleBin" component={RecycleBinScreen} />
      <ProfileStack.Screen name="BurstClean" component={BurstCleanScreen} />
    </ProfileStack.Navigator>
  );
}

export default function RootNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <LiquidTabBar {...props} />}
    >
      <Tab.Screen name="PhotosTab" component={PhotosNavigator} />
      <Tab.Screen name="VideosTab" component={VideosNavigator} />
      <Tab.Screen name="ProfileTab" component={ProfileNavigator} />
    </Tab.Navigator>
  );
}
