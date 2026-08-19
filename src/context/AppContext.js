import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as statsManager from '../utils/statsManager';
import * as trashManager from '../utils/trashManager';
import { utf8ByteLength, MAX_VALUE_BYTES } from '../utils/safeStore';

const FAVORITES_KEY = '@mediacleaner/favorites';
const FAVORITES_SHARD_PREFIX = '@mediacleaner/favorites_v2_';
const FAVORITES_WRITE_DELAY_MS = 350;
// Leave room for AsyncStorage/JSON overhead while keeping every shard well
// below Android's per-value limit. Favorites are user data, so split them
// instead of silently dropping old entries when a large library crosses it.
const FAVORITES_SHARD_BYTES = Math.min(1200000, MAX_VALUE_BYTES - 50000);
let favoritesGeneration = 0;

function cleanFavoriteOrphans(retainedKeys) {
  const retained = new Set(retainedKeys || []);
  return AsyncStorage.getAllKeys()
    .then((keys) => {
      const stale = keys.filter(
        (key) => key.startsWith(FAVORITES_SHARD_PREFIX) && !retained.has(key)
      );
      if (stale.length > 0) return AsyncStorage.multiRemove(stale);
      return null;
    })
    .catch(() => {});
}

async function readFavorites() {
  try {
    const raw = await AsyncStorage.getItem(FAVORITES_KEY);
    if (!raw) return { ok: true, value: {} };
    const value = JSON.parse(raw);
    // Backwards compatibility: older releases stored the id -> true map
    // directly at FAVORITES_KEY.
    if (!value || value.version !== 2) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        await cleanFavoriteOrphans([]);
        return { ok: true, value };
      }
      throw new Error('Invalid favorites payload');
    }
    if (!Array.isArray(value.shards)) throw new Error('Invalid favorites manifest');
    const favorites = {};
    // Avoid materialising every shard value at once on very large libraries.
    for (const key of value.shards) {
      // eslint-disable-next-line no-await-in-loop
      const shardRaw = await AsyncStorage.getItem(key);
      if (!shardRaw) throw new Error('Missing favorites shard');
      const shard = JSON.parse(shardRaw);
      if (shard && typeof shard === 'object' && !Array.isArray(shard)) {
        Object.assign(favorites, shard);
      }
    }
    if (
      Number.isFinite(value.count) &&
      Object.keys(favorites).length !== value.count
    ) {
      throw new Error('Incomplete favorites shards');
    }
    await cleanFavoriteOrphans(value.shards);
    return { ok: true, value: favorites };
  } catch (e) {
    // Keep the UI usable, but tell the writer not to replace user data with
    // an empty map after a transient/corrupt read.
    return { ok: false, value: {} };
  }
}

function splitFavorites(favorites) {
  const shards = [];
  let shard = {};
  let bytes = 2; // opening and closing braces
  for (const id of Object.keys(favorites)) {
    const encoded = JSON.stringify(id);
    const entryBytes = utf8ByteLength(encoded) + 6; // colon, true, comma
    if (bytes + entryBytes > FAVORITES_SHARD_BYTES && bytes > 2) {
      shards.push(shard);
      shard = {};
      bytes = 2;
    }
    shard[id] = true;
    bytes += entryBytes;
  }
  if (bytes > 2) shards.push(shard);
  return shards;
}

async function writeFavorites(favorites) {
  const oldRaw = await AsyncStorage.getItem(FAVORITES_KEY).catch(() => null);
  let oldShardKeys = [];
  try {
    const oldManifest = oldRaw ? JSON.parse(oldRaw) : null;
    if (oldManifest && oldManifest.version === 2 && Array.isArray(oldManifest.shards)) {
      oldShardKeys = oldManifest.shards;
    }
  } catch (e) {
    // A valid new manifest below replaces a corrupt legacy value.
  }

  const chunks = splitFavorites(favorites);
  const generation = `${Date.now()}_${favoritesGeneration++}`;
  const shardKeys = chunks.map(
    (_, index) => `${FAVORITES_SHARD_PREFIX}${generation}_${index}`
  );
  try {
    if (chunks.length > 0) {
      await AsyncStorage.multiSet(
        chunks.map((chunk, index) => [shardKeys[index], JSON.stringify(chunk)])
      );
    }
    // Publish the manifest only after every referenced shard exists. A
    // process kill during the write therefore leaves the previous set valid.
    await AsyncStorage.setItem(
      FAVORITES_KEY,
      JSON.stringify({
        version: 2,
        shards: shardKeys,
        count: Object.keys(favorites).length,
      })
    );
    const stale = oldShardKeys.filter((key) => !shardKeys.includes(key));
    if (stale.length > 0) {
      // The new manifest is already live; stale cleanup must never make a
      // successful write look failed and remove its referenced shards.
      AsyncStorage.multiRemove(stale).catch(() => {});
    }
  } catch (e) {
    // New shards are unreachable until the manifest is published; remove
    // them best-effort while preserving the last complete favorite set.
    if (shardKeys.length > 0) AsyncStorage.multiRemove(shardKeys).catch(() => {});
    throw e;
  }
}

const initialState = {
  stats: statsManager.EMPTY_STATS,
  favorites: {},
  trash: [],
  hydrated: false,
};

function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, ...action.payload, hydrated: true };
    case 'SET_STATS':
      return { ...state, stats: action.stats };
    case 'SET_TRASH':
      return { ...state, trash: action.trash };
    case 'TOGGLE_FAVORITE': {
      const favorites = { ...state.favorites };
      if (favorites[action.id]) delete favorites[action.id];
      else favorites[action.id] = true;
      return { ...state, favorites };
    }
    case 'REPLACE_FAVORITE_ID': {
      if (!state.favorites[action.oldId] || action.oldId === action.newId) {
        return state;
      }
      const favorites = { ...state.favorites };
      delete favorites[action.oldId];
      favorites[action.newId] = true;
      return { ...state, favorites };
    }
    default:
      return state;
  }
}

const AppContext = createContext(null);
const FavoritesContext = createContext(null);
const StatsContext = createContext(null);
const TrashContext = createContext(null);

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const favoritesWriteRef = React.useRef(Promise.resolve());
  const favoritesTimerRef = React.useRef(null);
  const latestFavoritesRef = React.useRef(initialState.favorites);
  const favoritesReadableRef = React.useRef(false);

  const enqueueFavoritesWrite = useCallback((snapshot) => {
    favoritesWriteRef.current = favoritesWriteRef.current
      .catch(() => {})
      .then(() => writeFavorites(snapshot))
      .catch(() => {});
  }, []);

  useEffect(() => {
    (async () => {
      const [stats, favoriteResult, trash] = await Promise.all([
        statsManager.getStats(),
        readFavorites(),
        trashManager.listTrash(),
      ]);
      favoritesReadableRef.current = favoriteResult.ok;
      const favorites = favoriteResult.value;
      dispatch({ type: 'HYDRATE', payload: { stats, favorites, trash } });
    })();
  }, []);

  useEffect(() => {
    if (!state.hydrated || !favoritesReadableRef.current) return;
    latestFavoritesRef.current = state.favorites;
    if (favoritesTimerRef.current) clearTimeout(favoritesTimerRef.current);
    favoritesTimerRef.current = setTimeout(() => {
      favoritesTimerRef.current = null;
      const snapshot = latestFavoritesRef.current;
      enqueueFavoritesWrite(snapshot);
    }, FAVORITES_WRITE_DELAY_MS);
    return () => {
      if (favoritesTimerRef.current) clearTimeout(favoritesTimerRef.current);
    };
  }, [state.favorites, state.hydrated, enqueueFavoritesWrite]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (
        nextState === 'active' ||
        !favoritesReadableRef.current ||
        !favoritesTimerRef.current
      ) {
        return;
      }
      clearTimeout(favoritesTimerRef.current);
      favoritesTimerRef.current = null;
      enqueueFavoritesWrite(latestFavoritesRef.current);
    });
    return () => subscription.remove();
  }, [enqueueFavoritesWrite]);

  useEffect(
    () => () => {
      // React Native normally keeps the provider mounted for the process
      // lifetime, but flush the latest state if navigation/tests unmount it.
      if (!favoritesTimerRef.current || !favoritesReadableRef.current) return;
      clearTimeout(favoritesTimerRef.current);
      favoritesTimerRef.current = null;
      const snapshot = latestFavoritesRef.current;
      enqueueFavoritesWrite(snapshot);
    },
    [enqueueFavoritesWrite]
  );

  const refreshStats = useCallback(async () => {
    const stats = await statsManager.getStats();
    dispatch({ type: 'SET_STATS', stats });
  }, []);

  const recordViewed = useCallback(
    async (mediaType, count = 1) => {
      await statsManager.recordViewed(mediaType, count);
      refreshStats();
    },
    [refreshStats]
  );

  const recordCleaned = useCallback(
    async (mediaType, count, bytes) => {
      await statsManager.recordCleaned(mediaType, count, bytes);
      refreshStats();
    },
    [refreshStats]
  );

  const refreshTrash = useCallback(async () => {
    const trash = await trashManager.listTrash();
    dispatch({ type: 'SET_TRASH', trash });
  }, []);

  const toggleFavorite = useCallback((id) => {
    dispatch({ type: 'TOGGLE_FAVORITE', id });
  }, []);

  const replaceFavoriteId = useCallback((oldId, newId) => {
    if (!oldId || !newId) return;
    dispatch({ type: 'REPLACE_FAVORITE_ID', oldId, newId });
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      refreshStats,
      refreshTrash,
      recordViewed,
      recordCleaned,
      toggleFavorite,
      replaceFavoriteId,
      isFavorite: (id) => !!state.favorites[id],
    }),
    [
      state,
      refreshStats,
      refreshTrash,
      recordViewed,
      recordCleaned,
      toggleFavorite,
      replaceFavoriteId,
    ]
  );

  const favoritesValue = useMemo(
    () => ({
      favorites: state.favorites,
      toggleFavorite,
      replaceFavoriteId,
      isFavorite: (id) => !!state.favorites[id],
    }),
    [state.favorites, toggleFavorite, replaceFavoriteId]
  );
  const statsValue = useMemo(
    () => ({ stats: state.stats, refreshStats, recordViewed, recordCleaned }),
    [state.stats, refreshStats, recordViewed, recordCleaned]
  );
  const trashValue = useMemo(
    () => ({ trash: state.trash, refreshTrash }),
    [state.trash, refreshTrash]
  );

  return (
    <AppContext.Provider value={value}>
      <FavoritesContext.Provider value={favoritesValue}>
        <StatsContext.Provider value={statsValue}>
          <TrashContext.Provider value={trashValue}>
            {children}
          </TrashContext.Provider>
        </StatsContext.Provider>
      </FavoritesContext.Provider>
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

/** Favorites-only selector: stats/trash refreshes do not rerender its users. */
export function useFavorites() {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error('useFavorites must be used within AppProvider');
  return ctx;
}

export function useStats() {
  const ctx = useContext(StatsContext);
  if (!ctx) throw new Error('useStats must be used within AppProvider');
  return ctx;
}

export function useTrash() {
  const ctx = useContext(TrashContext);
  if (!ctx) throw new Error('useTrash must be used within AppProvider');
  return ctx;
}
