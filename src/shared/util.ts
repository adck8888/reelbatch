export const uid = () => crypto.randomUUID();

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

export const rand = (min: number, max: number) => min + Math.random() * Math.max(0, max - min);

export const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Retry with exponential backoff and jitter. `retryable` decides whether an error is worth another try. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  { retries = 3, base = 1500, max = 60_000, retryable = (_e: unknown) => true, signal }: {
    retries?: number; base?: number; max?: number; retryable?: (e: unknown) => boolean; signal?: AbortSignal;
  } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (isAbort(e) || attempt >= retries || !retryable(e)) throw e;
      await sleep(Math.min(max, base * 2 ** attempt) * rand(0.7, 1.3), signal);
    }
  }
}

export function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function blobToBase64(blob: Blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBlob(b64: string, type: string) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type });
}

export function extFromType(type: string, fallback: string) {
  const t = type.toLowerCase();
  if (t.includes('png')) return 'png';
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('webp')) return 'webp';
  if (t.includes('gif')) return 'gif';
  if (t.includes('mp4')) return 'mp4';
  if (t.includes('webm')) return 'webm';
  if (t.includes('quicktime')) return 'mov';
  if (t.includes('csv')) return 'csv';
  if (t.includes('json')) return 'json';
  if (t.includes('zip')) return 'zip';
  if (t.startsWith('text/')) return 'txt';
  return fallback;
}
