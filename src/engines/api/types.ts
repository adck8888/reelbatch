import type { GenSettings, MediaKind } from '../../shared/types';

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
  constructor(public reason: ApiFailReason, message: string, public retryable = false) {
    super(message);
  }
}

export async function readError(res: Response, provider: string): Promise<ApiError> {
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.error?.message ?? j?.detail ?? j?.title ?? JSON.stringify(j).slice(0, 300);
  } catch {
    detail = await res.text().catch(() => '');
  }
  const msg = `${provider}: ${detail || res.statusText} (HTTP ${res.status})`;
  if (res.status === 401 || res.status === 403) return new ApiError('auth', msg);
  if (res.status === 402) return new ApiError('quota', msg);
  if (res.status === 429) return new ApiError(/quota|billing|credit/i.test(detail) ? 'quota' : 'limit', msg, !/quota|billing|credit/i.test(detail));
  if (res.status === 400 || res.status === 422) return new ApiError(/safety|policy|block|sensitive|nsfw/i.test(detail) ? 'policy' : 'input', msg);
  return new ApiError('error', msg, res.status >= 500);
}
