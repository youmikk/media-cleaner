import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as statsManager from '../utils/statsManager';
import * as trashManager from '../utils/trashManager';

const FAVORITES_KEY = '@mediacleaner/favorites';

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
      AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites)).catch(
        () => {}
      );
      return { ...state, favorites };
    }
    default:
      return state;
  }
}

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    (async () => {
      const [stats, favRaw, trash] = await Promise.all([
        statsManager.getStats(),
        AsyncStorage.getItem(FAVORITES_KEY),
        trashManager.listTrash(),
      ]);
      let favorites = {};
      try {
        favorites = favRaw ? JSON.parse(favRaw) : {};
      } catch (e) {
        favorites = {};
      }
      dispatch({ type: 'HYDRATE', payload: { stats, favorites, trash } });
    })();
  }, []);

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

  const value = useMemo(
    () => ({
      ...state,
      refreshStats,
      refreshTrash,
      recordViewed,
      recordCleaned,
      toggleFavorite,
      isFavorite: (id) => !!state.favorites[id],
    }),
    [state, refreshStats, refreshTrash, recordViewed, recordCleaned, toggleFavorite]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
