import type { GenSettings, MediaKind } from '../../shared/types';
import { errText, isAbort, sleep } from '../../shared/util';

export interface ApiJob {
  prompt: string;
  settings: GenSettings;
  /** Provider model id / Replicate slug. */
  target: string;
  refs: Blob[];
  startFrame?: Blob;
  endFrame?: Blob;
  key: string;
  signal: AbortSignal;
  /** 'rendering' means the provider accepted the paid job: the cost is spent from here on. */
  onStatus: (s: 'sending' | 'rendering') => void;
}

/** A finished output. `blob` is set when the provider returns bytes (or URLs that need our key / expire fast). */
export interface ApiOutput {
  kind: MediaKind;
  url?: string;
  blob?: Blob;
}

export type ApiFailReason = 'auth' | 'policy' | 'quota' | 'limit' | 'error' | 'timeout' | 'input';

export class ApiError extends Error {
  /** The provider already accepted (and billed) the job: re-running it would pay twice. Never retryable. */
  submitted: boolean;
  constructor(public reason: ApiFailReason, message: string, public retryable = false, opts: { submitted?: boolean } = {}) {
    super(message);
    this.submitted = !!opts.submitted;
    if (this.submitted) this.retryable = false;
  }
}

/** Mark an error thrown after the paid job was accepted. Aborts pass through untouched. */
export function asSubmitted(e: unknown): unknown {
  if (isAbort(e)) return e;
  if (e instanceof ApiError) {
    e.submitted = true;
    e.retryable = false;
    return e;
  }
  return new ApiError('error', errText(e), false, { submitted: true });
}

export function classifyError(status: number, detail: string, provider: string, statusText = ''): ApiError {
  const msg = `${provider}: ${detail || statusText} (HTTP ${status})`;
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|API_KEY_EXPIRED/i.test(detail)) return new ApiError('auth', msg);
  if (status === 402) return new ApiError('quota', msg);
  if (status === 429) return new ApiError(/quota|billing|credit/i.test(detail) ? 'quota' : 'limit', msg, !/quota|billing|credit/i.test(detail));
  if (status === 400 || status === 422) return new ApiError(/safety|policy|block|sensitive|nsfw/i.test(detail) ? 'policy' : 'input', msg);
  // 5xx is worth a retry only before the job was accepted; post-submit callers wrap this with asSubmitted().
  return new ApiError('error', msg, status >= 500);
}

export async function readError(res: Response, provider: string): Promise<ApiError> {
  let detail = '';
  try {
    const j = await res.clone().json();
    detail = j?.error?.message ?? j?.detail ?? j?.title ?? JSON.stringify(j).slice(0, 300);
    const reason = j?.error?.details?.find?.((d: { reason?: string }) => d?.reason)?.reason;
    if (reason && !detail.includes(reason)) detail += ` [${reason}]`;
  } catch {
    detail = await res.text().catch(() => '');
  }
  return classifyError(res.status, detail, provider, res.statusText);
}

export const DOWNLOAD_BACKOFF = [1000, 3000, 8000];

/**
 * Fetch a finished output, retrying in place. The generation is already paid for, so a failure here
 * must never send the job back to the provider: it ends in a non-retryable, submitted ApiError.
 */
export async function downloadPaid(url: string, init: RequestInit, signal: AbortSignal, what: string, backoff = DOWNLOAD_BACKOFF): Promise<Blob> {
  let last = '';
  for (let i = 0; i <= backoff.length; i++) {
    if (i) await sleep(backoff[i - 1], signal);
    try {
      const r = await fetch(url, { ...init, signal });
      if (r.ok) return await r.blob();
      last = `HTTP ${r.status}`;
    } catch (e) {
      if (isAbort(e)) throw e;
      last = errText(e);
    }
  }
  throw new ApiError('error', `${what} was generated (and paid for) but could not be downloaded (${last}). Fetch it manually: ${url}`, false, { submitted: true });
}
