import { computed, signal } from '@preact/signals';
import type { AppSettings, Character, LicenseState, LogLine, Queue, RunState, Schedule, UsageDay } from '../shared/types';
import { DEFAULT_APP, IDLE_RUN, activeQueue, get, getQueue, saveQueue, set, watch, watchQueue } from '../shared/storage';
import { licenseStatus, trialDaysLeft } from '../shared/license';
import { dayKey } from '../shared/util';
import { send } from '../shared/messages';

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
/** Set when init() failed: the panel shows the message instead of spinning forever. */
export const loadError = signal('');

export type Tab = 'queue' | 'history' | 'settings';
export const tab = signal<Tab>('queue');
export const selected = signal<Set<string>>(new Set());

/** Sheets that open on top of any tab: the plan (Free vs Pro, licence key) and the characters manager. */
export type Sheet = 'plan' | 'characters' | null;
export const sheet = signal<Sheet>(null);

/** Open the plan sheet, which compares Free and Pro and takes a licence key. */
export function showPlans() {
  sheet.value = 'plan';
}

/** Open Settings with the Advanced section unfolded (e.g. from "Schedule" in the run menu). */
export const settingsSection = signal<'basics' | 'advanced' | null>(null);
export function showSettings(section: 'basics' | 'advanced' = 'basics') {
  settingsSection.value = section;
  tab.value = 'settings';
}

// ---------- Flow status ----------

/** What the open Flow tabs look like: none, a tab without a project, or a project page. */
export type FlowStatus = { state: 'none' | 'tab' | 'project'; tabId?: number };
/** null until the first poll answers. */
export const flowStatus = signal<FlowStatus | null>(null);

const FLOW_POLL_MS = 5000;
let flowTimer: ReturnType<typeof setInterval> | undefined;

async function pollFlow() {
  const tabs = await send<{ id: number; url: string }[]>({ type: 'flow:tabs' }).catch(() => null);
  if (!tabs) return;
  const project = tabs.find((x) => /\/project\//.test(x.url));
  const next: FlowStatus = project ? { state: 'project', tabId: project.id } : tabs.length ? { state: 'tab', tabId: tabs[0].id } : { state: 'none' };
  const cur = flowStatus.value;
  if (!cur || cur.state !== next.state || cur.tabId !== next.tabId) flowStatus.value = next;
}

/** Poll the Flow tabs every few seconds while the panel is visible; stop while it is hidden. */
function watchFlow() {
  const start = () => {
    if (flowTimer) return;
    void pollFlow();
    flowTimer = setInterval(() => void pollFlow(), FLOW_POLL_MS);
  };
  const stop = () => {
    clearInterval(flowTimer);
    flowTimer = undefined;
  };
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  window.addEventListener('focus', () => void pollFlow());
  if (!document.hidden) start();
}

/** Open Flow (or focus the existing tab) and re-check right after. */
export async function openFlow() {
  await send({ type: 'flow:open' }).catch(() => null);
  setTimeout(() => void pollFlow(), 800);
}

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
    if (nq && nq.updatedAt > (queue.value?.updatedAt ?? 0)) queue.value = nq; // ignore echoes of our own debounced saves
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
  watchFlow();
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
  qTimer = setTimeout(() => void flushQueue(), 250);
}

/** Write the pending queue edit now (before a run starts, or when the panel is closing). */
export async function flushQueue() {
  clearTimeout(qTimer);
  qTimer = undefined;
  const cur = queue.value;
  if (cur) await saveQueue(cur);
}
addEventListener('pagehide', () => void flushQueue());

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
