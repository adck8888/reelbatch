import { computed, signal } from '@preact/signals';
import type { AppSettings, Character, LicenseState, LogLine, Queue, RunState, Schedule, UsageDay } from '../shared/types';
import { DEFAULT_APP, IDLE_RUN, activeQueue, get, getQueue, saveQueue, set, watch, watchQueue } from '../shared/storage';
import { licenseStatus, trialDaysLeft } from '../shared/license';
import { dayKey } from '../shared/util';

export const settings = signal<AppSettings>(DEFAULT_APP);
export const queue = signal<Queue | null>(null);
export const queueIndex = signal<{ id: string; name: string; updatedAt: number }[]>([]);
export const run = signal<RunState>(IDLE_RUN);
export const license = signal<LicenseState>({});
export const usage = signal<UsageDay>({ day: '', prompts: 0 });
export const characters = signal<Character[]>([]);
export const logs = signal<LogLine[]>([]);
export const schedule = signal<Schedule | null>(null);
export const ready = signal(false);

export type Tab = 'queue' | 'characters' | 'history' | 'settings';
export const tab = signal<Tab>('queue');
export const selected = signal<Set<string>>(new Set());

export const plan = computed(() => licenseStatus(license.value));
export const pro = computed(() => plan.value !== 'free');
export const trialLeft = computed(() => trialDaysLeft(license.value));
export const usedToday = computed(() => (usage.value.day === dayKey() ? usage.value.prompts : 0));
export const running = computed(() => run.value.status !== 'idle');

let unwatchQueue: (() => void) | null = null;

function bindQueue(q: Queue) {
  queue.value = q;
  unwatchQueue?.();
  unwatchQueue = watchQueue(q.id, (nq) => {
    if (nq && nq.updatedAt !== queue.value?.updatedAt) queue.value = nq;
  });
}

export async function init() {
  const q = await activeQueue(); // may create the first queue, so read the index after it
  const [s, idx, r, l, u, c, lg, sc] = await Promise.all([
    get('settings'), get('queueIndex'), get('run'), get('license'), get('usage'), get('characters'), get('logs'), get('schedule')
  ]);
  settings.value = s;
  queueIndex.value = idx;
  run.value = r;
  license.value = l;
  usage.value = u;
  characters.value = c;
  logs.value = lg;
  schedule.value = sc;
  bindQueue(q);
  watch('settings', (v) => (settings.value = v));
  watch('queueIndex', (v) => (queueIndex.value = v));
  watch('run', (v) => (run.value = v));
  watch('license', (v) => (license.value = v));
  watch('usage', (v) => (usage.value = v));
  watch('characters', (v) => (characters.value = v));
  watch('logs', (v) => (logs.value = v));
  watch('schedule', (v) => (schedule.value = v));
  ready.value = true;
}

// ---------- mutations ----------

let qTimer: ReturnType<typeof setTimeout> | undefined;

/** Change the active queue locally and persist (debounced). */
export function editQueue(fn: (q: Queue) => void) {
  const cur = queue.value;
  if (!cur) return;
  const next = structuredClone(cur);
  fn(next);
  next.updatedAt = Date.now();
  queue.value = next;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => void saveQueue(next), 250);
}

export async function switchQueue(id: string) {
  const q = await getQueue(id);
  if (!q) return;
  await set('activeQueue', id);
  selected.value = new Set();
  bindQueue(q);
}

export async function createQueue(q: Queue) {
  await saveQueue(q);
  await switchQueue(q.id);
}

export async function saveSettings(fn: (s: AppSettings) => void) {
  const next = structuredClone(settings.value);
  fn(next);
  settings.value = next;
  await set('settings', next);
}

export async function saveCharacters(list: Character[]) {
  characters.value = list;
  await set('characters', list);
}
