import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { readJSON, withLock } from './safeStore';

const KEY = '@mediacleaner/suggestion_reviewed_v1';
const CAP = 20000;
let memo = null;
let unreadable = false;
let dirty = false;
let flushTimer = null;

async function load() {
  if (memo) return memo;
  const result = await readJSON(KEY);
  if (!result.ok) {
    unreadable = true;
    return null;
  }
  const value = result.value && typeof result.value === 'object' ? result.value : {};
  memo = new Map(
    Object.entries(value).map(([name, ids]) => [name, new Set(Array.isArray(ids) ? ids : [])])
  );
  return memo;
}

async function flush() {
  if (!dirty || unreadable || !memo) return;
  dirty = false;
  await withLock(KEY, async () => {
    const value = {};
    let remaining = CAP;
    for (const [name, ids] of memo.entries()) {
      const list = [...ids].slice(-remaining);
      value[name] = list;
      remaining -= list.length;
      if (remaining <= 0) break;
    }
    try {
      await AsyncStorage.setItem(KEY, JSON.stringify(value));
    } catch (e) {
      dirty = true;
    }
  });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => {});
  }, 1500);
}

try {
  AppState.addEventListener('change', (state) => {
    if (state !== 'active') flush().catch(() => {});
  });
} catch (e) {
  // AppState is unavailable in a few older runtimes; the timer still flushes.
}

export async function getReviewed(name) {
  const store = await load();
  return new Set(store?.get(name) || []);
}

export async function addReviewed(name, ids = []) {
  const store = await load();
  if (!store || !name) return;
  let set = store.get(name);
  if (!set) {
    set = new Set();
    store.set(name, set);
  }
  ids.forEach((id) => id && set.add(id));
  dirty = true;
  scheduleFlush();
}

export async function flushReviewed() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();
}
