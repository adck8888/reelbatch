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

// Injecting the script again into a tab that already runs it (a slow ping, a manual reload of the
// extension's scripts) must not register a second set of listeners: both would act on every command.
// A copy left behind by an extension update is dead (its runtime is gone) and is replaced.
const G = globalThis as { __rbContentAlive?: () => boolean };
const ACTIVE = (() => {
  try {
    if (G.__rbContentAlive?.()) return false;
  } catch {
    /* the old copy's context is gone */
  }
  G.__rbContentAlive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  return true;
})();

const loadConfig = async () => {
  try {
    const c = await chrome.runtime.sendMessage({ type: 'flow:config' });
    if (c && typeof c === 'object' && 'selectors' in c) cfg = c as FlowConfig;
  } catch {
    /* background asleep or reloading: keep the bundled config */
  }
};
if (ACTIVE) void loadConfig();

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
// icon fonts render their names as text ("volume_up"), glued to the label next to them
const ICONS = 'mat-icon, .material-icons, .material-icons-outlined, [class*="material-symbols"], .google-symbols';

function labelOf(el: Element): string {
  const c = el.cloneNode(true) as Element;
  c.querySelectorAll(ICONS).forEach((n) => n.remove());
  return norm(c.textContent)
    .replace(/^(?:[a-z]+_)+[a-z]+(?=\p{Lu})/u, '')
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
  /** Hook request id when the media came back in the response to a generate request, else 0. */
  req: number;
  /** Letters/digits of the response that carried it, to match results to prompts. */
  ctx: string;
}

/** Letters and digits only. Responses carry prompts JSON-escaped (often twice): decode first. */
const simplify = (s: string) =>
  s
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\+[nrtbf]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();

const seen = new Map<string, SeenMedia>();
/** Generate requests Flow sent, in order; each submit claims the first one after its click. */
const requests: { id: number; t: number; claimed: boolean }[] = [];
const netErrors: { t: number; rpc: string; req: number; ctx: string; reason: FailReason; message: string }[] = [];
/** Media already handed to a job: never returned twice. */
const claimed = new Set<string>();
const cancelled = new Set<string>();

const trim = <T,>(a: T[], max: number) => {
  if (a.length > max) a.splice(0, a.length - max);
};

if (ACTIVE)
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const m = ev.data as HookMessage;
    if (!m || m.source !== 'reelbatch-hook') return;
    onRpc(m);
  });

const isGenerate = (rpcs: string[]) => rpcs.some((r) => cfg.rpc.imageGenerate.includes(r) || (cfg.rpc.videoGenerate as string[]).includes(r));

// Enum-like error tokens only, case-sensitive: the response also echoes the prompt, and a prompt
// that mentions "safety" or "quota" must not read as an error.
const POLICY_RE = /\b(?:UNSAFE|PROHIBITED|BLOCKLIST|RAI_[A-Z_]+|[A-Z_]*(?:POLICY|SAFETY|FILTERED)[A-Z_]*)\b/;
const CREDITS_RE = /\b(?:RESOURCE_EXHAUSTED|INSUFFICIENT_CREDITS|OUT_OF_CREDITS|NOT_ENOUGH_[A-Z_]+)\b/;
const LIMIT_RE = /\b(?:RATE_LIMIT[A-Z_]*|TOO_MANY_[A-Z_]+|QUOTA_[A-Z_]+)\b/;

// Recent request ids with what they returned, for "Copy report" (maps new Flow requests, e.g. video).
const recentRpcs: string[] = [];

function onRpc(m: HookMessage) {
  const rpcs = (m.rpcids ?? '').split(',');
  if (rpcs.every((r) => cfg.rpc.ignore.includes(r))) return;
  if (m.phase !== 'start') {
    const kinds = [...new Set(extractMedia(m.body, cfg.mediaUrl).map((x) => x.kind))].join('+');
    recentRpcs.push(`${m.rpcids}:${m.status}${kinds ? `:${kinds}` : ''}`);
    trim(recentRpcs, 40);
  }
  const generate = isGenerate(rpcs);
  const req = generate ? (m.id ?? 0) : 0;
  if (m.phase === 'start') {
    if (generate && req) {
      requests.push({ id: req, t: m.t, claimed: false });
      trim(requests, 100);
    }
    return;
  }
  if (generate && (m.status >= 400 || m.status === 0)) {
    netErrors.push({
      t: m.t,
      rpc: m.rpcids,
      req,
      ctx: '',
      reason: m.status === 429 ? 'limit' : 'error',
      message: m.status ? `Flow returned HTTP ${m.status}` : 'The request to Flow failed (network)'
    });
    trim(netErrors, 100);
    return;
  }
  const media = extractMedia(m.body, cfg.mediaUrl);
  const ctx = media.length && m.body.length < 400_000 ? simplify(m.body) : '';
  for (const r of media) {
    const prev = seen.get(r.mediaId);
    if (!prev) seen.set(r.mediaId, { ...r, t: m.t, rpc: m.rpcids, req, ctx });
    else if (prev.kind !== 'video' && r.kind === 'video') seen.set(r.mediaId, { ...prev, ...r });
  }
  if (seen.size > 3000) for (const k of [...seen.keys()].slice(0, seen.size - 3000)) seen.delete(k);
  if (!generate) return;
  for (const c of parseBatch(m.body)) {
    const raw = c.raw;
    const base = { t: m.t, rpc: c.rpc, req, ctx: raw.length < 400_000 ? simplify(raw) : '' };
    if (c.error !== undefined) netErrors.push({ ...base, reason: 'error', message: `Flow rejected the request (code ${c.error})` });
    else if (extractMedia(raw, cfg.mediaUrl).length) continue;
    else if (POLICY_RE.test(raw)) netErrors.push({ ...base, reason: 'policy', message: 'Flow blocked this prompt (content policy)' });
    else if (CREDITS_RE.test(raw)) netErrors.push({ ...base, reason: 'credits', message: 'Not enough Flow credits' });
    else if (LIMIT_RE.test(raw)) netErrors.push({ ...base, reason: 'limit', message: 'Flow rate limit reached' });
  }
  trim(netErrors, 100);
}

/** The first generate request sent at or after `since` that no other submit has claimed. */
function claimRequest(since: number) {
  const r = requests.find((x) => !x.claimed && x.t >= since);
  if (!r) return { id: 0 };
  r.claimed = true;
  return { id: r.id };
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

const alertEls = () => $$(`${cfg.selectors.alerts}, ${cfg.selectors.dialogs}`).filter((el) => norm(el.textContent).length > 2);

function alertTexts(): string[] {
  return alertEls()
    .map((el) => norm(el.textContent))
    .slice(0, 10);
}

/** Tiles that ended without media and show a failure or policy text (compared by element, not text). */
function failedTileEls(): HTMLElement[] {
  const fail = rx('failed');
  const policy = rx('policy');
  const progress = rx('progress');
  return $$(cfg.selectors.tile).filter((t) => {
    if (t.querySelector(cfg.selectors.tileMedia)) return false;
    const txt = norm(t.textContent);
    return !progress.test(txt) && (fail.test(txt) || policy.test(txt));
  });
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

const menuOpen = () => $$('.cdk-overlay-pane').some((p) => p.childElementCount) || $$('[aria-expanded="true"]').some(visible);

async function closeOverlays() {
  for (let i = 0; i < 3 && menuOpen(); i++) {
    // from the focused element so a menu listening on its own button hears it too
    (document.activeElement ?? document).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    $(cfg.selectors.backdrop)?.click();
    await sleep(200);
  }
}

const radios = (pane: Element) => $$<HTMLElement>(cfg.selectors.radio, pane);
const isChecked = (el: Element) => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
const isDisabled = (el: Element) => (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';

async function pickRadio(pane: Element, match: (el: HTMLElement) => boolean, what: string) {
  // after a switch (image -> video) Flow re-renders the settings, so look in the live pane for a moment
  const el = await waitFor(() => radios(pane.isConnected ? pane : (settingsPane() ?? pane)).find(match), 3000);
  if (!el) throw new Error(`Flow has no "${what === 'text' ? 'Frames' : what}" option here`);
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
  const before = labelOf(trigger).toLowerCase();
  // exact name first; otherwise the shortest name that starts with it ("Veo 3.1 - Fast" over "... [Lower Priority]")
  const prefixed = items.filter((i) => labelOf(i).toLowerCase().startsWith(want)).sort((a, b) => labelOf(a).length - labelOf(b).length);
  const exact = items.find((i) => labelOf(i).toLowerCase() === want) ?? prefixed[0];
  if (!exact) {
    const names = items.map(labelOf).join(', ');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    throw new Error(`Model "${target}" is not in Flow's list (${names})`);
  }
  if (isDisabled(exact)) throw new Error(`Model "${target}" is locked on your Flow plan`);
  exact.click();
  await step();
  // The model menu closes on a pick; a label that did not change means the click was lost.
  const now = $$<HTMLElement>(cfg.selectors.menuTrigger, settingsPane() ?? pane).find(visible);
  const label = now ? labelOf(now).toLowerCase() : '';
  if (now && label === before && !label.includes(want)) throw new Error(`Flow did not switch to model "${target}"`);
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
      // seconds options ("4s", "8 с"), not resolutions ("720p", "4K") or counts ("x2")
      const dur = radios(p).filter((r) => {
        const l = labelOf(r);
        return /^\d{1,2}\s*\D{0,8}$/.test(l) && !/^\d+\s*[pk]\b/i.test(l) && !/^x\d$/i.test(l) && parseInt(l, 10) <= 60;
      });
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

async function focusEditor() {
  // an open settings menu would swallow the click meant for the prompt box; once it closes, the
  // menu hands focus back to its button, so wait for that before focusing the box
  const open = menuOpen();
  await closeOverlays();
  if (open) await sleep(500);
  const ed = $$<HTMLElement>(cfg.selectors.editor).find(visible);
  if (!ed) return { ok: false, error: 'Prompt box not found in Flow' };
  mark(ed, 'editor');
  ed.focus();
  return { ok: true };
}

/**
 * Empty the prompt box without keyboard shortcuts: Ctrl+A / Delete outside the box would select
 * and delete the user's results in the grid. Reports whether keyboard focus is inside the box,
 * because typed text goes wherever the focus is.
 */
/** The prompt box marked by focusEditor (Flow can keep a hidden second editor in the page). */
const editorEl = () => {
  const m = $<HTMLElement>('[data-rb="editor"]');
  return m?.isConnected && visible(m) ? m : $$<HTMLElement>(cfg.selectors.editor).find(visible) ?? null;
};

function clearEditor() {
  const ed = editorEl();
  if (!ed) return { focused: false, text: '' };
  const focused = !!document.activeElement && (ed === document.activeElement || ed.contains(document.activeElement));
  if (focused && norm(ed.innerText)) {
    const range = document.createRange();
    range.selectNodeContents(ed);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('delete');
  }
  return { focused, text: norm(ed.innerText) };
}

function editorText() {
  return { text: norm(editorEl()?.innerText) };
}

/** Fallback when typed keys do not land: hand the prompt to the box as a paste (no focus needed). */
function pasteEditor(text: string) {
  const ed = editorEl();
  if (!ed) return { text: '' };
  ed.focus();
  const range = document.createRange();
  range.selectNodeContents(ed);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return { text: norm(ed.innerText) };
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
  const baseAlerts = new Set(alertEls());
  const baseFails = new Set(failedTileEls());
  const end = Date.now() + c.timeoutMs;
  let idleSince = 0;
  const match = simplify(c.prompt).slice(0, 60);
  const mine = (ctx: string) => !!match && ctx.includes(match);

  const fresh = (): FlowResult[] => {
    const byId = new Map<string, FlowResult>();
    const take = (m: FlowResult) => byId.set(m.mediaId, { mediaId: m.mediaId, url: m.url, kind: m.kind });
    for (const m of seen.values()) {
      if (known.has(m.mediaId) || claimed.has(m.mediaId) || m.t < c.since - 2000) continue;
      // the response to our own generate request, or a non-generate response (status poll) naming our prompt
      if (m.req && c.req ? m.req === c.req : mine(m.ctx)) take(m);
    }
    // Single job in this tab and the network identified nothing: new tiles on the page (`known`
    // was read before Generate was pressed, so anything newer is this prompt's).
    if (!byId.size && !c.parallel)
      for (const m of domMedia()) {
        if (known.has(m.mediaId) || claimed.has(m.mediaId)) continue;
        // a finished video tile shows a poster image until it plays: trust the job's kind and
        // leave the URL empty, so the file is fetched through Flow's own download menu
        if (c.kind === 'video' && m.kind !== 'video') take({ mediaId: m.mediaId, url: '', kind: 'video' });
        else take(m);
      }
    const all = [...byId.values()];
    const sameKind = all.filter((m) => m.kind === c.kind);
    return (sameKind.length ? sameKind : c.kind === 'image' ? all : []).slice(0, c.expect);
  };
  const done = (o: WatchOutcome): WatchOutcome => {
    for (const r of o.results) claimed.add(r.mediaId);
    return o;
  };

  for (;;) {
    if (cancelled.delete(c.id)) return done({ ok: false, reason: 'error', message: 'cancelled', results: fresh() });
    const res = fresh();
    if (res.length >= c.expect) return done({ ok: true, results: res });

    // errors of our own request; without a request id, errors that name our prompt (or any, if alone)
    const err = netErrors.find((e) => e.t >= c.since && (c.req ? e.req === c.req : !e.req && (!c.parallel || mine(e.ctx))));
    if (err) return done({ ok: false, reason: err.reason, message: err.message, results: res });

    const alert = alertEls()
      .filter((el) => !baseAlerts.has(el))
      .map((el) => norm(el.textContent))
      .find((t) => (classify(t) !== 'error' ? true : !c.parallel && rx('failed').test(t)));
    if (alert) {
      const reason = classify(alert);
      if (reason !== 'error' || !res.length) return done({ ok: false, reason, message: alert.slice(0, 200), results: res });
    }
    // a failed tile; in a shared tab only one that shows our prompt
    const tileFail = failedTileEls()
      .filter((el) => !baseFails.has(el))
      .map((el) => norm(el.textContent))
      .find((t) => !c.parallel || mine(simplify(t)));
    if (tileFail && renderingCount() === 0) {
      if (res.length) return done({ ok: true, results: res, partial: true });
      return done({ ok: false, reason: classify(tileFail), message: tileFail.slice(0, 200), results: res });
    }

    // Some outputs arrived and nothing is rendering any more: accept a partial set.
    if (res.length && renderingCount() === 0) {
      idleSince ||= Date.now();
      if (Date.now() - idleSince > 8000) return done({ ok: true, results: res, partial: true });
    } else idleSince = 0;

    if (Date.now() > end) {
      if (res.length) return done({ ok: true, results: res, partial: true });
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
  if (document.visibilityState === 'hidden')
    check('visible', true, 'This Flow tab is in the background. Keep it in its own window so Chrome does not slow it down.');
  if (recentRpcs.length) check('requests', true, recentRpcs.slice(-25).join(' '));
  if (freezes.length) check('freezes', true, freezes.join(' | '));
  const signedIn = !/accounts\.google\.com/.test(location.href) && !!document.querySelector('img[src*="googleusercontent"], [aria-label*="@"]');
  return { ok: items.every((i) => i.ok), url: location.href, signedIn, items, configVersion: cfg.version };
}

// ---------------- dispatcher ----------------

// Freezes of the Flow page (main thread blocked > 1 s) with what Reelbatch was doing, for "Copy report".
const freezes: string[] = [];
let lastCmd = '';
if (ACTIVE)
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (e.duration > 1000) {
          freezes.push(`${new Date(performance.timeOrigin + e.startTime).toISOString().slice(11, 19)} ${Math.round(e.duration)}ms after ${lastCmd || '-'}`);
          trim(freezes, 20);
        }
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* longtask timing is not available */
  }

if (ACTIVE) chrome.runtime.onMessage.addListener((msg: FlowCommand | { type: 'config'; config: FlowConfig }, _sender, reply) => {
  if (msg.type !== 'ping' && msg.type !== 'health') lastCmd = `${msg.type}@${new Date().toISOString().slice(11, 19)}`;
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
      case 'clearEditor':
        return clearEditor();
      case 'pasteEditor':
        return pasteEditor(msg.text);
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
      case 'cancelWatch':
        cancelled.add(msg.id);
        return { ok: true };
      case 'claimRequest':
        return claimRequest(msg.since);
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
