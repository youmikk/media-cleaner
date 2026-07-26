import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

const CACHE_KEY = '@mediacleaner/geocode_cache';
const memoryCache = {};
let persisted = null;

async function loadPersisted() {
  if (persisted) return persisted;
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    persisted = raw ? JSON.parse(raw) : {};
  } catch (e) {
    persisted = {};
  }
  return persisted;
}

function cacheKeyFor(lat, lng) {
  // ~100m grid — nearby photos share one geocode lookup.
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

/**
 * Format a reverse-geocode result into a short human address:
 * zh: 城市·区·街道/地点 · en: street, district, city.
 */
function formatAddress(place, language) {
  if (!place) return null;
  const city = place.city || place.subregion || place.region || '';
  const district = place.district || '';
  const street = place.street || place.name || '';
  if (language === 'zh') {
    const parts = [city, district, street].filter(Boolean);
    return parts.length ? parts.join('·') : null;
  }
  const parts = [street, district, city].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Reverse-geocode a coordinate into a short address string.
 * Cached in memory + AsyncStorage (offline photos re-resolve instantly).
 * Returns null when geocoding is unavailable (no network / no geocoder).
 */
export async function reverseGeocode(latitude, longitude, language = 'zh') {
  if (latitude === undefined || longitude === undefined) return null;
  const key = `${cacheKeyFor(latitude, longitude)}_${language}`;
  if (memoryCache[key] !== undefined) return memoryCache[key];

  const store = await loadPersisted();
  if (store[key] !== undefined) {
    memoryCache[key] = store[key];
    return store[key];
  }

  let address = null;
  try {
    const results = await Location.reverseGeocodeAsync({ latitude, longitude });
    address = formatAddress(results && results[0], language);
  } catch (e) {
    address = null; // geocoder unavailable — degrade gracefully
  }

  memoryCache[key] = address;
  store[key] = address;
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch (e) {
    // best effort
  }
  return address;
}
