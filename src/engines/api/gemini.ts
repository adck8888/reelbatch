import { blobToBase64, base64ToBlob, sleep } from '../../shared/util';
import { ApiError, readError, type ApiJob, type ApiOutput } from './types';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const headers = (key: string) => ({ 'x-goog-api-key': key, 'Content-Type': 'application/json' });

async function inline(b: Blob) {
  return { inlineData: { mimeType: b.type || 'image/png', data: await blobToBase64(b) } };
}

async function post(path: string, key: string, body: unknown, signal: AbortSignal) {
  const res = await fetch(`${BASE}/${path}`, { method: 'POST', headers: headers(key), body: JSON.stringify(body), signal });
  if (!res.ok) throw await readError(res, 'Gemini');
  return res.json();
}

export async function runGemini(job: ApiJob): Promise<ApiOutput[]> {
  return job.settings.kind === 'video' ? veo(job) : image(job);
}

// ---------- Nano Banana (generateContent) ----------

async function image(job: ApiJob): Promise<ApiOutput[]> {
  const parts: unknown[] = [{ text: job.prompt }];
  for (const r of job.refs) parts.push(await inline(r));
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: job.settings.aspect, ...(job.settings.resolution ? { imageSize: job.settings.resolution } : {}) },
      ...(job.settings.seed !== undefined ? { seed: job.settings.seed } : {})
    }
  };
  job.onStatus('sending');
  const outputs: ApiOutput[] = [];
  // The image models return one image per call; count > 1 means several calls.
  for (let i = 0; i < Math.max(1, job.settings.count); i++) {
    job.onStatus('rendering');
    const j = await post(`models/${job.target}:generateContent`, job.key, body, job.signal);
    const cand = j?.candidates?.[0];
    const imgPart = cand?.content?.parts?.find((p: { inlineData?: { data?: string } }) => p.inlineData?.data);
    if (!imgPart) {
      const reason = cand?.finishReason ?? j?.promptFeedback?.blockReason;
      if (reason && /SAFETY|PROHIBITED|BLOCK|IMAGE_SAFETY|RECITATION|OTHER/i.test(String(reason)))
        throw new ApiError('policy', `Gemini blocked this prompt (${reason})`);
      const text = cand?.content?.parts?.map((p: { text?: string }) => p.text).filter(Boolean).join(' ');
      throw new ApiError('error', `Gemini returned no image${text ? `: ${text.slice(0, 200)}` : ''}`, true);
    }
    outputs.push({ kind: 'image', blob: base64ToBlob(imgPart.inlineData.data, imgPart.inlineData.mimeType ?? 'image/png') });
  }
  return outputs;
}

// ---------- Veo (predictLongRunning) ----------

async function veo(job: ApiJob): Promise<ApiOutput[]> {
  const s = job.settings;
  const instance: Record<string, unknown> = { prompt: job.prompt };
  if (s.videoMode === 'frames' && job.startFrame) instance.image = await inline(job.startFrame);
  if (s.videoMode === 'frames' && job.endFrame) instance.lastFrame = await inline(job.endFrame);
  if (s.videoMode === 'ingredients' && job.refs.length)
    instance.referenceImages = await Promise.all(job.refs.slice(0, 3).map(async (r) => ({ image: await inline(r), referenceType: 'asset' })));
  const parameters: Record<string, unknown> = { aspectRatio: s.aspect };
  if (s.resolution) parameters.resolution = s.resolution;
  if (s.duration) parameters.durationSeconds = String(s.duration);
  if (s.negative) parameters.negativePrompt = s.negative;
  if (s.seed !== undefined) parameters.seed = s.seed;
  // Reference images, 1080p/4k and interpolation require 8 s on Veo 3.1.
  if (instance.referenceImages || instance.lastFrame || (s.resolution && s.resolution !== '720p')) parameters.durationSeconds = '8';

  job.onStatus('sending');
  const op = await post(`models/${job.target}:predictLongRunning`, job.key, { instances: [instance], parameters }, job.signal);
  if (!op?.name) throw new ApiError('error', 'Gemini did not start the video job');
  job.onStatus('rendering');

  const deadline = Date.now() + 15 * 60_000;
  let delay = 8000;
  for (;;) {
    await sleep(delay, job.signal);
    delay = Math.min(15_000, delay + 2000);
    const res = await fetch(`${BASE}/${op.name}`, { headers: headers(job.key), signal: job.signal });
    if (!res.ok) {
      const err = await readError(res, 'Gemini');
      if (!err.retryable) throw err;
      continue;
    }
    const j = await res.json();
    if (!j.done) {
      if (Date.now() > deadline) throw new ApiError('timeout', 'Veo did not finish within 15 minutes');
      continue;
    }
    if (j.error) throw new ApiError(/safety|policy|block/i.test(j.error.message ?? '') ? 'policy' : 'error', `Veo: ${j.error.message ?? 'failed'}`);
    const vr = j.response?.generateVideoResponse;
    const samples: { video?: { uri?: string } }[] = vr?.generatedSamples ?? [];
    if (!samples.length) {
      const why = (vr?.raiMediaFilteredReasons ?? []).join('; ');
      throw new ApiError('policy', `Veo filtered the result${why ? `: ${why}` : ''}`);
    }
    const out: ApiOutput[] = [];
    for (const smp of samples) {
      if (!smp.video?.uri) continue;
      const v = await fetch(smp.video.uri, { headers: { 'x-goog-api-key': job.key }, signal: job.signal, redirect: 'follow' });
      if (!v.ok) throw await readError(v, 'Gemini download');
      out.push({ kind: 'video', blob: await v.blob() });
    }
    return out;
  }
}

// ---------- key test and text model (prompt helper) ----------

interface ModelEntry {
  name: string;
  supportedGenerationMethods?: string[];
}

export async function listGeminiModels(key: string): Promise<ModelEntry[]> {
  const all: ModelEntry[] = [];
  let page = '';
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${BASE}/models?pageSize=200${page ? `&pageToken=${page}` : ''}`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw await readError(res, 'Gemini');
    const j = await res.json();
    all.push(...(j.models ?? []));
    if (!j.nextPageToken) break;
    page = j.nextPageToken;
  }
  return all;
}

export async function testGeminiKey(key: string) {
  const models = await listGeminiModels(key);
  const ids = models.map((m) => m.name.replace(/^models\//, ''));
  return { ok: true, veo: ids.filter((i) => i.startsWith('veo')), image: ids.filter((i) => /image/.test(i)) };
}

let textModel: string | null = null;

/** Pick a fast text model the key can use (newest "flash" that supports generateContent). */
export async function geminiTextModel(key: string) {
  if (textModel) return textModel;
  const models = await listGeminiModels(key);
  const text = models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini-[\d.]+-flash(-latest)?$|^gemini-flash-latest$/.test(n));
  text.sort((a, b) => (parseFloat(b.split('-')[1]) || 0) - (parseFloat(a.split('-')[1]) || 0));
  textModel = text[0] ?? 'gemini-flash-latest';
  return textModel;
}

export async function geminiText(key: string, system: string, prompt: string, json = true): Promise<string> {
  const model = await geminiTextModel(key);
  const j = await post(
    `models/${model}:generateContent`,
    key,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: json ? { responseMimeType: 'application/json', temperature: 1 } : { temperature: 1 }
    },
    new AbortController().signal
  );
  return j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
}
