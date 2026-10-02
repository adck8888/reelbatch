// Content script on flow.google.com. It reads the page and performs the UI steps that Flow
// accepts from scripts (popup toggles, menus). The one step Flow only takes from real input
// (typing the prompt and pressing Generate) is done by the background via chrome.debugger,
// on elements this script marks with data-rb attributes.

import type { FlowCommand, FlowResult, FlowSnapshot, HealthItem, HealthReport, HookMessage, PrepareOutcome, WatchOutcome } from '../../shared/messages';
import type { GenSettings } from '../../shared/types';
import { BUNDLED_CONFIG, type FlowConfig } from './config';
import { extractMedia, parseBatch } from './batch';

type FailReason = Extract<WatchOutcome, { ok: false }>['reason'];

let cfg: FlowConfig = BUNDLED_CONFIG;
const loadConfig = async () => {
  try {
    const c = await chrome.runtime.sendMessage({ type: 'flow:config' });
    if (c && typeof c === 'object' && 'selectors' in c) cfg = c as FlowConfig;
  } catch {
    /* background asleep or reloading: keep the bundled config */
  }
};
void loadConfig();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = () => sleep(cfg.timing.uiStepMs + Math.random() * 150);
const rx = (k: keyof FlowConfig['text'], flags = 'i') => new RegExp(cfg.text[k], flags);
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
const visible = (el: Element | null): el is HTMLElement =>
  !!el && (el as HTMLElement).offsetParent !== null && (el as HTMLElement).getClientRects().length > 0;

async function waitFor<T>(fn: () => T | null | undefined | false, timeout = 5000, every = 120): Promise<T | null> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

/** The leading Material icon ligature ("crop_16_9", "videocam") is locale-independent. */
function iconOf(el: Element): string {
  const icon = el.querySelector('mat-icon, .material-icons, .material-symbols-outlined, .google-symbols, [class*="icon"]');
  const t = norm(icon?.textContent);
  if (t && /^[a-z0-9_]+$/.test(t)) return t;
  return norm(el.textContent).split(' ')[0] ?? '';
}

/** Visible text minus icon ligatures and emoji. */
function labelOf(el: Element): string {
  return norm(el.textContent)
    .split(' ')
    .filter((w) => !/^[a-z0-9]+(_[a-z0-9]+)+$/.test(w) && !/^(arrow_drop_down|volume_up|info|check)$/.test(w))
    .join(' ')
    .replace(/[\p{Extended_Pictographic}️]/gu, '')
    .trim();
}

// ---------------- network observation ----------------

interface SeenMedia extends FlowResult {
  t: number;
  rpc: string;
  /** Letters/digits of the response that carried it, to match results to prompts in parallel runs. */
  ctx: string;
}
const simplify = (s: string) => s.replace(/\\u[0-9a-f]{4}/gi, '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
const seen = new Map<string, SeenMedia>();
const netErrors: { t: number; rpc: string; reason: FailReason; message: string }[] = [];

window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.origin !== location.origin) return;
  const m = ev.data as HookMessage;
  if (!m || m.source !== 'reelbatch-hook') return;
  onRpc(m);
});

function onRpc(m: HookMessage) {
  const rpcs = m.rpcids.split(',');
  if (rpcs.every((r) => cfg.rpc.ignore.includes(r))) return;
  const generate = rpcs.some((r) => cfg.rpc.imageGenerate.includes(r) || (cfg.rpc.videoGenerate as string[]).includes(r));
  if (m.status >= 400 && generate) {
    netErrors.push({ t: m.t, rpc: m.rpcids, reason: m.status === 429 ? 'limit' : 'error', message: `Flow returned HTTP ${m.status}` });
    return;
  }
  const media = extractMedia(m.body, cfg.mediaUrl);
  const ctx = media.length && m.body.length < 400_000 ? simplify(m.body) : '';
  for (const r of media) {
    const prev = seen.get(r.mediaId);
    if (!prev) seen.set(r.mediaId, { ...r, t: m.t, rpc: m.rpcids, ctx });
    else if (prev.kind !== 'video' && r.kind === 'video') seen.set(r.mediaId, { ...prev, ...r });
  }
  if (!generate) return;
  for (const c of parseBatch(m.body)) {
    if (c.error !== undefined) {
      netErrors.push({ t: m.t, rpc: c.rpc, reason: 'error', message: `Flow rejected the request (code ${c.error})` });
      continue;
    }
    const raw = c.raw;
    if (/UNSAFE|POLICY|PROHIBITED|FILTERED|BLOCKLIST|RAI_|SAFETY/i.test(raw) && !extractMedia(raw, cfg.mediaUrl).length)
      netErrors.push({ t: m.t, rpc: c.rpc, reason: 'policy', message: 'Flow blocked this prompt (content policy)' });
    else if (/RESOURCE_EXHAUSTED|INSUFFICIENT_CREDITS|OUT_OF_CREDITS|NOT_ENOUGH/i.test(raw))
      netErrors.push({ t: m.t, rpc: c.rpc, reason: 'credits', message: 'Not enough Flow credits' });
    else if (/RATE_LIMIT|TOO_MANY|QUOTA/i.test(raw)) netErrors.push({ t: m.t, rpc: c.rpc, reason: 'limit', message: 'Flow rate limit reached' });
  }
}

// ---------------- page reading ----------------

function domMedia(): FlowResult[] {
  const out = new Map<string, FlowResult>();
  for (const el of $$(cfg.selectors.tileMedia)) {
    const id = el.getAttribute('data-media-id');
    if (!id) continue;
    const tile = el.closest(cfg.selectors.tile) ?? el.parentElement;
    const video = (el.tagName === 'VIDEO' ? el : tile?.querySelector('video')) as HTMLVideoElement | null;
    const src = video?.currentSrc || video?.src || (el as HTMLImageElement).src || '';
    const kind = video || /\/video\//.test(src) ? 'video' : 'image';
    const known = seen.get(id);
    out.set(id, { mediaId: id, kind: known?.kind === 'video' ? 'video' : kind, url: known?.url ?? (src.startsWith('http') ? src : '') });
  }
  return [...out.values()];
}

function renderingCount() {
  const re = rx('progress');
  return $$(cfg.selectors.tile).filter((t) => !t.querySelector(cfg.selectors.tileMedia) && re.test(norm(t.textContent))).length;
}

function alertTexts(): string[] {
  return $$(`${cfg.selectors.alerts}, ${cfg.selectors.dialogs}`)
    .map((el) => norm(el.textContent))
    .filter((t) => t.length > 2)
    .slice(0, 10);
}

function failedTiles(): string[] {
  const fail = rx('failed');
  const policy = rx('policy');
  return $$(cfg.selectors.tile)
    .filter((t) => !t.querySelector(cfg.selectors.tileMedia))
    .map((t) => norm(t.textContent))
    .filter((t) => !rx('progress').test(t) && (fail.test(t) || policy.test(t)));
}

function snapshot(): FlowSnapshot {
  return { mediaIds: [...new Set([...domMedia().map((m) => m.mediaId), ...seen.keys()])], rendering: renderingCount(), alerts: alertTexts() };
}

function classify(text: string): FailReason {
  if (rx('unusual').test(text)) return 'unusual';
  if (rx('credits').test(text)) return 'credits';
  if (rx('limit').test(text)) return 'limit';
  if (rx('policy').test(text)) return 'policy';
  return 'error';
}

// ---------------- settings popup ----------------

function agentOn() {
  const chip = $(cfg.selectors.agentChip);
  return !!chip && chip.classList.contains(cfg.selectors.agentOnClass);
}

async function ensureDirectMode() {
  if (!agentOn()) return true;
  $(cfg.selectors.agentChipButton)?.click();
  return !!(await waitFor(() => !agentOn() && visible($(cfg.selectors.settingsTrigger)), 3000));
}

function settingsPane(): HTMLElement | null {
  const panes = $$('.cdk-overlay-pane', $(cfg.selectors.overlay) ?? document).filter((p) => p.querySelector(cfg.selectors.radio));
  return panes.at(-1) ?? null;
}

async function closeOverlays() {
  for (let i = 0; i < 3 && $$('.cdk-overlay-pane').some((p) => p.childElementCount); i++) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    $(cfg.selectors.backdrop)?.click();
    await sleep(200);
  }
}

const radios = (pane: Element) => $$<HTMLElement>(cfg.selectors.radio, pane);
const isChecked = (el: Element) => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
const isDisabled = (el: Element) => (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';

async function pickRadio(pane: Element, match: (el: HTMLElement) => boolean, what: string) {
  const el = radios(pane).find(match);
  if (!el) throw new Error(`Flow has no "${what}" option here`);
  if (isDisabled(el)) throw new Error(`"${what}" is not available for this model in Flow`);
  if (!isChecked(el)) {
    el.click();
    await step();
  }
}

async function pickModel(pane: Element, target: string) {
  const want = target.toLowerCase();
  const trigger = $$<HTMLElement>(cfg.selectors.menuTrigger, pane).find(visible);
  if (!trigger) throw new Error('Model menu not found in Flow settings');
  if (labelOf(trigger).toLowerCase() === want) return;
  trigger.click();
  const items = await waitFor(() => {
    const list = $$<HTMLElement>(cfg.selectors.menuItem, $(cfg.selectors.overlay) ?? document).filter(visible);
    return list.length ? list : null;
  }, 3000);
  if (!items) throw new Error('Model list did not open');
  const exact = items.find((i) => labelOf(i).toLowerCase() === want) ?? items.find((i) => labelOf(i).toLowerCase().startsWith(want));
  if (!exact) {
    const names = items.map(labelOf).join(', ');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    throw new Error(`Model "${target}" is not in Flow's list (${names})`);
  }
  if (isDisabled(exact)) throw new Error(`Model "${target}" is locked on your Flow plan`);
  exact.click();
  await step();
}

function readCost(pane: Element): number | undefined {
  const m = norm(pane.textContent).match(rx('cost'));
  if (m) return Number(m[1]);
  // locale fallback: the last number in the pane's last line
  const last = norm(pane.lastElementChild?.textContent).match(/(\d+)\s*$/);
  return last ? Number(last[1]) : undefined;
}

async function prepare(s: GenSettings, target: string): Promise<PrepareOutcome> {
  await closeOverlays();
  if (!(await ensureDirectMode())) return { ok: false, error: 'Could not switch Flow out of Agent mode' };
  const trig = $(cfg.selectors.settingsTrigger);
  if (!visible(trig)) return { ok: false, error: 'Flow settings button not found — open a Flow project' };
  trig.click();
  const pane = await waitFor(settingsPane, 3000);
  if (!pane) return { ok: false, error: 'Flow settings did not open' };
  try {
    const I = cfg.icons;
    await pickRadio(pane, (r) => iconOf(r) === (s.kind === 'video' ? I.video : I.image), s.kind);
    if (s.kind === 'video') {
      const mode = s.videoMode === 'ingredients' ? I.ingredients : I.frames;
      await pickRadio(pane, (r) => iconOf(r) === mode, s.videoMode);
    }
    await pickModel(pane, target);
    const p = settingsPane() ?? pane;
    const aspectIcon = (I.aspects as Record<string, string>)[s.aspect];
    await pickRadio(p, (r) => iconOf(r) === aspectIcon || labelOf(r) === s.aspect, s.aspect);
    if (s.kind === 'video') {
      if (s.resolution && radios(p).some((r) => labelOf(r) === s.resolution)) await pickRadio(p, (r) => labelOf(r) === s.resolution, s.resolution);
      const dur = radios(p).filter((r) => /^\d+\s*\D{0,8}$/.test(labelOf(r)) && !/^x\d$/.test(labelOf(r)));
      if (s.duration && dur.length) await pickRadio(p, (r) => parseInt(labelOf(r), 10) === s.duration, `${s.duration}s`);
    }
    await pickRadio(p, (r) => labelOf(r).toLowerCase() === `x${s.count}`, `x${s.count}`);
    await sleep(250);
    const cost = readCost(p);
    await closeOverlays();
    return { ok: true, cost, state: labelOf($(cfg.selectors.settingsTrigger) ?? document.body) };
  } catch (e) {
    await closeOverlays();
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------- editor and generate ----------------

function mark(el: Element, name: string) {
  for (const old of $$(`[data-rb="${name}"]`)) old.removeAttribute('data-rb');
  el.setAttribute('data-rb', name);
  el.scrollIntoView({ block: 'center', inline: 'center' });
}

function focusEditor() {
  const ed = $(cfg.selectors.editor);
  if (!visible(ed)) return { ok: false, error: 'Prompt box not found in Flow' };
  mark(ed, 'editor');
  ed.focus();
  return { ok: true };
}

function editorText() {
  return { text: norm($(cfg.selectors.editor)?.innerText) };
}

function markGenerate() {
  const b = $$<HTMLButtonElement>(cfg.selectors.generate).find(visible);
  if (!b) return { ok: false, error: 'Generate button not found in Flow' };
  mark(b, 'gen');
  const disabled = b.disabled || b.classList.contains(cfg.selectors.generateDisabledClass);
  return { ok: true, disabled };
}

// ---------------- attachments ----------------

function dataUrlToFile(f: { name: string; type: string; dataUrl: string }) {
  const [, b64] = f.dataUrl.split(',');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new File([buf], f.name, { type: f.type });
}

// Flow adds images through its asset picker: upload into the project library, select the asset,
// then "Add to prompt". In Frames mode the picker opens from the start/end slot instead of the
// + button. Clicking a chip or a filled frame slot removes it.

const chips = () => $$(cfg.selectors.attachmentChips).filter(visible);
const frameSlot = (slot: 'start' | 'end') => $$(cfg.selectors.frameSlot)[slot === 'start' ? 0 : 1] ?? null;
const slotFilled = (el: Element | null) => !!el && !$(cfg.selectors.frameEmpty, el);
const picker = () => $(cfg.selectors.assetPicker);
const assetNamed = (name: string) => $$(cfg.selectors.assetItem).find((b) => norm(b.textContent).includes(name));
const assetReady = (b: Element) => {
  const img = $<HTMLImageElement>(cfg.selectors.assetReady, b);
  return !!img && img.complete && img.naturalWidth > 0 && !b.querySelector('[role=progressbar], mat-progress-spinner, mat-spinner');
};

async function openPicker(slot: 'refs' | 'start' | 'end') {
  await closeOverlays();
  if (slot === 'refs') {
    const add = $(cfg.selectors.addMenu);
    if (!visible(add)) return null;
    add.click();
  } else {
    const el = frameSlot(slot);
    if (!el) return null;
    if (slotFilled(el)) {
      $<HTMLElement>('button', el)?.click();
      await waitFor(() => !slotFilled(frameSlot(slot)), 3000);
    }
    $<HTMLElement>('button', frameSlot(slot) ?? el)?.click();
  }
  return waitFor(picker, 5000);
}

/** Upload through the picker's own file input; the page hook keeps the native dialog closed. */
async function upload(files: File[]) {
  const root = document.documentElement;
  $$('input[data-rb-picker]').forEach((i) => i.removeAttribute('data-rb-picker'));
  root.dataset.rbPicker = 'capture';
  try {
    $(cfg.selectors.pickerUpload)?.click();
    const input = await waitFor(() => $<HTMLInputElement>('input[type=file][data-rb-picker]'), 4000);
    if (!input) return false;
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } finally {
    delete root.dataset.rbPicker;
  }
  return !!(await waitFor(() => files.every((f) => { const b = assetNamed(f.name); return !!b && assetReady(b); }), 90_000, 400));
}

async function attach(slot: 'refs' | 'start' | 'end', files: { name: string; type: string; dataUrl: string }[]) {
  const list = files.map(dataUrlToFile);
  const fail = async (error: string) => (await closeOverlays(), { ok: false, error });
  if (!(await openPicker(slot))) return fail(slot === 'refs' ? 'Flow’s add-image button not found' : 'Flow’s frame slots not found — is Frames mode on?');

  // the same reference used across rows has the same content-hash name, so it is uploaded once
  const missing = list.filter((f) => !assetNamed(f.name));
  if (missing.length && !(await upload(missing))) return fail('Flow did not accept the image upload');

  for (const [i, f] of list.entries()) {
    if (i > 0 && !(await openPicker(slot))) return fail('Flow’s image picker did not open');
    const before = chips().length;
    const item = await waitFor(() => assetNamed(f.name), 5000);
    if (!item) return fail('Uploaded image not found in Flow’s library');
    item.click();
    await step();
    const add = await waitFor(() => $<HTMLElement>(cfg.selectors.addToPrompt), 3000);
    if (!add) return fail('Flow’s “Add to prompt” button not found');
    add.click();
    const added = await waitFor(() => (slot === 'refs' ? chips().length > before : slotFilled(frameSlot(slot))), 8000);
    if (!added) return fail('Flow did not add the image to the prompt');
    await step();
  }
  await closeOverlays();
  return { ok: true, count: list.length };
}

async function clearAttachments() {
  await closeOverlays();
  for (let i = 0; i < 20; i++) {
    const chip = chips()[0];
    if (!chip) break;
    $<HTMLElement>(cfg.selectors.attachmentChipButton, chip)?.click();
    await step();
  }
  for (const slot of ['start', 'end'] as const) {
    const el = frameSlot(slot);
    if (slotFilled(el)) {
      $<HTMLElement>('button', el!)?.click();
      await step();
    }
  }
  return { ok: true, left: chips().length + (['start', 'end'] as const).filter((x) => slotFilled(frameSlot(x))).length };
}

// ---------------- waiting for results ----------------

async function watch(c: Extract<FlowCommand, { type: 'watch' }>): Promise<WatchOutcome> {
  const known = new Set(c.known);
  const baseAlerts = new Set(alertTexts());
  const baseFails = new Set(failedTiles());
  const end = Date.now() + c.timeoutMs;
  let idleSince = 0;

  // Parallel runs: only accept media whose response mentions this prompt.
  const match = c.prompt ? simplify(c.prompt).slice(0, 60) : '';
  const fresh = (): FlowResult[] => {
    const byId = new Map<string, FlowResult>();
    for (const m of seen.values())
      if (m.t >= c.since - 2000 && !known.has(m.mediaId) && (!match || m.ctx.includes(match)))
        byId.set(m.mediaId, { mediaId: m.mediaId, url: m.url, kind: m.kind });
    if (!match) for (const m of domMedia()) if (!known.has(m.mediaId) && !byId.has(m.mediaId)) byId.set(m.mediaId, m);
    const all = [...byId.values()];
    const sameKind = all.filter((m) => m.kind === c.kind);
    return sameKind.length ? sameKind : c.kind === 'image' ? all : [];
  };

  for (;;) {
    const res = fresh();
    if (res.length >= c.expect) return { ok: true, results: res.slice(0, Math.max(c.expect, res.length)) };

    const err = netErrors.find((e) => e.t >= c.since);
    if (err) return { ok: false, reason: err.reason, message: err.message, results: res };

    const alert = alertTexts().find((t) => !baseAlerts.has(t) && (classify(t) !== 'error' || rx('failed').test(t)));
    if (alert) {
      const reason = classify(alert);
      if (reason !== 'error' || !res.length) return { ok: false, reason, message: alert.slice(0, 200), results: res };
    }
    const tileFail = failedTiles().find((t) => !baseFails.has(t));
    if (tileFail && renderingCount() === 0) {
      if (res.length) return { ok: true, results: res, partial: true };
      return { ok: false, reason: classify(tileFail), message: tileFail.slice(0, 200), results: res };
    }

    // Some outputs arrived and nothing is rendering any more: accept a partial set.
    if (res.length && renderingCount() === 0) {
      idleSince ||= Date.now();
      if (Date.now() - idleSince > 8000) return { ok: true, results: res, partial: true };
    } else idleSince = 0;

    if (Date.now() > end) {
      if (res.length) return { ok: true, results: res, partial: true };
      return { ok: false, reason: 'timeout', message: 'Flow did not return a result in time', results: [] };
    }
    await sleep(700);
  }
}

// ---------------- downloads through Flow's menu (upscaled versions) ----------------

const QUALITY_ORDER = ['4K', '2K', '1080p', '720p', '1K'];

async function download(mediaId: string, quality: string) {
  const media = $(`[data-media-id="${CSS.escape(mediaId)}"]`);
  const tile = media?.closest(cfg.selectors.tile) as HTMLElement | null;
  if (!tile) return { ok: false, error: 'Result tile not found on the page' };
  tile.scrollIntoView({ block: 'center' });
  await step();
  const r = tile.getBoundingClientRect();
  tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 2 }));
  const dl = await waitFor(() => $$<HTMLElement>(cfg.selectors.menuItem).find((i) => visible(i) && (iconOf(i) === cfg.icons.download || rx('download').test(labelOf(i)))), 3000);
  if (!dl) {
    await closeOverlays();
    return { ok: false, error: 'Download menu not found' };
  }
  dl.click();
  dl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  const items = await waitFor(() => {
    const list = $$<HTMLElement>(cfg.selectors.menuItem).filter((i) => visible(i) && /\b(1K|2K|4K|720p|1080p|4k|GIF)\b/i.test(norm(i.textContent)));
    return list.length ? list : null;
  }, 3000);
  if (!items) {
    await closeOverlays();
    return { ok: false, error: 'Download options did not open' };
  }
  const start = Math.max(0, QUALITY_ORDER.findIndex((q) => q.toLowerCase() === quality.toLowerCase()));
  for (const q of QUALITY_ORDER.slice(start)) {
    const item = items.find((i) => new RegExp(`\\b${q}\\b`, 'i').test(norm(i.textContent)));
    if (item && !isDisabled(item)) {
      item.click();
      await sleep(300);
      await closeOverlays();
      return { ok: true, quality: q };
    }
  }
  await closeOverlays();
  return { ok: false, error: 'No download option is available for this result' };
}

// ---------------- misc ----------------

async function dismiss() {
  const re = rx('dismiss');
  let n = 0;
  for (const d of $$(cfg.selectors.dialogs)) {
    const b = $$<HTMLElement>('button', d).find((x) => re.test(labelOf(x)));
    if (b) {
      b.click();
      n++;
      await step();
    }
  }
  return { ok: true, dismissed: n };
}

async function videoFrame(mediaId: string, which: 'first' | 'last') {
  const m = seen.get(mediaId) ?? domMedia().find((x) => x.mediaId === mediaId);
  if (!m?.url) return { ok: false, error: 'Video URL unknown' };
  return { ok: true, url: m.url, which };
}

function health(): HealthReport {
  const S = cfg.selectors;
  const items: HealthItem[] = [];
  const check = (key: string, ok: boolean, detail?: string) => items.push({ key, ok, detail });
  const onProject = /\/project\//.test(location.pathname);
  check('project', onProject, onProject ? undefined : 'Open a Flow project (flow.google.com → New project)');
  check('editor', visible($(S.editor)));
  check('generate', $$(S.generate).some(visible));
  const direct = !agentOn();
  check('agent', true, direct ? 'direct mode' : 'Agent mode is on — Reelbatch turns it off automatically');
  check('settings', direct ? visible($(S.settingsTrigger)) : !!$(S.agentChip), direct ? undefined : 'checked after Agent mode is off');
  const hook = document.documentElement.dataset.rbHook === '1';
  check('hook', hook, hook ? undefined : 'Reload the Flow tab once so Reelbatch can observe results');
  const signedIn = !/accounts\.google\.com/.test(location.href) && !!document.querySelector('img[src*="googleusercontent"], [aria-label*="@"]');
  return { ok: items.every((i) => i.ok), url: location.href, signedIn, items, configVersion: cfg.version };
}

// ---------------- dispatcher ----------------

chrome.runtime.onMessage.addListener((msg: FlowCommand | { type: 'config'; config: FlowConfig }, _sender, reply) => {
  const run = async (): Promise<unknown> => {
    switch (msg.type) {
      case 'config':
        cfg = msg.config;
        return { ok: true };
      case 'ping':
        return { ok: true, url: location.href, project: location.pathname.match(/\/project\/([\w-]+)/)?.[1] ?? null, config: cfg.version };
      case 'health':
        return health();
      case 'prepare':
        return prepare(msg.settings, msg.target);
      case 'focusEditor':
        return focusEditor();
      case 'editorText':
        return editorText();
      case 'markGenerate':
        return markGenerate();
      case 'snapshot':
        return snapshot();
      case 'attach':
        return attach(msg.slot, msg.files);
      case 'clearAttachments':
        return clearAttachments();
      case 'watch':
        return watch(msg);
      case 'download':
        return download(msg.mediaId, msg.quality);
      case 'dismiss':
        return dismiss();
      case 'videoFrame':
        return videoFrame(msg.mediaId, msg.which);
      default:
        return { ok: false, error: 'unknown command' };
    }
  };
  run().then(reply, (e) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true;
});
