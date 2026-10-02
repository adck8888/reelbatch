export type EngineId = 'flow' | 'gemini' | 'replicate';
export type MediaKind = 'image' | 'video';
/** text = prompt only; frames = start (and optional end) frame; ingredients = reference images. */
export type VideoMode = 'text' | 'frames' | 'ingredients';

export interface GenSettings {
  engine: EngineId;
  kind: MediaKind;
  /** Model id from the catalog in models.ts. */
  model: string;
  aspect: string;
  count: number;
  videoMode: VideoMode;
  duration?: number;
  resolution?: string;
  negative?: string;
  seed?: number;
  /** Video model used to animate stills when a row has a motion prompt (image→video pipeline). */
  motionModel?: string;
  /** Provider-specific extras for API models (e.g. Replicate input fields). */
  extra?: Record<string, unknown>;
}

export interface Row {
  id: string;
  prompt: string;
  enabled: boolean;
  overrides: Partial<GenSettings>;
  /** Asset ids (IndexedDB) used as reference images / ingredients. */
  refs: string[];
  startFrame?: string;
  endFrame?: string;
  /** Second step of the image→video pipeline: animate the still with this prompt. */
  motionPrompt?: string;
  /** Use the previous row's last result as this row's start frame / reference. */
  chain?: boolean;
  filename?: string;
  folder?: string;
  /** Free-form values from imported columns, usable as {column} in filename templates. */
  vars?: Record<string, string>;
}

export type RowStatus =
  | 'queued'
  | 'waiting'
  | 'sending'
  | 'rendering'
  | 'downloading'
  | 'done'
  | 'failed'
  | 'skipped';

export interface ResultMedia {
  url: string;
  kind: MediaKind;
  mediaId?: string;
  file?: string;
  downloadId?: number;
  bytes?: number;
  /** Asset id of a cached copy (thumbnail or full file) used for chaining and the gallery. */
  assetId?: string;
}

export interface RowRun {
  status: RowStatus;
  attempts: number;
  error?: string;
  results: ResultMedia[];
  cost?: number;
  startedAt?: number;
  finishedAt?: number;
  tabId?: number;
}

export interface Queue {
  id: string;
  name: string;
  rows: Row[];
  defaults: GenSettings;
  createdAt: number;
  updatedAt: number;
}

export interface DownloadOptions {
  enabled: boolean;
  /** Folder template under Downloads, e.g. "Reelbatch/{queue}". */
  folder: string;
  /** File name template without extension, e.g. "{n}_{prompt}". */
  filename: string;
  imageQuality: '1k' | '2k' | '4k';
  videoQuality: '720p' | '1080p' | '4k';
  sidecar: boolean;
}

export interface RunOptions {
  concurrency: number;
  delayMin: number;
  delayMax: number;
  /** Extra "reading" pause per 100 prompt characters, seconds. */
  readingPause: number;
  retries: number;
  /** Stop before the spend of this run would pass these limits. 0 = off. */
  budgetCredits: number;
  budgetUsd: number;
  /** Pause the run after this many consecutive failures. 0 = off. */
  stopAfterFails: number;
  /** Flow tab ids to spread the run over; empty = the active Flow tab (opened if needed). */
  tabs: number[];
  download: DownloadOptions;
}

export type RunScope =
  | { kind: 'all' }
  | { kind: 'failed' }
  /** Everything not finished yet (used to continue an interrupted run). */
  | { kind: 'pending' }
  | { kind: 'selected'; ids: string[] }
  | { kind: 'range'; from: number; to: number };

export type RunStatus = 'idle' | 'running' | 'paused' | 'cooldown' | 'stopping';

export interface RunState {
  status: RunStatus;
  runId?: string;
  queueId?: string;
  scope?: RunScope;
  startedAt?: number;
  spent: { credits: number; usd: number };
  cooldownUntil?: number;
  message?: string;
  rows: Record<string, RowRun>;
}

export interface Character {
  id: string;
  name: string;
  description: string;
  refs: string[];
  createdAt: number;
}

export interface HistoryItem {
  id: string;
  runId: string;
  queueName: string;
  rowId: string;
  n: number;
  prompt: string;
  engine: EngineId;
  model: string;
  kind: MediaKind;
  url: string;
  file?: string;
  thumbId?: string;
  /** Stored copy of a result that has no lasting URL (API outputs), for ZIP export. */
  assetId?: string;
  cost?: number;
  createdAt: number;
}

export type LicenseStatus = 'free' | 'trial' | 'pro';

export interface LicenseState {
  key?: string;
  /** Lemon Squeezy key status: active, inactive, expired, disabled. */
  keyStatus?: string;
  instanceId?: string;
  validatedAt?: number;
  lastOkAt?: number;
  trialStartedAt?: number;
  plan?: string;
  error?: string;
}

export interface Schedule {
  enabled: boolean;
  at: number;
  queueId: string;
  scope: RunScope;
}

export interface ApiKeys {
  gemini?: string;
  replicate?: string;
}

export interface AppSettings {
  lang: string;
  theme: 'system' | 'light' | 'dark';
  run: RunOptions;
  keys: ApiKeys;
  notify: boolean;
  /** Use the remote selector config (falls back to the bundled one). */
  remoteConfig: boolean;
  onboarded: boolean;
}

export interface UsageDay {
  day: string;
  prompts: number;
}

export interface LogLine {
  t: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}
