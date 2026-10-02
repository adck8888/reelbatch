export interface NameContext {
  n: number;
  total: number;
  prompt: string;
  model: string;
  queue: string;
  variant: number;
  kind: string;
  date?: Date;
  vars?: Record<string, string>;
}

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;

/** Make one path segment safe for chrome.downloads (Windows rules are the strictest). */
export function safeSegment(s: string, max = 80) {
  let out = s.replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim();
  out = out.replace(/^[.\s]+|[.\s]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = `_${out}`;
  return out.slice(0, max).trim() || '_';
}

export function slug(s: string, max = 60) {
  return safeSegment(
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase(),
    max
  );
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

export function renderName(tpl: string, c: NameContext): string {
  const d = c.date ?? new Date();
  const width = Math.max(3, String(c.total).length);
  const values: Record<string, string> = {
    n: pad(c.n, width),
    num: String(c.n),
    prompt: slug(c.prompt, 60),
    prompt30: slug(c.prompt, 30),
    model: slug(c.model, 30),
    queue: safeSegment(c.queue, 40),
    variant: String(c.variant),
    kind: c.kind,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`,
    time: `${pad(d.getHours(), 2)}-${pad(d.getMinutes(), 2)}-${pad(d.getSeconds(), 2)}`
  };
  for (const [k, v] of Object.entries(c.vars ?? {})) if (!(k in values)) values[k] = slug(v, 40);
  return tpl.replace(/\{([\w.-]+)\}/g, (all, k: string) => values[k] ?? values[k.toLowerCase()] ?? all);
}

/** Folder template + file template + extension -> a relative path for chrome.downloads. */
export function buildPath(folderTpl: string, fileTpl: string, ext: string, c: NameContext): string {
  const folder = renderName(folderTpl, c)
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((s) => safeSegment(s, 60));
  let file = safeSegment(renderName(fileTpl || '{n}', c), 120);
  if (c.variant > 1 && !/\{variant\}/.test(fileTpl)) file += `_${c.variant}`;
  return [...folder, `${file}.${ext}`].join('/');
}
