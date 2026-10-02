import type { FlowResult } from '../../shared/messages';

export interface BatchChunk {
  rpc: string;
  payload: unknown;
  /** Raw JSON string of the payload (for regex scans). */
  raw: string;
  error?: number;
}

/**
 * Parse Google's batchexecute response: `)]}'` then length-prefixed JSON arrays.
 * Each `["wrb.fr", rpcid, "<json>", …]` entry is one RPC result; `["er", …]` marks an error.
 */
export function parseBatch(body: string): BatchChunk[] {
  const out: BatchChunk[] = [];
  const text = body.replace(/^\)\]\}'\s*/, '');
  // Length prefixes are unreliable to slice by (they count UTF-16 units differently), so scan line-wise:
  // every chunk is a JSON array on its own line(s) following a numeric line.
  for (const part of splitChunks(text)) {
    let arr: unknown;
    try {
      arr = JSON.parse(part);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!Array.isArray(entry)) continue;
      if (entry[0] === 'wrb.fr') {
        const raw = typeof entry[2] === 'string' ? entry[2] : '';
        let payload: unknown = null;
        try {
          payload = raw ? JSON.parse(raw) : null;
        } catch {
          payload = null;
        }
        const errCode = Array.isArray(entry[5]) && typeof entry[5][0] === 'number' ? entry[5][0] : undefined;
        out.push({ rpc: String(entry[1]), payload, raw, error: raw ? undefined : errCode ?? -1 });
      } else if (entry[0] === 'er') {
        out.push({ rpc: String(entry[1] ?? ''), payload: null, raw: '', error: typeof entry[2] === 'number' ? entry[2] : -1 });
      }
    }
  }
  return out;
}

function splitChunks(text: string): string[] {
  const lines = text.split('\n');
  const parts: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    if (/^\d+$/.test(line.trim())) {
      if (buf.length) parts.push(buf.join('\n'));
      buf = [];
    } else buf.push(line);
  }
  if (buf.length) parts.push(buf.join('\n'));
  return parts.map((p) => p.trim()).filter((p) => p.startsWith('['));
}

const unescape = (s: string) =>
  s
    .replace(/\\\\u003d|\\u003d/g, '=')
    .replace(/\\\\u0026|\\u0026/g, '&')
    .replace(/\\\\\//g, '/')
    .replace(/\\\//g, '/');

/** Every signed media URL in a response, de-duplicated by media id (first URL wins). */
export function extractMedia(text: string, pattern: string): FlowResult[] {
  const re = new RegExp(pattern, 'g');
  const seen = new Map<string, FlowResult>();
  const clean = unescape(text);
  for (const m of clean.matchAll(re)) {
    const kind = m[1] === 'video' ? 'video' : 'image';
    const id = m[2];
    if (!seen.has(id)) seen.set(id, { mediaId: id, url: m[0].replace(/["\\\s].*$/, ''), kind });
  }
  return [...seen.values()];
}
