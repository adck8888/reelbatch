import type { FlowCommand, FlowResult, FlowSnapshot, HealthReport, PrepareOutcome, WatchOutcome } from '../shared/messages';
import type { GenSettings } from '../shared/types';
import { modelById } from '../shared/models';
import { blobToDataUrl, sleep } from '../shared/util';
import { log } from '../shared/storage';
import { flowConfig } from './config';
import * as dbg from './debugger';

export const FLOW_URL = 'https://flow.google.com/';

export type FlowFailReason = Extract<WatchOutcome, { ok: false }>['reason'] | 'setup' | 'budget';

/**
 * When the error happened relative to pressing Generate:
 * before: nothing was sent, safe to retry; unconfirmed: Generate was pressed but Flow showed no sign
 * of it; after: Flow accepted the prompt (credits may be spent, a retry would generate again).
 */
export type FlowPhase = 'before' | 'unconfirmed' | 'after';

export class FlowError extends Error {
  constructor(
    public reason: FlowFailReason,
    message: string,
    public results: FlowResult[] = [],
    public phase: FlowPhase = 'before'
  ) {
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
  for (let i = 0; i < 2; i++) {
    try {
      const r = await sendTab<{ ok: boolean }>(tabId, { type: 'ping' }, 3000);
      if (r?.ok) return;
    } catch {
      /* not there (or busy): ask once more, then inject */
    }
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
  /** 'rendering' means Flow accepted the prompt: from here on credits count as spent. */
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
    // read warnings before dismissing dialogs: "unusual activity" must not be clicked away
    const pre = await sendTab<FlowSnapshot>(tabId, { type: 'snapshot' });
    const warn = pre.alerts.find((a) => new RegExp(cfg.text.unusual, 'i').test(a));
    if (warn) throw new FlowError('unusual', warn.slice(0, 200));
    await sendTab(tabId, { type: 'dismiss' });

    const prep = await sendTab<PrepareOutcome>(tabId, { type: 'prepare', settings, target: model.target }, 30_000);
    if (!prep.ok) throw new FlowError('setup', prep.error ?? 'Could not apply settings in Flow');
    const cost = prep.cost ?? model.cost(settings) * settings.count;
    await job.approveCost(cost);

    // reference images / frames: leftovers from the previous prompt must be gone first
    const cleared = await sendTab<{ ok: boolean; left?: number }>(tabId, { type: 'clearAttachments' }, 20_000);
    if (cleared.left) throw new FlowError('setup', 'Could not remove the previous prompt’s images in Flow');
    if (job.startFrame) await attach(tabId, 'start', [job.startFrame]);
    if (job.endFrame) await attach(tabId, 'end', [job.endFrame]);
    if (job.refs.length) await attach(tabId, 'refs', job.refs);
    job.signal.throwIfAborted();

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
    job.signal.throwIfAborted();
    const since = Date.now();
    await dbg.click(tabId, '[data-rb="gen"]');

    // Confirm the submission landed: Flow sent a generate request, the editor cleared, or a new
    // tile started rendering. Generate is pressed once only: pressing again could pay twice.
    let req = 0;
    let landed = false;
    for (let i = 0; i < 25 && !(landed && req); i++) {
      await sleep(400);
      const [claim, t, snap] = await Promise.all([
        req ? Promise.resolve({ id: req }) : sendTab<{ id: number }>(tabId, { type: 'claimRequest', since }),
        sendTab<{ text: string }>(tabId, { type: 'editorText' }),
        sendTab<FlowSnapshot>(tabId, { type: 'snapshot' })
      ]);
      req = claim.id;
      landed ||= !!req || !t.text || snap.rendering > before.rendering || snap.mediaIds.length > before.mediaIds.length;
      // image requests are recognised by id; video ones may not be, so a visible sign is enough
      if (landed && !req && i >= 4) break;
    }
    if (!landed)
      throw new FlowError(
        'error',
        'Generate was pressed but Flow showed no sign of starting. Check the Flow tab; if nothing is rendering there, use Retry failed.',
        [],
        'unconfirmed'
      );
    return { since, known: before.mediaIds, cost, req };
  });

  job.onStatus('rendering');
  const timeoutMs = (settings.kind === 'video' ? cfg.timing.videoTimeoutSec : cfg.timing.imageTimeoutSec) * 1000;
  const watchId = crypto.randomUUID();
  const onAbort = () => void sendTab(tabId, { type: 'cancelWatch', id: watchId }, 5000).catch(() => {});
  job.signal.addEventListener('abort', onAbort, { once: true });
  let outcome: WatchOutcome;
  try {
    outcome = await sendTab<WatchOutcome>(
      tabId,
      {
        type: 'watch',
        id: watchId,
        since: submitted.since,
        known: submitted.known,
        expect: settings.count,
        kind: settings.kind,
        timeoutMs,
        prompt: job.prompt,
        req: submitted.req,
        parallel: job.parallel
      },
      timeoutMs + 30_000
    );
  } catch (e) {
    job.signal.throwIfAborted();
    throw new FlowError('timeout', `Lost contact with the Flow tab while waiting for the result (${e instanceof Error ? e.message : e})`, [], 'after');
  } finally {
    job.signal.removeEventListener('abort', onAbort);
  }
  job.signal.throwIfAborted();
  if (!outcome.ok) throw new FlowError(outcome.reason, outcome.message, outcome.results, 'after');
  return { results: outcome.results, cost: submitted.cost, partial: outcome.partial };
}

async function attach(tabId: number, slot: 'refs' | 'start' | 'end', blobs: Blob[]) {
  const files = await toFiles(blobs);
  // the content script waits up to 90 s for Flow to process an upload, plus the picker steps
  const r = await sendTab<{ ok: boolean; error?: string }>(tabId, { type: 'attach', slot, files }, 150_000);
  if (!r.ok) throw new FlowError('setup', r.error ?? 'Could not attach images in Flow');
}

/** Ask Flow for an upscaled download via its own menu. Resolves with the quality actually used. */
export async function flowMenuDownload(tabId: number, mediaId: string, quality: string) {
  await ensureContent(tabId);
  return withTabLock(tabId, () => sendTab<{ ok: boolean; quality?: string; error?: string }>(tabId, { type: 'download', mediaId, quality }, 20_000));
}

// Flow names its own downloads, so a menu download is matched to its file by order. One menu
// download at a time across all tabs keeps that order unambiguous.
let menuChain: Promise<unknown> = Promise.resolve();
export function serialMenuDownload<T>(fn: () => Promise<T>): Promise<T> {
  const run = menuChain.then(fn, fn);
  menuChain = run.catch(() => {});
  return run;
}

export async function releaseTabs(tabIds: number[]) {
  for (const id of tabIds) await dbg.detach(id);
}

export async function logFlow(msg: string) {
  await log('info', `[flow] ${msg}`);
}
