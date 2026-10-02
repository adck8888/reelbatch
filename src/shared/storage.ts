import type { AppSettings, Character, LicenseState, LogLine, Queue, RunState, Schedule, UsageDay } from './types';
import { DEFAULT_SETTINGS } from './models';
import { uid } from './util';

export interface StoreShape {
  settings: AppSettings;
  queueIndex: { id: string; name: string; updatedAt: number }[];
  activeQueue: string;
  run: RunState;
  characters: Character[];
  license: LicenseState;
  usage: UsageDay;
  schedule: Schedule | null;
  logs: LogLine[];
  flowConfig: { fetchedAt: number; config: unknown } | null;
}

export const DEFAULT_APP: AppSettings = {
  lang: 'auto',
  theme: 'system',
  notify: true,
  remoteConfig: true,
  onboarded: false,
  keys: {},
  run: {
    concurrency: 1,
    delayMin: 8,
    delayMax: 20,
    readingPause: 1,
    retries: 2,
    budgetCredits: 0,
    budgetUsd: 0,
    stopAfterFails: 5,
    tabs: [],
    download: {
      enabled: true,
      folder: 'Reelbatch/{queue}',
      filename: '{n}_{prompt30}',
      imageQuality: '1k',
      videoQuality: '720p',
      sidecar: true
    }
  }
};

export const IDLE_RUN: RunState = { status: 'idle', spent: { credits: 0, usd: 0 }, rows: {} };

const DEFAULTS: { [K in keyof StoreShape]: StoreShape[K] } = {
  settings: DEFAULT_APP,
  queueIndex: [],
  activeQueue: '',
  run: IDLE_RUN,
  characters: [],
  license: {},
  usage: { day: '', prompts: 0 },
  schedule: null,
  logs: [],
  flowConfig: null
};

export async function get<K extends keyof StoreShape>(key: K): Promise<StoreShape[K]> {
  const r = await chrome.storage.local.get(key);
  const v = r[key] as StoreShape[K] | undefined;
  if (v === undefined) return structuredClone(DEFAULTS[key]);
  if (key === 'settings') return mergeSettings(v as AppSettings) as StoreShape[K];
  return v;
}

export async function set<K extends keyof StoreShape>(key: K, value: StoreShape[K]) {
  await chrome.storage.local.set({ [key]: value });
}

const chains = new Map<string, Promise<unknown>>();

/** Read-modify-write; calls on the same key run one after another so none is lost. */
export function update<K extends keyof StoreShape>(key: K, fn: (v: StoreShape[K]) => StoreShape[K] | void): Promise<StoreShape[K]> {
  const run = async () => {
    const cur = await get(key);
    const next = fn(cur);
    await set(key, (next === undefined ? cur : next) as StoreShape[K]);
    return (next === undefined ? cur : next) as StoreShape[K];
  };
  const prev = chains.get(key) ?? Promise.resolve();
  const p = prev.then(run, run);
  chains.set(key, p.catch(() => {}));
  return p;
}

/** Subscribe to one key; returns an unsubscribe function. */
export function watch<K extends keyof StoreShape>(key: K, cb: (v: StoreShape[K]) => void) {
  const fn = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && key in changes) {
      const v = changes[key].newValue as StoreShape[K] | undefined;
      cb(v === undefined ? structuredClone(DEFAULTS[key]) : key === 'settings' ? (mergeSettings(v as AppSettings) as StoreShape[K]) : v);
    }
  };
  chrome.storage.onChanged.addListener(fn);
  return () => chrome.storage.onChanged.removeListener(fn);
}

export function mergeSettings(v: Partial<AppSettings>): AppSettings {
  return {
    ...DEFAULT_APP,
    ...v,
    keys: { ...v.keys },
    run: { ...DEFAULT_APP.run, ...v.run, download: { ...DEFAULT_APP.run.download, ...v.run?.download } }
  };
}

// ---------- queues (one storage key per queue) ----------

const qKey = (id: string) => `queue:${id}`;

export async function getQueue(id: string): Promise<Queue | null> {
  const r = await chrome.storage.local.get(qKey(id));
  return (r[qKey(id)] as Queue) ?? null;
}

export async function saveQueue(q: Queue) {
  q.updatedAt = Date.now();
  await chrome.storage.local.set({ [qKey(q.id)]: q });
  await update('queueIndex', (idx) => {
    const i = idx.findIndex((x) => x.id === q.id);
    const entry = { id: q.id, name: q.name, updatedAt: q.updatedAt };
    if (i >= 0) idx[i] = entry;
    else idx.unshift(entry);
  });
}

export async function deleteQueue(id: string) {
  await chrome.storage.local.remove(qKey(id));
  await update('queueIndex', (idx) => idx.filter((x) => x.id !== id));
}

export function newQueue(name: string): Queue {
  const t = Date.now();
  return { id: uid(), name, rows: [], defaults: { ...DEFAULT_SETTINGS }, createdAt: t, updatedAt: t };
}

/** The active queue, created on first use. */
export async function activeQueue(): Promise<Queue> {
  const id = await get('activeQueue');
  const q = id ? await getQueue(id) : null;
  if (q) return q;
  const idx = await get('queueIndex');
  const first = idx[0] ? await getQueue(idx[0].id) : null;
  const res = first ?? newQueue('Queue 1');
  if (!first) await saveQueue(res);
  await set('activeQueue', res.id);
  return res;
}

export function watchQueue(id: string, cb: (q: Queue | null) => void) {
  const fn = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && qKey(id) in changes) cb((changes[qKey(id)].newValue as Queue) ?? null);
  };
  chrome.storage.onChanged.addListener(fn);
  return () => chrome.storage.onChanged.removeListener(fn);
}

// ---------- logs ----------

export async function log(level: LogLine['level'], msg: string) {
  const line: LogLine = { t: Date.now(), level, msg: msg.slice(0, 1000) };
  if (level === 'error') console.warn('[Reelbatch]', msg);
  await update('logs', (l) => {
    l.push(line);
    return l.length > 600 ? l.slice(-500) : l;
  });
}
