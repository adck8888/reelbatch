import type { ApiKeys, GenSettings, MediaKind, RunScope, Schedule } from './types';

// ---------- panel -> background ----------
export type PanelRequest =
  | { type: 'run:start'; queueId: string; scope: RunScope }
  | { type: 'run:pause' }
  | { type: 'run:resume' }
  | { type: 'run:stop' }
  | { type: 'run:estimate'; queueId: string; scope: RunScope }
  | { type: 'flow:tabs' }
  | { type: 'flow:open' }
  | { type: 'flow:health'; tabId?: number }
  | { type: 'license:activate'; key: string }
  | { type: 'license:deactivate' }
  | { type: 'license:refresh' }
  | { type: 'license:trial' }
  | { type: 'api:test'; provider: keyof ApiKeys; key: string }
  | { type: 'helper'; mode: HelperMode; input: string; n: number; lang?: string }
  | { type: 'export:zip'; runId?: string }
  | { type: 'export:sidecar'; queueId: string }
  | { type: 'schedule:set'; schedule: Schedule | null }
  | { type: 'config:reload' };

export type HelperMode = 'expand' | 'script' | 'variations' | 'translate' | 'improve';

export interface Estimate {
  rows: number;
  outputs: number;
  credits: number;
  usd: number;
  freeLeft: number | null;
  proNeeded: string[];
}

export interface HealthItem {
  key: string;
  ok: boolean;
  detail?: string;
}

export interface HealthReport {
  ok: boolean;
  tabId?: number;
  url?: string;
  signedIn?: boolean;
  items: HealthItem[];
  configVersion?: string;
}

// ---------- background -> Flow content script ----------
export type FlowCommand =
  | { type: 'ping' }
  | { type: 'health' }
  | { type: 'prepare'; settings: GenSettings; target: string }
  | { type: 'focusEditor' }
  | { type: 'editorText' }
  | { type: 'markGenerate' }
  | { type: 'snapshot' }
  | { type: 'attach'; slot: 'refs' | 'start' | 'end'; files: { name: string; type: string; dataUrl: string }[] }
  | { type: 'clearAttachments' }
  | {
      type: 'watch';
      /** Lets the background cancel this watch. */
      id: string;
      since: number;
      known: string[];
      expect: number;
      kind: MediaKind;
      timeoutMs: number;
      prompt: string;
      /** Hook id of the generate request this submit sent (0 when unknown, e.g. video). */
      req: number;
      /** Other jobs render in the same tab: accept only results tied to this request or prompt. */
      parallel: boolean;
    }
  | { type: 'cancelWatch'; id: string }
  | { type: 'claimRequest'; since: number }
  | { type: 'download'; mediaId: string; quality: string }
  | { type: 'dismiss' }
  | { type: 'videoFrame'; mediaId: string; which: 'last' | 'first' };

export interface FlowSnapshot {
  mediaIds: string[];
  rendering: number;
  alerts: string[];
}

export interface FlowResult {
  mediaId: string;
  url: string;
  kind: MediaKind;
}

export type WatchOutcome =
  | { ok: true; results: FlowResult[]; partial?: boolean }
  | { ok: false; reason: 'policy' | 'credits' | 'unusual' | 'timeout' | 'error' | 'limit'; message: string; results: FlowResult[] };

export interface PrepareOutcome {
  ok: boolean;
  cost?: number;
  state?: string;
  error?: string;
}

/** Page hook (MAIN world) -> content script, via window.postMessage. */
export interface HookMessage {
  source: 'reelbatch-hook';
  /** Request sequence number within the page. */
  id: number;
  phase: 'start' | 'end';
  rpcids: string;
  status: number;
  body: string;
  t: number;
}

export async function send<T = unknown>(msg: PanelRequest): Promise<T> {
  const res = await chrome.runtime.sendMessage(msg);
  if (res && typeof res === 'object' && 'error' in res && res.error) throw new Error(String(res.error));
  return res as T;
}
