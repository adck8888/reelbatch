import type { FlowCommand, FlowResult, FlowSnapshot, HealthReport, PrepareOutcome, WatchOutcome } from '../shared/messages';
import type { GenSettings } from '../shared/types';
import { modelById } from '../shared/models';
import { blobToDataUrl, sleep } from '../shared/util';
import { log } from '../shared/storage';
import { flowConfig } from './config';
import * as dbg from './debugger';

export const FLOW_URL = 'https://flow.google.com/';

export type FlowFailReason = Extract<WatchOutcome, { ok: false }>['reason'] | 'setup' | 'budget';

export class FlowError extends Error {
  constructor(public reason: FlowFailReason, message: string, public results: FlowResult[] = []) {
    super(message);
  }
}

export async function flowTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://flow.google.com/*' });
  return tabs.filter((t) => t.id !== undefined);
}

export async function openFlowTab(active = true) {
  const tab = await chrome.tabs.create({ url: FLOW_URL, active });
  return tab.id!;
}

export async function sendTab<T>(tabId: number, cmd: FlowCommand | { type: 'config'; config: unknown }, timeoutMs = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, cmd) as Promise<T>,
      new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('The Flow tab stopped responding')), timeoutMs)))
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Make sure our scripts run in the tab (tabs opened before install/update need injection). */
export async function ensureContent(tabId: number) {
  try {
    const r = await sendTab<{ ok: boolean }>(tabId, { type: 'ping' }, 3000);
    if (r?.ok) return;
  } catch {
    /* inject below */
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['flow-page.js'], world: 'MAIN' }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId }, files: ['flow-content.js'] });
  await sleep(300);
  await sendTab(tabId, { type: 'config', config: await flowConfig() }, 3000).catch(() => {});
}

export async function waitForTabLoad(tabId: number, timeoutMs = 45_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new FlowError('setup', 'The Flow tab was closed');
    if (t.status === 'complete') return;
    await sleep(400);
  }
}

export async function health(tabId?: number): Promise<HealthReport> {
  const id = tabId ?? (await flowTabs())[0]?.id;
  if (id === undefined) return { ok: false, items: [{ key: 'tab', ok: false, detail: 'No Flow tab is open' }] };
  try {
    await ensureContent(id);
    const r = await sendTab<HealthReport>(id, { type: 'health' }, 8000);
    return { ...r, tabId: id };
  } catch (e) {
    return { ok: false, tabId: id, items: [{ key: 'tab', ok: false, detail: e instanceof Error ? e.message : String(e) }] };
  }
}

export interface FlowJob {
  tabId: number;
  prompt: string;
  settings: GenSettings;
  refs: Blob[];
  startFrame?: Blob;
  endFrame?: Blob;
  /** Several jobs render at once in this tab: match results by prompt text. */
  parallel: boolean;
  signal: AbortSignal;
  /** Called with Flow's live cost before submitting; throw to cancel (budget guard). */
  approveCost: (cost: number) => Promise<void> | void;
  onStatus: (s: 'sending' | 'rendering') => void;
}

export interface FlowJobResult {
  results: FlowResult[];
  cost: number;
  partial?: boolean;
}

// One UI interaction at a time per tab: preparing settings and typing must not interleave.
const tabLocks = new Map<number, Promise<unknown>>();
async function withTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = tabLocks.get(tabId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  tabLocks.set(tabId, prev.then(() => mine));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Files are named by content hash so an image reused across rows is uploaded to Flow only once. */
async function toFiles(blobs: Blob[]) {
  return Promise.all(
    blobs.map(async (b) => {
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await b.arrayBuffer()));
      const id = [...hash.slice(0, 6)].map((x) => x.toString(16).padStart(2, '0')).join('');
      const type = b.type || 'image/png';
      return { name: `rb-${id}.${type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'}`, type, dataUrl: await blobToDataUrl(b) };
    })
  );
}

const simplify = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

export async function runFlowJob(job: FlowJob): Promise<FlowJobResult> {
  const { tabId, settings } = job;
  const model = modelById(settings.model);
  if (!model || model.engine !== 'flow') throw new FlowError('setup', `Unknown Flow model ${settings.model}`);
  const cfg = await flowConfig();
  await ensureContent(tabId);

  const submitted = await withTabLock(tabId, async () => {
    job.signal.throwIfAborted();
    await dbg.attach(tabId);
    await sendTab(tabId, { type: 'dismiss' });

    const prep = await sendTab<PrepareOutcome>(tabId, { type: 'prepare', settings, target: model.target }, 30_000);
    if (!prep.ok) throw new FlowError('setup', prep.error ?? 'Could not apply settings in Flow');
    const cost = prep.cost ?? model.cost(settings) * settings.count;
    await job.approveCost(cost);

    // reference images / frames
    const wantsAttach = job.refs.length || job.startFrame || job.endFrame;
    await sendTab(tabId, { type: 'clearAttachments' }, 15_000).catch(() => {});
    if (wantsAttach) {
      if (job.startFrame) await attach(tabId, 'start', [job.startFrame]);
      if (job.endFrame) await attach(tabId, 'end', [job.endFrame]);
      if (job.refs.length) await attach(tabId, 'refs', job.refs);
    }

    const before = await sendTab<FlowSnapshot>(tabId, { type: 'snapshot' });
    if (before.alerts.some((a) => new RegExp(cfg.text.unusual, 'i').test(a))) throw new FlowError('unusual', before.alerts[0]);

    job.onStatus('sending');
    const focus = await sendTab<{ ok: boolean; error?: string }>(tabId, { type: 'focusEditor' });
    if (!focus.ok) throw new FlowError('setup', focus.error ?? 'Prompt box not found');
    await dbg.click(tabId, '[data-rb="editor"]');
    await dbg.selectAllAndDelete(tabId);
    await dbg.insertText(tabId, job.prompt);
    await sleep(250);
    const typed = await sendTab<{ text: string }>(tabId, { type: 'editorText' });
    if (!simplify(typed.text).startsWith(simplify(job.prompt).slice(0, 40))) throw new FlowError('setup', 'Flow did not accept the typed prompt');

    const gen = await sendTab<{ ok: boolean; disabled?: boolean; error?: string }>(tabId, { type: 'markGenerate' });
    if (!gen.ok) throw new FlowError('setup', gen.error ?? 'Generate button not found');
    if (gen.disabled) throw new FlowError('setup', 'Flow’s Generate button is disabled (check attachments and settings)');
    const since = Date.now();
    await dbg.click(tabId, '[data-rb="gen"]');

    // Confirm the submission landed: the editor clears or a new tile starts rendering.
    let landed = false;
    for (let i = 0; i < 16 && !landed; i++) {
      await sleep(400);
      const [t, snap] = await Promise.all([
        sendTab<{ text: string }>(tabId, { type: 'editorText' }),
        sendTab<FlowSnapshot>(tabId, { type: 'snapshot' })
      ]);
      landed = !t.text || snap.rendering > before.rendering || snap.mediaIds.length > before.mediaIds.length;
      if (i === 8 && !landed) await dbg.key(tabId, 'Enter');
    }
    if (!landed) throw new FlowError('setup', 'Flow did not start the generation');
    return { since, known: before.mediaIds, cost };
  });

  job.onStatus('rendering');
  const timeoutMs = (settings.kind === 'video' ? cfg.timing.videoTimeoutSec : cfg.timing.imageTimeoutSec) * 1000;
  const outcome = await sendTab<WatchOutcome>(
    tabId,
    {
      type: 'watch',
      since: submitted.since,
      known: submitted.known,
      expect: settings.count,
      kind: settings.kind,
      timeoutMs,
      prompt: job.parallel ? job.prompt : ''
    },
    timeoutMs + 30_000
  );
  if (!outcome.ok) throw new FlowError(outcome.reason, outcome.message, outcome.results);
  return { results: outcome.results, cost: submitted.cost, partial: outcome.partial };
}

async function attach(tabId: number, slot: 'refs' | 'start' | 'end', blobs: Blob[]) {
  const files = await toFiles(blobs);
  const r = await sendTab<{ ok: boolean; error?: string }>(tabId, { type: 'attach', slot, files }, 60_000);
  if (!r.ok) throw new FlowError('setup', r.error ?? 'Could not attach images in Flow');
}

/** Ask Flow for an upscaled download via its own menu. Resolves with the quality actually used. */
export async function flowMenuDownload(tabId: number, mediaId: string, quality: string) {
  await ensureContent(tabId);
  return withTabLock(tabId, () => sendTab<{ ok: boolean; quality?: string; error?: string }>(tabId, { type: 'download', mediaId, quality }, 20_000));
}

export async function releaseTabs(tabIds: number[]) {
  for (const id of tabIds) await dbg.detach(id);
}

export async function logFlow(msg: string) {
  await log('info', `[flow] ${msg}`);
}
