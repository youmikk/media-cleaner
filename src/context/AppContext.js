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

  useEffect(() => {
    if (!state.hydrated) return;
    const payload = JSON.stringify(state.favorites);
    favoritesWriteRef.current = favoritesWriteRef.current
      .catch(() => {})
      .then(() => AsyncStorage.setItem(FAVORITES_KEY, payload));
  }, [state.favorites, state.hydrated]);

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
