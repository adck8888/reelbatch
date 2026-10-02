import type { EngineId, GenSettings, MediaKind, VideoMode } from './types';

export interface ModelInfo {
  id: string;
  engine: EngineId;
  kind: MediaKind;
  label: string;
  /** Flow: text of the model menu item. API: provider model id / Replicate slug. */
  target: string;
  aspects: string[];
  counts: number[];
  durations?: number[];
  resolutions?: string[];
  videoModes?: VideoMode[];
  maxRefs?: number;
  /** Frames mode takes a start frame only (the provider has no end-frame input); an end frame is ignored. */
  startFrameOnly?: boolean;
  /** Provider rules that pin settings (e.g. Veo needs 8 s with references or 1080p). Applied before cost(). */
  coerce?: (s: GenSettings) => void;
  /** Estimated cost per output: Flow credits, or USD for API engines. */
  cost: (s: GenSettings) => number;
  pro?: boolean;
  note?: string;
}

const IMG_ASPECTS = ['16:9', '4:3', '1:1', '3:4', '9:16'];
const VID_ASPECTS = ['16:9', '9:16'];
const API_IMG_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'];
// Per the Replicate schemas (2026-10): FLUX.2 and Ideogram 3 have no 21:9.
const NO_ULTRAWIDE = API_IMG_ASPECTS.filter((a) => a !== '21:9');

/** Veo 3.1 (Gemini API) accepts 4/6 s only at 720p without reference images; otherwise it must be 8 s. */
export function veoNeeds8s(s: Pick<GenSettings, 'videoMode' | 'resolution'>) {
  return s.videoMode === 'ingredients' || (!!s.resolution && s.resolution !== '720p');
}
const veo8 = (s: GenSettings) => {
  if (veoNeeds8s(s)) s.duration = 8;
};

const flow = (m: Omit<ModelInfo, 'engine' | 'counts'>): ModelInfo => ({ engine: 'flow', counts: [1, 2, 3, 4], ...m });

export const MODELS: ModelInfo[] = [
  // ---- Google Flow (credits; measured on a Plus plan 2026-10-02) ----
  flow({ id: 'flow:nb2', kind: 'image', label: 'Nano Banana 2', target: 'Nano Banana 2', aspects: IMG_ASPECTS, maxRefs: 10, cost: () => 0 }),
  flow({ id: 'flow:nb2-lite', kind: 'image', label: 'Nano Banana 2 Lite', target: 'Nano Banana 2 Lite', aspects: IMG_ASPECTS, maxRefs: 10, cost: () => 0 }),
  flow({ id: 'flow:nb-pro', kind: 'image', label: 'Nano Banana Pro', target: 'Nano Banana Pro', aspects: IMG_ASPECTS, maxRefs: 10, cost: () => 0, note: 'cost read live from Flow' }),
  flow({
    id: 'flow:omni-flash', kind: 'video', label: 'Omni 1.1 Flash', target: 'Omni 1.1 Flash', aspects: VID_ASPECTS,
    durations: [4, 6, 8, 10], resolutions: ['720p'], videoModes: ['text', 'frames', 'ingredients'], maxRefs: 3,
    cost: (s) => ({ 4: 7, 6: 10, 8: 12, 10: 15 } as Record<number, number>)[s.duration ?? 8] ?? 12
  }),
  flow({ id: 'flow:veo-lite', kind: 'video', label: 'Veo 3.1 Lite', target: 'Veo 3.1 - Lite', aspects: VID_ASPECTS, videoModes: ['text', 'frames', 'ingredients'], maxRefs: 3, cost: () => 10 }),
  flow({ id: 'flow:veo-fast', kind: 'video', label: 'Veo 3.1 Fast', target: 'Veo 3.1 - Fast', aspects: VID_ASPECTS, videoModes: ['text', 'frames', 'ingredients'], maxRefs: 3, cost: () => 20 }),
  flow({ id: 'flow:veo-quality', kind: 'video', label: 'Veo 3.1 Quality', target: 'Veo 3.1 - Quality', aspects: VID_ASPECTS, videoModes: ['text', 'frames', 'ingredients'], maxRefs: 3, cost: () => 100 }),

  // ---- Gemini API (USD, list prices 2026-10) ----
  {
    id: 'gemini:veo-3.1', engine: 'gemini', kind: 'video', label: 'Veo 3.1', target: 'veo-3.1-generate-preview', pro: true,
    aspects: VID_ASPECTS, counts: [1], durations: [4, 6, 8], resolutions: ['720p', '1080p', '4k'], videoModes: ['text', 'frames', 'ingredients'], maxRefs: 3, coerce: veo8,
    cost: (s) => (s.resolution === '4k' ? 0.6 : 0.4) * (s.duration ?? 8)
  },
  {
    id: 'gemini:veo-3.1-fast', engine: 'gemini', kind: 'video', label: 'Veo 3.1 Fast', target: 'veo-3.1-fast-generate-preview', pro: true,
    aspects: VID_ASPECTS, counts: [1], durations: [4, 6, 8], resolutions: ['720p', '1080p', '4k'], videoModes: ['text', 'frames', 'ingredients'], maxRefs: 3, coerce: veo8,
    cost: (s) => (s.resolution === '4k' ? 0.3 : 0.12) * (s.duration ?? 8)
  },
  {
    id: 'gemini:veo-3.1-lite', engine: 'gemini', kind: 'video', label: 'Veo 3.1 Lite', target: 'veo-3.1-lite-generate-preview', pro: true,
    aspects: VID_ASPECTS, counts: [1], durations: [4, 6, 8], resolutions: ['720p', '1080p'], videoModes: ['text', 'frames'], coerce: veo8,
    cost: (s) => (s.resolution === '1080p' ? 0.08 : 0.05) * (s.duration ?? 8)
  },
  {
    id: 'gemini:nb-pro', engine: 'gemini', kind: 'image', label: 'Nano Banana Pro', target: 'gemini-3-pro-image', pro: true,
    aspects: API_IMG_ASPECTS, counts: [1, 2, 3, 4], resolutions: ['1K', '2K', '4K'], maxRefs: 11,
    cost: (s) => (s.resolution === '4K' ? 0.24 : 0.134)
  },
  {
    id: 'gemini:nb2', engine: 'gemini', kind: 'image', label: 'Nano Banana 2', target: 'gemini-3.1-flash-image', pro: true,
    aspects: API_IMG_ASPECTS, counts: [1, 2, 3, 4], resolutions: ['1K', '2K', '4K'], maxRefs: 14,
    cost: (s) => (s.resolution === '4K' ? 0.151 : s.resolution === '2K' ? 0.101 : 0.067)
  },

  {
    id: 'gemini:nb2-lite', engine: 'gemini', kind: 'image', label: 'Nano Banana 2 Lite', target: 'gemini-3.1-flash-lite-image', pro: true,
    aspects: API_IMG_ASPECTS, counts: [1, 2, 3, 4], resolutions: ['1K'], maxRefs: 14,
    cost: () => 0.0336
  },

  // ---- Replicate (USD estimates; the model's own schema is read at run time) ----
  {
    id: 'replicate:kling-v3', engine: 'replicate', kind: 'video', label: 'Kling 3.0', target: 'kwaivgi/kling-v3-video', pro: true,
    aspects: ['16:9', '9:16', '1:1'], counts: [1], durations: [5, 10], videoModes: ['text', 'frames'],
    // Default mode "pro", audio off.
    cost: (s) => 0.224 * (s.duration ?? 5)
  },
  {
    id: 'replicate:seedance-2', engine: 'replicate', kind: 'video', label: 'Seedance 2.0', target: 'bytedance/seedance-2.0', pro: true,
    aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], counts: [1], durations: [5, 10], resolutions: ['480p', '720p', '1080p'],
    videoModes: ['text', 'frames', 'ingredients'], maxRefs: 4,
    cost: (s) => (({ '480p': 0.08, '720p': 0.18, '1080p': 0.45 } as Record<string, number>)[s.resolution ?? '480p'] ?? 0.18) * (s.duration ?? 5)
  },
  {
    id: 'replicate:hailuo-2.3', engine: 'replicate', kind: 'video', label: 'Hailuo 2.3', target: 'minimax/hailuo-2.3', pro: true,
    aspects: ['16:9'], counts: [1], durations: [6, 10], resolutions: ['768p', '1080p'], videoModes: ['text', 'frames'],
    // Hailuo only has first_frame_image (no end frame), and 1080p is 6 s only.
    startFrameOnly: true,
    coerce: (s) => {
      if (s.resolution === '1080p') s.duration = 6;
    },
    cost: (s) => (s.resolution === '1080p' ? 0.49 : s.duration === 10 ? 0.56 : 0.28)
  },
  {
    id: 'replicate:veo-3.1', engine: 'replicate', kind: 'video', label: 'Veo 3.1 (Replicate)', target: 'google/veo-3.1', pro: true,
    aspects: VID_ASPECTS, counts: [1], durations: [4, 6, 8], resolutions: ['720p', '1080p'], videoModes: ['text', 'frames', 'ingredients'], maxRefs: 3,
    // Reference images: 16:9 and 8 s only.
    coerce: (s) => {
      if (s.videoMode === 'ingredients') {
        s.aspect = '16:9';
        s.duration = 8;
      }
    },
    cost: (s) => 0.4 * (s.duration ?? 8)
  },
  {
    id: 'replicate:flux-2-pro', engine: 'replicate', kind: 'image', label: 'FLUX.2 [pro]', target: 'black-forest-labs/flux-2-pro', pro: true,
    aspects: NO_ULTRAWIDE, counts: [1], maxRefs: 8, cost: () => 0.03
  },
  {
    id: 'replicate:gpt-image-2', engine: 'replicate', kind: 'image', label: 'GPT Image 2', target: 'openai/gpt-image-2', pro: true,
    aspects: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'], counts: [1, 2, 3, 4], maxRefs: 10,
    // Default quality "auto" bills about as "high".
    cost: () => 0.128
  },
  {
    id: 'replicate:ideogram-v3-turbo', engine: 'replicate', kind: 'image', label: 'Ideogram 3 Turbo', target: 'ideogram-ai/ideogram-v3-turbo', pro: true,
    aspects: NO_ULTRAWIDE, counts: [1], cost: () => 0.03
  },
  {
    id: 'replicate:nb-pro', engine: 'replicate', kind: 'image', label: 'Nano Banana Pro (Replicate)', target: 'google/nano-banana-pro', pro: true,
    aspects: API_IMG_ASPECTS, counts: [1], maxRefs: 14, cost: () => 0.15
  }
];

export const modelById = (id: string) => MODELS.find((m) => m.id === id);

const modelKey = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');

/** Look a model up by id, label or target, ignoring case, spaces and dashes ("veo 3.1 fast" = "Veo 3.1 - Fast"). First match wins. */
export function findModel(v: string): ModelInfo | undefined {
  const k = modelKey(v.trim());
  if (!k) return undefined;
  return modelById(v.trim()) ?? MODELS.find((m) => modelKey(m.id) === k || modelKey(m.label) === k || modelKey(m.target) === k);
}

export const modelsFor = (engine: EngineId, kind?: MediaKind) =>
  MODELS.filter((m) => m.engine === engine && (!kind || m.kind === kind));

export const DEFAULT_SETTINGS: GenSettings = {
  engine: 'flow',
  kind: 'image',
  model: 'flow:nb2',
  aspect: '16:9',
  count: 1,
  videoMode: 'text',
  duration: 8,
  resolution: '720p'
};

/** Merge defaults with row overrides and coerce the result to what the model supports. */
export function effectiveSettings(defaults: GenSettings, overrides: Partial<GenSettings> = {}): GenSettings {
  const s: GenSettings = { ...defaults, ...stripUndefined(overrides) };
  let m = modelById(s.model);
  if (!m || m.engine !== s.engine || m.kind !== s.kind) {
    m = modelsFor(s.engine, s.kind)[0] ?? modelById(DEFAULT_SETTINGS.model)!;
    s.model = m.id;
    s.engine = m.engine;
    s.kind = m.kind;
  }
  if (!m.aspects.includes(s.aspect)) s.aspect = m.aspects[0];
  if (!m.counts.includes(s.count)) s.count = nearest(m.counts, s.count);
  if (m.durations) {
    if (!m.durations.includes(s.duration ?? -1)) s.duration = nearest(m.durations, s.duration ?? 8);
  } else delete s.duration;
  if (m.resolutions) {
    if (!m.resolutions.includes(s.resolution ?? '')) s.resolution = m.resolutions[0];
  } else delete s.resolution;
  if (s.kind === 'video' && m.videoModes && !m.videoModes.includes(s.videoMode)) s.videoMode = m.videoModes[0];
  m.coerce?.(s);
  return s;
}

export function estimateCost(s: GenSettings): number {
  const m = modelById(s.model);
  if (!m) return 0;
  const e = { ...s };
  m.coerce?.(e);
  return m.cost(e) * Math.max(1, s.count);
}

function nearest(list: number[], v: number) {
  return list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), list[0]);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const r: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') (r as Record<string, unknown>)[k] = v;
  return r;
}
