import type { AppSettings, Character, GenSettings, MediaKind, Queue, ResultMedia, Row, RowRun, RunScope, RunState } from '../shared/types';
import type { Estimate } from '../shared/messages';
import { effectiveSettings, estimateCost, modelById, modelsFor } from '../shared/models';
import { resolveMentions } from '../shared/characters';
import { PRO, isPro } from '../shared/license';
import { IDLE_RUN, get, getQueue, log, set, update } from '../shared/storage';
import { addHistory, deleteAsset, listHistory, makeThumb, putAsset, resolveRef } from '../shared/idb';
import { buildPath, renderName } from '../shared/template';
import { dayKey, errText, isAbort, rand, sleep, uid } from '../shared/util';
import { FlowError, ensureContent, flowMenuDownload, flowTabs, health, openFlowTab, releaseTabs, runFlowJob, serialMenuDownload, waitForTabLoad } from './flow';
import { ApiError, type ApiOutput } from '../engines/api/types';
import { runGemini } from '../engines/api/gemini';
import { runReplicate } from '../engines/api/replicate';
import { cancelFlowExpectations, downloadBlob, downloadText, downloadUrl, expectFlowDownload, waitComplete, type Saved } from './downloads';
import { onUserCancel } from './debugger';
import { offscreen } from './offscreen';

// ---------------------------------------------------------------------------
// Run state: one run at a time, mirrored to storage so the panel can render it
// and so an interrupted run can be continued after the service worker restarts.
// ---------------------------------------------------------------------------

let state: RunState = structuredClone(IDLE_RUN);
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void set('run', state);
  }, 300);
}

async function flush() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  await set('run', state);
}

interface Ctl {
  abort: AbortController;
  queue: Queue;
  settings: AppSettings;
  chars: Character[];
  pro: boolean;
  pending: Row[];
  /** Rows that belong to this run (chained rows only wait for these). */
  inRun: Set<string>;
  tabs: number[];
  /** Per Flow tab: earliest time the next prompt may be submitted (human-like pacing). */
  nextSlot: Map<number, number>;
  /** Last output of a row, kept for chaining into the next row (image or last video frame). */
  chainOut: Map<string, Blob>;
  failsInRow: number;
  unusual: number;
  keepAlive?: ReturnType<typeof setInterval>;
}

let ctl: Ctl | null = null;

export const runState = () => state;

const TERMINAL = new Set(['done', 'failed', 'skipped']);

function rowRun(id: string): RowRun {
  return (state.rows[id] ??= { status: 'queued', attempts: 0, results: [] });
}

function setStatus(status: RunState['status'], message?: string) {
  state.status = status;
  state.message = message;
  save();
}

// ---------------------------------------------------------------------------
// Scope, gating and estimates
// ---------------------------------------------------------------------------

function rowsInScope(q: Queue, scope: RunScope, prev: RunState): Row[] {
  const enabled = q.rows.filter((r) => r.enabled && r.prompt.trim());
  const prevRows = prev.queueId === q.id ? prev.rows : {};
  switch (scope.kind) {
    case 'all':
      return enabled;
    case 'failed':
      return enabled.filter((r) => prevRows[r.id]?.status === 'failed');
    case 'pending':
      return enabled.filter((r) => !['done', 'skipped'].includes(prevRows[r.id]?.status ?? ''));
    case 'selected': {
      const ids = new Set(scope.ids);
      return q.rows.filter((r) => ids.has(r.id) && r.prompt.trim());
    }
    case 'range':
      return q.rows.slice(Math.max(0, scope.from - 1), scope.to).filter((r) => r.enabled && r.prompt.trim());
  }
}

function proReasons(q: Queue, rows: Row[], s: AppSettings, chars: Character[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const g = effectiveSettings(q.defaults, r.overrides);
    if (g.engine !== 'flow') out.add('API generation (your own Gemini / Replicate key)');
    else if (modelById(g.model)?.pro) out.add(`${modelById(g.model)!.label}`);
    if (r.chain) out.add('Chaining');
    if (hasMotion(r, g)) out.add('Image→video pipeline');
    if (resolveMentions(r.prompt, chars).used.length) out.add('Characters (@mentions)');
  }
  // parallel tabs and upscaled downloads are not blockers: Free runs them one at a time, in original quality
  return [...out];
}

async function freeLeft() {
  const u = await get('usage');
  return Math.max(0, PRO.freePerDay - (u.day === dayKey() ? u.prompts : 0));
}

/** Count one prompt toward the free daily limit. False when the limit is reached. */
async function takeFreeSlot() {
  let ok = false;
  await update('usage', (u) => {
    const cur = u.day === dayKey() ? u : { day: dayKey(), prompts: 0 };
    ok = cur.prompts < PRO.freePerDay;
    return ok ? { day: cur.day, prompts: cur.prompts + 1 } : cur;
  });
  return ok;
}

/** Give back a slot for a prompt that never reached Flow or the API. */
async function releaseFreeSlot() {
  await update('usage', (u) => (u.day === dayKey() && u.prompts > 0 ? { day: u.day, prompts: u.prompts - 1 } : u));
}

const hasMotion = (r: Row, g: GenSettings) => !!r.motionPrompt?.trim() && g.kind === 'image';

export async function estimate(queueId: string, scope: RunScope): Promise<Estimate> {
  const q = await getQueue(queueId);
  if (!q) throw new Error('Queue not found');
  const settings = await get('settings');
  const pro = isPro(await get('license'));
  const rows = rowsInScope(q, scope, await get('run'));
  let outputs = 0;
  let credits = 0;
  let usd = 0;
  for (const r of rows) {
    const g = effectiveSettings(q.defaults, r.overrides);
    const steps = [g];
    if (hasMotion(r, g)) steps.push(motionSettings(g));
    for (const st of steps) {
      outputs += st.count;
      const c = estimateCost(st);
      if (st.engine === 'flow') credits += c;
      else usd += c;
    }
  }
  return {
    rows: rows.length,
    outputs,
    credits: Math.round(credits),
    usd: Math.round(usd * 100) / 100,
    freeLeft: pro ? null : await freeLeft(),
    proNeeded: pro ? [] : proReasons(q, rows, settings, await get('characters'))
  };
}

function motionSettings(img: GenSettings): GenSettings {
  const video = modelsFor(img.engine, 'video');
  // a motion model left over from another engine is ignored
  const chosen = img.motionModel ? modelById(img.motionModel) : undefined;
  const model = chosen?.kind === 'video' && chosen.engine === img.engine ? chosen.id : video[0]?.id;
  const m = modelById(model ?? '');
  return effectiveSettings(
    { ...img, engine: m?.engine ?? img.engine, kind: 'video', model: model ?? '', videoMode: 'frames', count: 1 },
    {}
  );
}

// ---------------------------------------------------------------------------
// Start / pause / resume / stop
// ---------------------------------------------------------------------------

export async function start(queueId: string, scope: RunScope, opts: { continuing?: boolean } = {}) {
  if (ctl) throw new Error('A run is already in progress');
  const q = await getQueue(queueId);
  if (!q) throw new Error('Queue not found');
  const settings = await get('settings');
  const pro = isPro(await get('license'));
  const prev = await get('run');
  const keep = !!opts.continuing && prev.queueId === q.id;
  // Continuing an interrupted run: only the rows of that run that never started.
  const rows = keep
    ? q.rows.filter((r) => r.prompt.trim() && prev.rows[r.id]?.status === 'queued')
    : rowsInScope(q, scope, prev);
  if (!rows.length) {
    if (keep) throw new Error('Nothing left to continue. Rows that were interrupted are marked failed — use Retry failed.');
    throw new Error(scope.kind === 'failed' ? 'No failed rows to retry' : 'Nothing to run: add prompts or enable rows');
  }

  if (!pro) {
    const need = proReasons(q, rows, settings, await get('characters'));
    if (need.length) throw new Error(`Needs Reelbatch Pro: ${need.join(', ')}. Start the free 7-day trial or switch these rows to Flow.`);
    if ((await freeLeft()) <= 0) throw new Error(`The free plan runs ${PRO.freePerDay} prompts a day. Upgrade to Pro for unlimited runs.`);
  }

  const usesFlow = rows.some((r) => {
    const g = effectiveSettings(q.defaults, r.overrides);
    return g.engine === 'flow' || (hasMotion(r, g) && motionSettings(g).engine === 'flow');
  });
  const tabs = usesFlow ? await pickTabs(settings, pro) : [];

  state = {
    status: 'running',
    runId: keep && prev.runId ? prev.runId : uid(),
    queueId: q.id,
    scope,
    startedAt: keep && prev.startedAt ? prev.startedAt : Date.now(),
    spent: keep ? prev.spent : { credits: 0, usd: 0 },
    rows: keep ? prev.rows : {}
  };
  for (const r of rows) state.rows[r.id] = { status: 'queued', attempts: 0, results: [] };
  await flush();

  ctl = {
    abort: new AbortController(),
    queue: q,
    settings,
    chars: await get('characters'),
    pro,
    pending: [...rows],
    inRun: new Set(rows.map((r) => r.id)),
    tabs,
    nextSlot: new Map(),
    chainOut: new Map(),
    failsInRow: 0,
    unusual: 0,
    // An extension API call every 20 s keeps the service worker alive during long renders.
    keepAlive: setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000)
  };
  // a long or overnight run must not be cut short by the computer going to sleep
  chrome.power?.requestKeepAwake('system');
  await log('info', `Run started: ${rows.length} row(s) of “${q.name}”${tabs.length ? ` on ${tabs.length} Flow tab(s)` : ''}`);
  void execute(ctl);
}

async function pickTabs(settings: AppSettings, pro: boolean): Promise<number[]> {
  const open = (await flowTabs()).map((t) => t.id!);
  let tabs = settings.run.tabs.filter((id) => open.includes(id));
  if (!pro) tabs = tabs.slice(0, 1);
  if (!tabs.length) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: 'https://flow.google.com/*' });
    tabs = [active?.id ?? open[0] ?? (await openFlowTab(true))];
  }
  for (const id of tabs) {
    await waitForTabLoad(id);
    await ensureContent(id);
    const h = await health(id);
    const bad = h.items.find((i) => !i.ok && ['tab', 'project', 'editor'].includes(i.key));
    if (bad) {
      await chrome.tabs.update(id, { active: true });
      throw new Error(`Flow is not ready: ${bad.detail ?? bad.key}. Fix that in the Flow tab and run again.`);
    }
  }
  return tabs;
}

export async function pause(message = 'Paused') {
  if (!ctl || state.status === 'idle') return;
  setStatus('paused', message);
  await flush();
}

export async function resume() {
  if (ctl) {
    if (state.status === 'paused' || state.status === 'cooldown') {
      const c = ctl;
      // pick up settings changed while paused (budget, delays, keys)
      c.settings = await get('settings');
      if (c.tabs.length) {
        const open = new Set((await flowTabs()).map((t) => t.id!));
        if (c.tabs.some((id) => !open.has(id))) c.tabs = await pickTabs(c.settings, c.pro);
      }
      c.failsInRow = 0;
      c.unusual = state.status === 'cooldown' ? c.unusual : 0;
      state.cooldownUntil = undefined;
      setStatus('running');
    }
    return;
  }
  // The service worker restarted mid-run: continue with what is left.
  const prev = await get('run');
  if (!prev.queueId) throw new Error('Nothing to resume');
  await start(prev.queueId, { kind: 'pending' }, { continuing: true });
}

export async function stop() {
  if (!ctl) {
    if (state.status !== 'idle' || (await get('run')).status !== 'idle') {
      state = { ...(await get('run')), status: 'idle', message: 'Stopped' };
      await flush();
    }
    return;
  }
  setStatus('stopping', 'Stopping…');
  ctl.abort.abort();
  cancelFlowExpectations();
}

// Closing the Flow tab or the "debugging this browser" bar mid-run: pause instead of failing every row.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (ctl?.tabs.includes(tabId) && state.status === 'running') {
    const m = 'The Flow tab was closed. Open a Flow project, then press Resume.';
    void pause(m);
    void notify('Run paused', m);
  }
});
onUserCancel((tabId) => {
  if (ctl?.tabs.includes(tabId) && state.status === 'running') {
    const m = 'Chrome’s debugging bar was cancelled, so Reelbatch lost control of the Flow tab. Press Resume to continue.';
    void pause(m);
    void notify('Run paused', m);
  }
});

/** Called once when the service worker starts: a run that was in flight cannot be continued in place. */
export async function restore() {
  const prev = await get('run');
  state = prev;
  if (prev.status === 'idle') return;
  for (const rr of Object.values(prev.rows)) {
    if (!TERMINAL.has(rr.status) && rr.status !== 'queued') {
      const sent = rr.status === 'rendering' || rr.status === 'downloading';
      rr.status = 'failed';
      rr.error = sent
          ? 'Interrupted while Flow was generating — the result may be in your Flow project. Check it before using Retry failed.'
          : 'Interrupted before it was sent. Use Retry failed to run it again.';
    }
  }
  state.status = 'paused';
  state.message = 'Interrupted. Press Resume to continue with the rows that had not started.';
  await flush();
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function execute(c: Ctl) {
  const workers = Math.max(1, Math.min(c.pro ? c.settings.run.concurrency : 1, 8));
  // wait for every worker, also after Stop, so none writes into the next run
  const results = await Promise.allSettled(Array.from({ length: workers }, (_, i) => worker(c, i, workers)));
  for (const r of results) if (r.status === 'rejected' && !isAbort(r.reason)) await log('error', `Run crashed: ${errText(r.reason)}`);
  await finish(c);
}

async function gate(c: Ctl) {
  for (;;) {
    c.abort.signal.throwIfAborted();
    if (state.status === 'cooldown') {
      const left = (state.cooldownUntil ?? 0) - Date.now();
      if (left > 0) {
        await sleep(Math.min(left, 5000), c.abort.signal);
        continue;
      }
      setStatus('running');
    }
    if (state.status === 'paused') {
      await sleep(800, c.abort.signal);
      continue;
    }
    return;
  }
}

async function worker(c: Ctl, index: number, workers: number) {
  for (;;) {
    await gate(c);
    const row = c.pending.shift();
    if (!row) return;
    const tabId = c.tabs.length ? c.tabs[index % c.tabs.length] : -1;
    const sharing = c.tabs.length ? Math.ceil(workers / c.tabs.length) > 1 : false;
    try {
      await processRow(c, row, tabId, sharing);
    } catch (e) {
      if (isAbort(e)) {
        const rr = rowRun(row.id);
        if (!TERMINAL.has(rr.status) && rr.status !== 'queued') {
          rr.error =
            rr.status === 'rendering' || rr.status === 'downloading'
              ? 'Stopped while Flow was generating — the result may still appear in your Flow project'
              : 'Stopped';
          rr.status = 'failed';
          rr.finishedAt = Date.now();
        }
        save();
        throw e;
      }
      const rr = rowRun(row.id);
      rr.status = 'failed';
      rr.error = errText(e);
      rr.finishedAt = Date.now();
      save();
      await log('error', `Row ${numberOf(c, row)}: ${rr.error}`);
    }
  }
}

const numberOf = (c: Ctl, row: Row) => c.queue.rows.findIndex((r) => r.id === row.id) + 1;

async function waitForPrevious(c: Ctl, row: Row) {
  const i = c.queue.rows.findIndex((r) => r.id === row.id);
  const prev = c.queue.rows[i - 1];
  if (!prev) return undefined;
  // only wait for rows that are part of this run
  while (c.inRun.has(prev.id) && state.rows[prev.id] && !TERMINAL.has(state.rows[prev.id].status)) {
    c.abort.signal.throwIfAborted();
    await sleep(700, c.abort.signal);
  }
  return c.chainOut.get(prev.id);
}

interface Step {
  settings: GenSettings;
  prompt: string;
  refs: Blob[];
  startFrame?: Blob;
  endFrame?: Blob;
  label: '' | 'motion';
}

async function processRow(c: Ctl, row: Row, tabId: number, sharing: boolean) {
  const rr = rowRun(row.id);
  Object.assign(rr, { status: 'waiting', attempts: 0, results: [], error: undefined, cost: 0, startedAt: Date.now(), finishedAt: undefined });
  save();

  const s = effectiveSettings(c.queue.defaults, row.overrides);
  const model = modelById(s.model);
  if (!model) throw new Error(`Unknown model ${s.model}`);

  const { prompt, used } = resolveMentions(row.prompt.trim(), c.chars);
  const refIds = [...row.refs, ...used.flatMap((ch) => ch.refs)];
  const maxRefs = model.maxRefs ?? 0;
  let refs = await Promise.all(refIds.slice(0, maxRefs).map(resolveRef));
  let startFrame = row.startFrame ? await resolveRef(row.startFrame) : undefined;
  const endFrame = row.endFrame ? await resolveRef(row.endFrame) : undefined;

  if (row.chain) {
    const prev = await waitForPrevious(c, row);
    if (!prev) throw new Error('Chained row: the previous row has no result to continue from (run it in the same run)');
    if (s.kind === 'video') startFrame = prev;
    else if (maxRefs > 0) refs = [prev, ...refs].slice(0, maxRefs);
  }

  const settings = fitMode(s, refs.length, !!startFrame);
  // Frames mode takes a start/end frame only; reference images belong to Ingredients mode.
  if (settings.kind === 'video' && settings.videoMode === 'frames' && refs.length) {
    await log('warn', `Row ${numberOf(c, row)}: reference images are not used in Frames mode (start frame wins)`);
    refs = [];
  }
  if (settings.kind === 'video' && settings.videoMode === 'text' && refs.length)
    throw new Error(`${model.label} cannot use reference images in Flow: remove them or pick a model with Ingredients`);
  const first: Step = { settings, prompt, refs, startFrame, endFrame, label: '' };
  const outs = await runStep(c, row, rr, first, tabId, sharing);
  if (!outs) return; // row was re-queued or the run paused
  const { still } = await handleOutputs(c, row, rr, first, outs, tabId);

  if (hasMotion(row, s) && outs.length) {
    if (!still) throw new Error('Image→video: the generated still could not be read back');
    const vs = motionSettings(s);
    const motion = resolveMentions(row.motionPrompt!.trim(), c.chars).prompt;
    const step: Step = { settings: vs, prompt: motion, refs: [], startFrame: still, label: 'motion' };
    const vouts = await runStep(c, row, rr, step, tabId, sharing);
    if (!vouts) return;
    await handleOutputs(c, row, rr, step, vouts, tabId);
  }

  rr.status = 'done';
  rr.finishedAt = Date.now();
  c.failsInRow = 0;
  save();
}

/** Text-to-video with a start frame becomes frames mode; ingredients without images becomes text. */
function fitMode(s: GenSettings, refs: number, hasStart: boolean): GenSettings {
  if (s.kind !== 'video') return s;
  const modes = modelById(s.model)?.videoModes ?? ['text'];
  let mode = s.videoMode;
  if (hasStart && modes.includes('frames')) mode = 'frames';
  else if (mode === 'frames' && !hasStart) mode = refs && modes.includes('ingredients') ? 'ingredients' : 'text';
  else if (mode === 'text' && refs && modes.includes('ingredients')) mode = 'ingredients';
  if (mode === 'ingredients' && !refs) mode = 'text';
  return { ...s, videoMode: mode };
}

interface Out {
  kind: MediaKind;
  url?: string;
  blob?: Blob;
  mediaId?: string;
}

type Action = 'retry' | 'fail' | 'pause' | 'cooldown' | 'requeue';

/** `sent`: the prompt reached Flow or the provider, so a retry would generate (and pay) again. */
function classify(e: unknown, sent: boolean): { action: Action; msg: string; cooldownMin?: number } {
  const msg = errText(e);
  if (e instanceof FlowError) {
    if (e.phase === 'unconfirmed') return { action: 'fail', msg };
    switch (e.reason) {
      case 'policy':
        return { action: 'fail', msg: `Blocked by Flow’s content policy: ${msg}` };
      case 'credits':
        return { action: 'pause', msg: `Out of Flow credits: ${msg}` };
      case 'unusual':
        return { action: 'cooldown', msg: `Flow reported unusual activity: ${msg}` };
      case 'limit':
        return { action: 'cooldown', msg: `Flow rate limit: ${msg}`, cooldownMin: 3 };
      case 'budget':
        return { action: 'requeue', msg };
      case 'timeout':
        // Flow took the prompt but no result came back: generating again could pay twice
        if (e.phase === 'after') return { action: 'fail', msg: `${msg}. It may still appear in your Flow project — check there before using Retry failed.` };
        return { action: 'retry', msg };
      default:
        return { action: 'retry', msg };
    }
  }
  if (e instanceof ApiError) {
    // the provider already accepted (and billed) the job: running it again would pay twice
    if (e.submitted && e.reason !== 'auth' && e.reason !== 'quota') return { action: 'fail', msg };
    switch (e.reason) {
      case 'auth':
      case 'quota':
        return { action: 'pause', msg };
      case 'policy':
      case 'input':
        return { action: 'fail', msg };
      case 'limit':
        return { action: 'retry', msg };
      default:
        return { action: e.retryable || (e.reason === 'timeout' && !sent) ? 'retry' : 'fail', msg };
    }
  }
  return { action: sent ? 'fail' : 'retry', msg };
}

/** Run one generation with retries. Returns null when the row went back to the queue. */
async function runStep(c: Ctl, row: Row, rr: RowRun, step: Step, tabId: number, sharing: boolean): Promise<Out[] | null> {
  const retries = c.settings.run.retries;
  // one free-plan prompt per step, whatever the number of attempts
  if (!c.pro && !(await takeFreeSlot())) {
    requeue(c, row, rr);
    await pause(`Free plan limit reached (${PRO.freePerDay} prompts today). Upgrade to Pro to keep going.`);
    notify('Free daily limit reached', `Reelbatch ran ${PRO.freePerDay} prompts today. Upgrade to Pro for unlimited runs.`);
    return null;
  }
  let everSent = false;
  const giveBack = async () => {
    if (!c.pro && !everSent) await releaseFreeSlot();
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await gate(c);
    } catch (e) {
      await giveBack();
      throw e;
    }
    rr.attempts++;
    const sent = { value: false };
    try {
      return await generate(c, rr, step, tabId, sharing, sent);
    } catch (e) {
      everSent ||= sent.value;
      if (isAbort(e)) {
        await giveBack();
        throw e;
      }
      const { action, msg, cooldownMin } = classify(e, sent.value);
      const partial = e instanceof FlowError ? e.results : [];
      if (partial.length && action !== 'requeue') {
        rr.error = `Partial result: ${msg}`;
        if (action === 'cooldown') await cooldown(c, msg, cooldownMin);
        if (action === 'pause') {
          await pause(msg);
          notify('Run paused', msg);
        }
        return partial.map((r) => ({ kind: r.kind, url: r.url, mediaId: r.mediaId }));
      }
      await log('warn', `Row ${numberOf(c, row)} attempt ${attempt + 1}: ${msg}`);
      switch (action) {
        case 'requeue':
        case 'pause':
          // nothing was generated: the row waits in the queue until Resume
          await giveBack();
          requeue(c, row, rr);
          await pause(msg);
          notify(action === 'requeue' ? 'Budget reached' : 'Run paused', msg);
          return null;
        case 'cooldown':
          await cooldown(c, msg, cooldownMin);
          if (attempt < retries + 1) continue;
          countFail(c);
          await giveBack();
          throw new Error(msg);
        case 'fail':
          countFail(c);
          await giveBack();
          throw new Error(msg);
        case 'retry':
          if (attempt < retries) {
            rr.error = `${msg} — retrying`;
            save();
            try {
              await sleep(Math.min(60_000, 4000 * 2 ** attempt) * rand(0.8, 1.3), c.abort.signal);
            } catch (err) {
              await giveBack();
              throw err;
            }
            continue;
          }
          countFail(c);
          await giveBack();
          throw new Error(msg);
      }
    }
  }
}

function requeue(c: Ctl, row: Row, rr: RowRun) {
  rr.status = 'queued';
  rr.error = undefined;
  c.pending.unshift(row);
  save();
}

function countFail(c: Ctl) {
  c.failsInRow++;
  const limit = c.settings.run.stopAfterFails;
  if (limit > 0 && c.failsInRow >= limit && state.status === 'running') {
    const msg = `Paused after ${c.failsInRow} failures in a row. Check the Flow tab and the log, then Resume.`;
    void pause(msg);
    notify('Run paused', msg);
  }
}

async function cooldown(c: Ctl, msg: string, minutes?: number) {
  c.unusual++;
  if (!minutes && c.unusual >= 3) {
    const m = `${msg}. Paused for safety after repeated warnings — wait a while before resuming.`;
    await pause(m);
    notify('Run paused', m);
    return;
  }
  const mins = minutes ?? 10 * c.unusual;
  state.cooldownUntil = Date.now() + mins * 60_000;
  setStatus('cooldown', `${msg}. Cooling down for ${mins} min, then continuing.`);
  notify('Cooling down', `${msg}. Reelbatch waits ${mins} min before continuing.`);
  await flush();
}

/** Budget guard. The cost is reserved right away so parallel workers cannot overshoot together. */
function reserve(c: Ctl, engine: GenSettings['engine'], cost: number) {
  const { budgetCredits, budgetUsd } = c.settings.run;
  if (engine === 'flow') {
    if (budgetCredits > 0 && state.spent.credits + cost > budgetCredits)
      throw new FlowError('budget', `Credit budget reached: ${state.spent.credits} of ${budgetCredits} credits used, next prompt costs ${cost}`);
    state.spent.credits += cost;
  } else {
    if (budgetUsd > 0 && state.spent.usd + cost > budgetUsd)
      throw new FlowError('budget', `API budget reached: $${state.spent.usd.toFixed(2)} of $${budgetUsd} used, next prompt costs about $${cost.toFixed(2)}`);
    state.spent.usd = Math.round((state.spent.usd + cost) * 10_000) / 10_000;
  }
  save();
}

function refund(engine: GenSettings['engine'], cost: number) {
  if (engine === 'flow') state.spent.credits = Math.max(0, state.spent.credits - cost);
  else state.spent.usd = Math.max(0, Math.round((state.spent.usd - cost) * 10_000) / 10_000);
  save();
}

async function pace(c: Ctl, tabId: number, prompt: string) {
  const o = c.settings.run;
  const now = Date.now();
  const slot = Math.max(now, c.nextSlot.get(tabId) ?? now);
  const gap = rand(o.delayMin, Math.max(o.delayMin, o.delayMax)) * 1000 + (o.readingPause * prompt.length * 1000) / 100;
  c.nextSlot.set(tabId, slot + gap);
  if (slot > now) await sleep(slot - now, c.abort.signal);
}

async function generate(c: Ctl, rr: RowRun, step: Step, tabId: number, sharing: boolean, sent: { value: boolean }): Promise<Out[]> {
  const s = step.settings;
  const onStatus = (st: 'sending' | 'rendering') => {
    if (st === 'rendering') sent.value = true;
    rr.status = st;
    rr.tabId = tabId >= 0 ? tabId : undefined;
    save();
  };
  let reserved = 0;
  const charge = (cost: number) => {
    reserve(c, s.engine, cost);
    reserved = cost;
  };

  if (s.engine === 'flow') {
    if (tabId < 0) throw new FlowError('setup', 'No Flow tab for this run');
    await pace(c, tabId, step.prompt);
    try {
      const r = await runFlowJob({
        tabId,
        prompt: step.prompt,
        settings: s,
        refs: step.refs,
        startFrame: step.startFrame,
        endFrame: step.endFrame,
        parallel: sharing,
        signal: c.abort.signal,
        approveCost: charge,
        onStatus
      });
      rr.cost = (rr.cost ?? 0) + reserved;
      if (r.partial) rr.error = `Flow returned ${r.results.length} of ${s.count}`;
      return r.results.map((x) => ({ kind: x.kind, url: x.url, mediaId: x.mediaId }));
    } catch (e) {
      // credits count once Flow accepted the prompt and something may have rendered (or still will)
      const spent = sent.value && (isAbort(e) || (e instanceof FlowError && (e.results.length > 0 || e.reason === 'timeout')));
      if (reserved && !spent) refund('flow', reserved);
      else if (reserved) rr.cost = (rr.cost ?? 0) + reserved;
      throw e;
    }
  }

  const key = c.settings.keys[s.engine];
  if (!key) throw new ApiError('auth', `Add your ${s.engine === 'gemini' ? 'Gemini' : 'Replicate'} API key in Settings`);
  charge(estimateCost(s));
  const job = {
    prompt: step.prompt,
    settings: s,
    target: modelById(s.model)!.target,
    refs: step.refs,
    startFrame: step.startFrame,
    endFrame: step.endFrame,
    key,
    signal: c.abort.signal,
    onStatus
  };
  try {
    const outs: ApiOutput[] = s.engine === 'gemini' ? await runGemini(job) : await runReplicate(job);
    rr.cost = (rr.cost ?? 0) + reserved;
    return outs.map((o) => ({ kind: o.kind, url: o.url, blob: o.blob }));
  } catch (e) {
    // the provider bills accepted jobs only; engines mark those errors as submitted
    if (e instanceof ApiError) sent.value = e.submitted;
    if (!sent.value) refund(s.engine, reserved);
    else rr.cost = (rr.cost ?? 0) + reserved;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Results: download, thumbnails, history, chaining
// ---------------------------------------------------------------------------

const FLOW_QUALITY: Record<string, string> = { '1k': '1K', '2k': '2K', '4k': '4K', '720p': '720p', '1080p': '1080p' };

async function fetchBlob(url: string, signal: AbortSignal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`Could not fetch the result (HTTP ${r.status})`);
  return r.blob();
}

async function videoFrame(blob: Blob, which: 'first' | 'last'): Promise<Blob | null> {
  const tmp = await putAsset(blob, 'video');
  try {
    const { dataUrl } = await offscreen<{ dataUrl: string }>({ task: 'frame', url: `idb:${tmp}`, which });
    return await (await fetch(dataUrl)).blob();
  } catch {
    return null;
  } finally {
    await deleteAsset(tmp).catch(() => {});
  }
}

function nextRowChains(c: Ctl, row: Row) {
  const i = c.queue.rows.findIndex((r) => r.id === row.id);
  return !!c.queue.rows[i + 1]?.chain;
}

/** Saves, thumbnails and records each output. Returns the first image (for the image→video step). */
async function handleOutputs(c: Ctl, row: Row, rr: RowRun, step: Step, outs: Out[], tabId: number): Promise<{ still?: Blob }> {
  rr.status = 'downloading';
  save();
  let still: Blob | undefined;
  const dl = c.settings.run.download;
  const n = numberOf(c, row);
  const model = modelById(step.settings.model);
  const base0 = rr.results.length;

  for (let i = 0; i < outs.length; i++) {
    c.abort.signal.throwIfAborted();
    const o = outs[i];
    let blob = o.blob;
    if (!blob && o.url) blob = await fetchBlob(o.url, c.abort.signal).catch(() => undefined);

    const res: ResultMedia = { kind: o.kind, url: o.url ?? '', mediaId: o.mediaId };

    if (dl.enabled) {
      const ctx = {
        n,
        total: c.queue.rows.length,
        prompt: row.prompt,
        model: model?.label ?? step.settings.model,
        queue: c.queue.name,
        variant: base0 + i + 1,
        kind: o.kind,
        // one date for the whole run, so {date}/{time} folders do not split at midnight or per file
        date: new Date(state.startedAt ?? Date.now()),
        vars: row.vars
      };
      const fileTpl = (row.filename || dl.filename || '{n}') + (step.label ? `_${step.label}` : '');
      const base = buildPath(row.folder || dl.folder, fileTpl, 'x', ctx).slice(0, -2);
      try {
        const quality = !c.pro ? (o.kind === 'image' ? '1k' : '720p') : o.kind === 'image' ? dl.imageQuality : dl.videoQuality;
        const saved = await save1(step.settings, o, blob, base, tabId, quality);
        res.file = saved.file;
        res.downloadId = saved.id;
        res.bytes = saved.bytes;
      } catch (e) {
        rr.error = `Download failed: ${errText(e)}`;
        await log('warn', `Row ${n}: ${rr.error}`);
      }
    }

    // keep the image (or the video's last frame) in memory for chaining and the image→video step
    if (blob && o.kind === 'image') still ??= blob;
    if (blob && nextRowChains(c, row)) {
      const keepBlob = o.kind === 'video' ? await videoFrame(blob, 'last') : blob;
      if (keepBlob) c.chainOut.set(row.id, keepBlob);
    }
    // API results have no lasting link: keep a copy (up to 40 MB) so a ZIP export can include them
    let assetId: string | undefined;
    if (o.blob && !o.url && o.blob.size <= 40 * 1024 * 1024) assetId = await putAsset(o.blob, `result-${n}`).catch(() => undefined);

    let thumbId: string | undefined;
    if (blob) {
      const src = o.kind === 'video' ? await videoFrame(blob, 'first') : blob;
      const thumb = src ? await makeThumb(src) : null;
      if (thumb) thumbId = await putAsset(thumb, 'thumb');
    }
    await addHistory({
      runId: state.runId!,
      queueName: c.queue.name,
      rowId: row.id,
      n,
      prompt: step.prompt,
      engine: step.settings.engine,
      model: model?.label ?? step.settings.model,
      kind: o.kind,
      url: o.url ?? '',
      file: res.file,
      thumbId,
      assetId,
      cost: i === 0 ? rr.cost : undefined
    });
    rr.results.push(res);
    save();
  }
  return { still };
}

async function save1(s: GenSettings, o: Out, blob: Blob | undefined, base: string, tabId: number, quality: string): Promise<Saved> {
  const original = quality === '1k' || quality === '720p';
  if (s.engine === 'flow' && !original && o.mediaId && tabId >= 0) {
    try {
      const id = await serialMenuDownload(async () => {
        const exp = expectFlowDownload(base);
        try {
          const r = await flowMenuDownload(tabId, o.mediaId!, FLOW_QUALITY[quality] ?? quality);
          if (!r.ok) throw new Error(r.error ?? 'Flow download menu failed');
          return await exp.done;
        } catch (e) {
          exp.cancel();
          throw e;
        }
      });
      return await waitComplete(id);
    } catch (e) {
      await log('warn', `Upscaled download unavailable (${errText(e)}); saving the original`);
    }
  }
  if (blob) return downloadBlob(blob, base);
  if (o.url) return downloadUrl(o.url, base);
  throw new Error('Nothing to download');
}

// ---------------------------------------------------------------------------
// End of run: sidecar, notification, cleanup
// ---------------------------------------------------------------------------

function csvCell(v: unknown) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function runCsv(q: Queue, run: RunState) {
  const head = ['n', 'prompt', 'status', 'engine', 'model', 'files', 'urls', 'cost', 'error'];
  const lines = [head.join(',')];
  q.rows.forEach((r, i) => {
    const rr = run.rows[r.id];
    if (!rr) return;
    const s = effectiveSettings(q.defaults, r.overrides);
    lines.push(
      [i + 1, r.prompt, rr.status, s.engine, modelById(s.model)?.label ?? s.model, rr.results.map((x) => x.file ?? '').join(' | '), rr.results.map((x) => x.url).join(' | '), rr.cost ?? '', rr.error ?? '']
        .map(csvCell)
        .join(',')
    );
  });
  return '﻿' + lines.join('\r\n');
}

async function finish(c: Ctl) {
  clearInterval(c.keepAlive);
  chrome.power?.releaseKeepAwake();
  const stopped = c.abort.signal.aborted;
  for (const r of c.pending) {
    const rr = state.rows[r.id];
    if (rr && rr.status === 'queued' && stopped) rr.status = 'skipped';
  }
  const all = Object.values(state.rows);
  const done = all.filter((r) => r.status === 'done').length;
  const failed = all.filter((r) => r.status === 'failed').length;
  const summary = `${done} done, ${failed} failed${state.spent.credits ? `, ${state.spent.credits} credits` : ''}${state.spent.usd ? `, $${state.spent.usd.toFixed(2)}` : ''}`;

  const dl = c.settings.run.download;
  if (dl.enabled && dl.sidecar && all.some((r) => r.results.length)) {
    const ctx = { n: 0, total: c.queue.rows.length, prompt: '', model: '', queue: c.queue.name, variant: 1, kind: 'log' };
    const folder = buildPath(dl.folder, `run_${renderName('{date}_{time}', ctx)}`, 'x', ctx).slice(0, -2);
    await downloadText(runCsv(c.queue, state), folder, 'text/csv').catch((e) => log('warn', `Run log not saved: ${errText(e)}`));
  }

  await releaseTabs(c.tabs).catch(() => {});
  ctl = null;
  state.status = 'idle';
  state.cooldownUntil = undefined;
  state.message = stopped ? `Stopped: ${summary}` : `Finished: ${summary}`;
  await flush();
  await log('info', state.message);
  notify(stopped ? 'Run stopped' : 'Run finished', `${c.queue.name}: ${summary}`);
}

async function notify(title: string, message: string) {
  const s = await get('settings');
  if (!s.notify) return;
  chrome.notifications.create(`rb-${Date.now()}`, { type: 'basic', iconUrl: 'icons/128.png', title: `Reelbatch — ${title}`, message: message.slice(0, 250) }, () => void chrome.runtime.lastError);
}

// ---------------------------------------------------------------------------
// Exports from the panel
// ---------------------------------------------------------------------------

export async function exportZip(runId?: string) {
  const run = await get('run');
  const id = runId ?? run.runId;
  if (!id) throw new Error('No run to export');
  const items = (await listHistory(100_000)).filter((h) => h.runId === id);
  if (!items.length) throw new Error('This run has no results');
  const files = items
    .slice()
    .reverse()
    .map((h, i) => ({
      name: h.file?.split(/[\\/]/).pop() ?? `${String(h.n).padStart(3, '0')}_${i + 1}.${h.kind === 'video' ? 'mp4' : 'png'}`,
      url: h.assetId ? `idb:${h.assetId}` : h.url
    }))
    .filter((f) => f.url);
  const q = run.queueId ? await getQueue(run.queueId) : null;
  const extra = q && run.runId === id ? [{ name: 'run.csv', text: runCsv(q, run) }] : [];
  const { url, missing } = await offscreen<{ url: string; missing: string[] }>({ task: 'zip', files, extra });
  if (missing?.length)
    await log('warn', `ZIP: ${missing.length} file(s) could not be fetched again (their links expire); they are still in your Downloads folder`);
  const name = `Reelbatch/${(q?.name ?? 'run').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'run'}_${new Date().toISOString().slice(0, 10)}`;
  return downloadUrl(url, name);
}

export async function exportSidecar(queueId: string) {
  const q = await getQueue(queueId);
  if (!q) throw new Error('Queue not found');
  const run = await get('run');
  if (run.queueId !== q.id) throw new Error('This queue has not been run yet');
  return downloadText(runCsv(q, run), `Reelbatch/${q.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'queue'}_run`, 'text/csv');
}
