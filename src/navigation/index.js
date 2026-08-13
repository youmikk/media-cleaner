import React from 'react';
import { Platform } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import LiquidTabBar from '../components/LiquidTabBar';
import { useSettings } from '../context/SettingsContext';
import AlbumSelectScreen from '../screens/AlbumSelectScreen';
import CleaningScreen from '../screens/CleaningScreen';
import VideoCleaningScreen from '../screens/VideoCleaningScreen';
import VideoAlbumSelectScreen from '../screens/VideoAlbumSelectScreen';
import ProfileScreen from '../screens/ProfileScreen';
import RecycleBinScreen from '../screens/RecycleBinScreen';
import BurstCleanScreen from '../screens/BurstCleanScreen';
import GalleryInsightsScreen from '../screens/GalleryInsightsScreen';
import CompressScreen from '../screens/CompressScreen';

// NATIVE bottom tabs (react-native-bottom-tabs → SwiftUI TabView): on
// iOS 26 this is the REAL system floating Liquid Glass tab bar. Only
// present in builds that include the native module — Expo Go and older
// binaries fall back to the custom LiquidTabBar below.
let createNativeBottomTabNavigator = null;
try {
  // eslint-disable-next-line global-require
  createNativeBottomTabNavigator =
    require('react-native-bottom-tabs/react-navigation').createNativeBottomTabNavigator;
} catch (e) {
  createNativeBottomTabNavigator = null;
}

const useNativeTabs = Platform.OS === 'ios' && !!createNativeBottomTabNavigator;

const Tab = createBottomTabNavigator();
const NativeTab = useNativeTabs ? createNativeBottomTabNavigator() : null;
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
        options={{
          gestureEnabled: false,
          // With the native tab bar we can't hide it per-route — the
          // cleaning flow covers it with a full-screen modal instead.
          presentation: useNativeTabs ? 'fullScreenModal' : 'card',
        }}
      />
    </PhotosStack.Navigator>
  );
}

function VideosNavigator() {
  return (
    <VideosStack.Navigator screenOptions={{ headerShown: false }}>
      <VideosStack.Screen name="VideoAlbumSelect" component={VideoAlbumSelectScreen} />
      <VideosStack.Screen
        name="VideoCleaning"
        component={VideoCleaningScreen}
        options={{ gestureEnabled: false }}
      />
    </VideosStack.Navigator>
  );
}

function ProfileNavigator() {
  // With the native tab bar the tabs cannot be hidden per route, so every
  // screen that owns the whole viewport has to be a full-screen modal.
  // These four position their action bars at a fixed `bottom: 30`, and
  // without this they rendered UNDER the system tab bar — the delete and
  // restore buttons were simply unreachable in native-tab builds.
  const fullScreen = {
    presentation: useNativeTabs ? 'fullScreenModal' : 'card',
  };
  return (
    <ProfileStack.Navigator screenOptions={{ headerShown: false }}>
      <ProfileStack.Screen name="Profile" component={ProfileScreen} />
      <ProfileStack.Screen
        name="RecycleBin"
        component={RecycleBinScreen}
        options={fullScreen}
      />
      <ProfileStack.Screen
        name="BurstClean"
        component={BurstCleanScreen}
        options={fullScreen}
      />
      <ProfileStack.Screen
        name="Insights"
        component={GalleryInsightsScreen}
        options={fullScreen}
      />
      <ProfileStack.Screen
        name="Compress"
        component={CompressScreen}
        options={fullScreen}
      />
    </ProfileStack.Navigator>
  );
}

export default function RootNavigator() {
  const { t } = useSettings();

  if (useNativeTabs) {
    // Real iOS tab bar (SwiftUI TabView, Liquid Glass on iOS 26).
    return (
      <NativeTab.Navigator>
        <NativeTab.Screen
          name="PhotosTab"
          component={PhotosNavigator}
          options={{
            title: t('tab_photos'),
            tabBarIcon: () => ({ sfSymbol: 'photo.on.rectangle' }),
          }}
        />
        <NativeTab.Screen
          name="VideosTab"
          component={VideosNavigator}
          options={{
            title: t('tab_videos'),
            tabBarIcon: () => ({ sfSymbol: 'video' }),
          }}
        />
        <NativeTab.Screen
          name="ProfileTab"
          component={ProfileNavigator}
          options={{
            title: t('tab_profile'),
            tabBarIcon: () => ({ sfSymbol: 'person.crop.circle' }),
          }}
        />
      </NativeTab.Navigator>
    );
  }

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
