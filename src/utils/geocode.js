import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { readJSON, withLock } from './safeStore';

const CACHE_KEY = '@mediacleaner/geocode_cache';
const memoryCache = {};
let persisted = null;
// Bounded like every other large writer here: an unbounded map of ~100 m
// grid cells crosses Android's silent ~2 MB per-value limit on a well
// travelled library and takes the WHOLE cache down with it.
const MAX_ENTRIES = 1500;
// Coalesce writes: the old code re-serialised the entire growing map on
// every cache miss, i.e. once per swiped photo, on the JS thread.
const PERSIST_DELAY_MS = 3000;
let persistTimer = null;
// One in-flight lookup per cell — a fast swipe used to fire the same
// coordinate at the geocoder several times over.
const inFlight = new Map();

async function loadPersisted() {
  if (persisted) return persisted;
  const { value } = await readJSON(CACHE_KEY);
  persisted = value && typeof value === 'object' ? value : {};
  return persisted;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    await withLock(CACHE_KEY, async () => {
      if (!persisted) return;
      let keys = Object.keys(persisted);
      if (keys.length > MAX_ENTRIES) {
        // Insertion-ordered string keys ("lat,lng_lang" is never an integer
        // index), so the head really is the oldest.
        const drop = keys.length - MAX_ENTRIES;
        for (let i = 0; i < drop; i++) delete persisted[keys[i]];
      }
      try {
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(persisted));
      } catch (e) {
        // best effort
      }
    });
  }, PERSIST_DELAY_MS);
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
 *
 * A FAILED lookup is never cached. It used to be stored as null, and since
 * the cache hit test was `!== undefined`, that null was permanent: browsing
 * 50 geotagged photos in airplane mode meant those 50 places could never
 * display an address again short of clearing app data.
 */
export async function reverseGeocode(latitude, longitude, language = 'zh') {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const key = `${cacheKeyFor(latitude, longitude)}_${language}`;
  if (memoryCache[key] !== undefined) return memoryCache[key];

  const store = await loadPersisted();
  if (store[key] !== undefined) {
    memoryCache[key] = store[key];
    return store[key];
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    try {
      const results = await Location.reverseGeocodeAsync({
        latitude,
        longitude,
      });
      const address = formatAddress(results && results[0], language);
      // Resolved — including "resolved to nothing", which is a real answer
      // about this coordinate and worth remembering.
      memoryCache[key] = address;
      store[key] = address;
      schedulePersist();
      return address;
    } catch (e) {
      // Geocoder unavailable / throttled / offline: transient, so do NOT
      // write it to either cache. The next attempt gets to try again.
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return task;
}
