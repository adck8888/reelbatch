import type { GenSettings, Row } from './types';
import { uid } from './util';
import { findModel, MODELS } from './models';

export type SplitMode = 'auto' | 'lines' | 'blocks' | 'delimiter';

const PREFIX = /^\s*(?:(?:p|prompt|scene|shot)\s*#?\s*\d+|#?\d{1,4})\s*[:.)\]\-–—]\s+/i;
/** "#8 a cat": a hash number followed by a space (a hashtag word like "#sunset" is content). */
const HASH_NUM = /^\s*#\d{1,4}\s+/;
/** List bullets; the space after them is required so "-10 degrees" stays intact. */
const BULLET = /^\s*[-•*–—]\s+/;

/** Remove "P1:", "Prompt 2 -", "3.", "#8", "- " style numbering and bullets that people paste from chat tools. */
export function stripPrefix(s: string) {
  return s.replace(BULLET, '').replace(PREFIX, '').replace(HASH_NUM, '').trim();
}

export function splitPrompts(text: string, mode: SplitMode = 'auto', delimiter = '---', strip = true): string[] {
  const src = text.replace(/\r\n?/g, '\n').trim();
  if (!src) return [];
  let parts: string[];
  const json = mode === 'auto' ? tryJsonPrompts(src) : null;
  if (json) parts = json;
  else if (mode === 'delimiter') parts = src.split(delimiter);
  else if (mode === 'blocks') parts = src.split(/\n\s*\n/);
  else if (mode === 'lines') parts = src.split('\n');
  else {
    // auto: blank-line blocks when any block spans several lines, otherwise one prompt per line
    const blocks = src.split(/\n\s*\n/);
    parts = blocks.length > 1 && blocks.some((b) => b.trim().includes('\n')) ? blocks : src.split('\n');
  }
  return parts
    .map((p) => p.trim())
    .map((p) => (strip && !json ? stripPrefix(p) : p))
    .map((p) => (json ? p : p.replace(/\s*\n\s*/g, ' ')))
    .filter(Boolean);
}

/** A pasted JSON array: strings are prompts, objects are kept whole (Veo-style JSON prompts) unless they carry a prompt field. */
function tryJsonPrompts(src: string): string[] | null {
  if (!/^[[{]/.test(src)) return null;
  try {
    const v = JSON.parse(src);
    const arr = Array.isArray(v) ? v : Array.isArray(v?.prompts) ? v.prompts : null;
    if (!arr) return null;
    return arr.map((x: unknown) =>
      typeof x === 'string' ? x : x && typeof x === 'object' && typeof (x as { prompt?: unknown }).prompt === 'string' ? (x as { prompt: string }).prompt : JSON.stringify(x)
    );
  } catch {
    return null;
  }
}

// ---------- variations and templates ----------

const ALT = /\{([^{}]*\|[^{}]*)\}/;

/** "a {red|blue} car at {dawn|night}" -> 4 prompts (cartesian product). Capped to protect the queue. */
export function expandVariations(prompt: string, cap = 500): string[] {
  // depth-first, so a capped list holds only complete prompts (no {a|b} left in)
  // nested groups like {a|{b|c}} can yield the same prompt twice: keep the first, in order
  if (!ALT.test(prompt)) return [prompt];
  const out = new Set<string>();
  // duplicates do not count toward the cap, so bound the total walk too
  let budget = cap * 20;
  const walk = (p: string) => {
    if (out.size >= cap || budget <= 0) return;
    const m = p.match(ALT);
    if (!m) {
      budget--;
      return void out.add(tidy(p));
    }
    for (const opt of m[1].split('|')) walk(p.slice(0, m.index) + opt.trim() + p.slice(m.index! + m[0].length));
  };
  walk(prompt);
  return [...out];
}

/** After an empty option ("{|x}"): collapse doubled spaces and drop the space left before punctuation. */
function tidy(p: string) {
  return p.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.;:!?])/g, '$1').trim();
}

/** Join template parts with one space, but glue a part that starts with punctuation (", 4k") straight on. */
function joinParts(parts: (string | undefined)[]) {
  return parts
    .map((x) => x?.trim())
    .filter((x): x is string => !!x)
    .reduce((acc, x) => (!acc ? x : /^[,.;:!?)\]]/.test(x) ? acc + x : `${acc} ${x}`), '');
}

/** Fill {name} placeholders from vars; unknown names are left as-is so they stay visible. */
export function fillVars(text: string, vars: Record<string, string | number | undefined>): string {
  return text.replace(/\{([\w.-]+)\}/g, (all, k: string) => {
    const v = vars[k] ?? vars[k.toLowerCase()];
    return v === undefined || v === '' ? all : String(v);
  });
}

export interface BuildOptions {
  prefix?: string;
  suffix?: string;
  repeat?: number;
  variations?: boolean;
  vars?: Record<string, string>;
}

export function applyTemplate(prompt: string, o: BuildOptions): string[] {
  const base = joinParts([o.prefix, fillVars(prompt, o.vars ?? {}), o.suffix]);
  const expanded = o.variations === false ? [base] : expandVariations(base);
  const n = Math.max(1, Math.min(100, o.repeat ?? 1));
  return expanded.flatMap((p) => Array.from({ length: n }, () => p));
}

export function rowsFromPrompts(prompts: string[], o: BuildOptions = {}): Row[] {
  return prompts.flatMap((p) => applyTemplate(p, o)).map((prompt) => newRow({ prompt }));
}

export function newRow(r: Partial<Row> & { prompt: string }): Row {
  return { id: uid(), enabled: true, overrides: {}, refs: [], ...r };
}

// ---------- tables (CSV / XLSX / JSON / Sheets) ----------

export type Field =
  | 'prompt' | 'negative' | 'model' | 'aspect' | 'count' | 'duration' | 'resolution' | 'seed'
  | 'refs' | 'startFrame' | 'endFrame' | 'motionPrompt' | 'filename' | 'folder' | 'kind' | 'ignore';

const GUESS: [Field, RegExp][] = [
  ['negative', /^(neg|negative|negative[_ ]?prompt|avoid)$/i],
  ['motionPrompt', /^(motion|motion[_ ]?prompt|animate|animation|video[_ ]?prompt)$/i],
  ['prompt', /^(prompt|prompts|text|description|scene|idea|caption)$/i],
  ['model', /^(model|engine)$/i],
  ['aspect', /^(aspect|ratio|aspect[_ ]?ratio|ar|size)$/i],
  ['count', /^(count|n|outputs|variants|x)$/i],
  ['duration', /^(duration|seconds|secs|length|len)$/i],
  ['resolution', /^(resolution|res|quality)$/i],
  ['seed', /^seed$/i],
  ['refs', /^(refs?|references?|images?|ingredients?|reference[_ ]?images?|image[_ ]?urls?)$/i],
  ['startFrame', /^(start|first|start[_ ]?frame|first[_ ]?frame|start[_ ]?image)$/i],
  ['endFrame', /^(end|last|end[_ ]?frame|last[_ ]?frame|end[_ ]?image)$/i],
  ['filename', /^(file|filename|file[_ ]?name|name|title)$/i],
  ['folder', /^(folder|dir|directory|subfolder)$/i],
  ['kind', /^(type|kind|media)$/i]
];

export function guessMapping(headers: string[], table: Record<string, string>[] = []): Record<string, Field> {
  const map: Record<string, Field> = {};
  const used = new Set<Field>();
  for (const h of headers) {
    const f = GUESS.find(([field, re]) => !used.has(field) && re.test(h.trim()))?.[0];
    map[h] = f ?? 'ignore';
    if (f) used.add(f);
  }
  if (!used.has('prompt')) {
    // no obvious prompt column: take the unmapped column with the longest average text
    const avg = (h: string) => table.reduce((s, r) => s + (r[h]?.length ?? 0), 0) / Math.max(1, table.length);
    const best = headers.filter((h) => map[h] === 'ignore').sort((a, b) => avg(b) - avg(a))[0];
    if (best) map[best] = 'prompt';
  }
  return map;
}

const listOf = (v: string) => v.split(/[\s,;|]+/).map((x) => x.trim()).filter(Boolean);

/** A row built from a table, with problems found in its cells (unknown model, unsupported aspect) for the import preview. */
export type ImportRow = Row & { warnings?: string[] };

const ALL_ASPECTS = new Set(MODELS.flatMap((m) => m.aspects));

export function rowsFromTable(table: Record<string, string>[], map: Record<string, Field>, o: BuildOptions = {}): ImportRow[] {
  const rows: ImportRow[] = [];
  for (const rec of table) {
    const r: Partial<ImportRow> & { prompt: string } = { prompt: '', overrides: {}, refs: [], vars: {} };
    const ov: Partial<GenSettings> = {};
    const warnings: string[] = [];
    let modelRaw = '';
    let aspectRaw = '';
    for (const [col, raw] of Object.entries(rec)) {
      const v = String(raw ?? '').trim();
      r.vars![col] = v;
      if (!v) continue;
      switch (map[col]) {
        case 'prompt': r.prompt = v; break;
        case 'negative': ov.negative = v; break;
        case 'model': modelRaw = v; break;
        case 'aspect': aspectRaw = v; break;
        case 'count': ov.count = clampInt(v, 1, 4); break;
        case 'duration': ov.duration = clampInt(v, 1, 60); break;
        case 'resolution': ov.resolution = v; break;
        case 'seed': ov.seed = clampInt(v, 0, 2 ** 31 - 1); break;
        case 'kind': ov.kind = /vid|mp4|movie/i.test(v) ? 'video' : 'image'; break;
        case 'refs': r.refs = listOf(v); break;
        case 'startFrame': r.startFrame = v; break;
        case 'endFrame': r.endFrame = v; break;
        case 'motionPrompt': r.motionPrompt = v; break;
        case 'filename': r.filename = v; break;
        case 'folder': r.folder = v; break;
      }
    }
    if (!r.prompt) continue;
    if (modelRaw) {
      const m = findModel(modelRaw);
      if (m) {
        // engine and kind must match the model, or effectiveSettings falls back to another model
        ov.model = m.id;
        ov.engine = m.engine;
        ov.kind = m.kind;
      } else warnings.push(`Unknown model "${modelRaw}" — the queue default is used`);
    }
    if (aspectRaw) {
      const a = normAspect(aspectRaw);
      if (!ALL_ASPECTS.has(a)) warnings.push(`Unsupported aspect "${aspectRaw}" — the queue default is used`);
      else {
        ov.aspect = a;
        const m = ov.model ? findModel(ov.model) : undefined;
        if (m && !m.aspects.includes(a)) warnings.push(`${m.label} has no ${a} aspect — ${m.aspects[0]} is used`);
      }
    }
    if (warnings.length) r.warnings = warnings;
    r.overrides = ov;
    for (const p of applyTemplate(r.prompt, { ...o, vars: { ...o.vars, ...r.vars } })) rows.push(newRow({ ...r, prompt: p }));
  }
  return rows;
}

export function normAspect(v: string) {
  const m = v.replace(/\s/g, '').match(/^(\d+)[:x/×](\d+)$/i);
  if (m) return `${m[1]}:${m[2]}`;
  if (/portrait|vertical|story|reel|short/i.test(v)) return '9:16';
  if (/square/i.test(v)) return '1:1';
  if (/landscape|wide|horizontal/i.test(v)) return '16:9';
  return v;
}

function clampInt(v: string, min: number, max: number) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

// ---------- file readers ----------

export interface Table {
  headers: string[];
  rows: Record<string, string>[];
}

export async function readCsv(text: string): Promise<Table> {
  const Papa = (await import('papaparse')).default;
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy' });
  const headers = (res.meta.fields ?? []).filter(Boolean);
  if (headers.length === 1 && !looksLikeHeader(headers[0])) {
    // single column without a header: every line is a prompt
    return { headers: ['prompt'], rows: [headers[0], ...res.data.map((r) => r[headers[0]])].filter(Boolean).map((p) => ({ prompt: p })) };
  }
  return { headers, rows: res.data };
}

function looksLikeHeader(h: string) {
  return h.length < 40 && GUESS.some(([, re]) => re.test(h.trim()));
}

export async function readXlsx(buf: ArrayBuffer): Promise<Table> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: false });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { headers, rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? '')]))) };
}

export function readJson(text: string): Table {
  const v = JSON.parse(text.replace(/^﻿/, ''));
  const arr: unknown[] = Array.isArray(v) ? v : Array.isArray(v?.prompts) ? v.prompts : Array.isArray(v?.rows) ? v.rows : [v];
  if (arr.every((x) => typeof x === 'string')) return { headers: ['prompt'], rows: (arr as string[]).map((prompt) => ({ prompt })) };
  const objs = arr.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  const hasPrompt = objs.some((o) => 'prompt' in o || 'text' in o);
  if (!hasPrompt) return { headers: ['prompt'], rows: objs.map((o) => ({ prompt: JSON.stringify(o) })) };
  const headers = [...new Set(objs.flatMap((o) => Object.keys(o)))];
  return {
    headers,
    rows: objs.map((o) => Object.fromEntries(headers.map((h) => [h, o[h] == null ? '' : typeof o[h] === 'object' ? (Array.isArray(o[h]) ? (o[h] as unknown[]).join(',') : JSON.stringify(o[h])) : String(o[h])])))
  };
}

export async function readDocx(buf: ArrayBuffer): Promise<string> {
  // mammoth is CommonJS: in the esbuild ESM bundle its functions sit on .default
  type Mammoth = { extractRawText: (o: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> };
  const mod = (await import('mammoth')) as unknown as Mammoth & { default?: Mammoth };
  const mammoth = mod.default ?? mod;
  const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
  return value;
}

/** A Google Sheets share link -> its CSV export URL (works for sheets shared "anyone with the link"). */
export function sheetsCsvUrl(url: string): string | null {
  const id = url.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1];
  if (!id) return null;
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1] ?? '0';
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

export type ImportKind = 'text' | 'csv' | 'xlsx' | 'json' | 'docx';

export function kindOfFile(name: string): ImportKind {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'xlsx' || ext === 'xls' || ext === 'ods') return 'xlsx';
  if (ext === 'json') return 'json';
  if (ext === 'docx') return 'docx';
  return 'text';
}
