import { veoNeeds8s } from '../../shared/models';
import { blobToBase64, base64ToBlob, isAbort, sleep } from '../../shared/util';
import { ApiError, asSubmitted, downloadPaid, readError, type ApiJob, type ApiOutput } from './types';

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

interface Part {
  text?: string;
  thought?: boolean;
  inlineData?: { data?: string; mimeType?: string };
}

/** No image and why: blocked prompts are final, OTHER / IMAGE_OTHER / NO_IMAGE are worth another try. */
export function noImageError(reason: string | undefined, text: string): ApiError {
  if (reason && /SAFETY|PROHIBITED|BLOCKLIST|RECITATION/i.test(reason)) return new ApiError('policy', `Gemini blocked this prompt (${reason})`);
  return new ApiError('error', `Gemini returned no image${reason ? ` (${reason})` : ''}${text ? `: ${text.slice(0, 200)}` : ''}`, true);
}

async function image(job: ApiJob): Promise<ApiOutput[]> {
  const parts: unknown[] = [{ text: job.prompt }];
  for (const r of job.refs) parts.push(await inline(r));
  const s = job.settings;
  const body = (i: number) => ({
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: s.aspect, ...(s.resolution ? { imageSize: s.resolution } : {}) },
      // A fixed seed would give the same image on every call: vary it per output.
      ...(s.seed !== undefined ? { seed: s.seed + i } : {})
    }
  });
  job.onStatus('sending');
  const outputs: ApiOutput[] = [];
  // The image models return one image per call; count > 1 means several calls.
  for (let i = 0; i < Math.max(1, s.count); i++) {
    try {
      job.onStatus('rendering');
      // The request is out: a lost response counts as billed. An HTTP error means it was refused, not billed.
      const res = await fetch(`${BASE}/models/${job.target}:generateContent`, { method: 'POST', headers: headers(job.key), body: JSON.stringify(body(i)), signal: job.signal }).catch((e) => {
        throw asSubmitted(e);
      });
      if (!res.ok) throw await readError(res, 'Gemini');
      const j = await res.json().catch((e) => {
        throw asSubmitted(e);
      });
      const cand = j?.candidates?.[0];
      const resParts: Part[] = cand?.content?.parts ?? [];
      const imgPart = resParts.find((p) => !p.thought && p.inlineData?.data);
      if (!imgPart) {
        const reason = cand?.finishReason ?? j?.promptFeedback?.blockReason;
        throw noImageError(reason && String(reason), resParts.filter((p) => !p.thought).map((p) => p.text).filter(Boolean).join(' '));
      }
      outputs.push({ kind: 'image', blob: base64ToBlob(imgPart.inlineData!.data!, imgPart.inlineData!.mimeType ?? 'image/png') });
    } catch (e) {
      // Earlier images are paid for: keep them rather than fail the row and run them again.
      if (outputs.length && !isAbort(e)) return outputs;
      throw e;
    }
  }
  return outputs;
}

// ---------- Veo (predictLongRunning) ----------

async function veo(job: ApiJob): Promise<ApiOutput[]> {
  const s = job.settings;
  // Veo 3.1 has no negativePrompt parameter any more: say it in the prompt.
  const instance: Record<string, unknown> = { prompt: s.negative ? `${job.prompt} Avoid: ${s.negative}` : job.prompt };
  if (s.videoMode === 'frames' && job.startFrame) instance.image = await inline(job.startFrame);
  if (s.videoMode === 'frames' && job.endFrame) instance.lastFrame = await inline(job.endFrame);
  if (s.videoMode === 'ingredients' && job.refs.length)
    instance.referenceImages = await Promise.all(job.refs.slice(0, 3).map(async (r) => ({ image: await inline(r), referenceType: 'asset' })));
  const parameters: Record<string, unknown> = { aspectRatio: s.aspect };
  if (s.resolution) parameters.resolution = s.resolution;
  if (s.duration) parameters.durationSeconds = String(s.duration);
  if (s.seed !== undefined) parameters.seed = s.seed;
  // Reference images and 1080p/4k require 8 s on Veo 3.1 (same rule as the cost estimate).
  if (veoNeeds8s({ videoMode: instance.referenceImages ? 'ingredients' : 'text', resolution: s.resolution })) parameters.durationSeconds = '8';

  job.onStatus('sending');
  const op = await post(`models/${job.target}:predictLongRunning`, job.key, { instances: [instance], parameters }, job.signal);
  if (!op?.name) throw new ApiError('error', 'Gemini did not start the video job');
  job.onStatus('rendering');
  try {
    return await veoResult(job, op.name);
  } catch (e) {
    throw asSubmitted(e);
  }
}

async function veoResult(job: ApiJob, name: string): Promise<ApiOutput[]> {
  const deadline = Date.now() + 15 * 60_000;
  const timeout = () => new ApiError('timeout', `Veo did not finish within 15 minutes (operation ${name})`, false, { submitted: true });
  let delay = 8000;
  for (;;) {
    await sleep(delay, job.signal);
    delay = Math.min(15_000, delay + 2000);
    const res = await fetch(`${BASE}/${name}`, { headers: headers(job.key), signal: job.signal });
    if (!res.ok) {
      const err = await readError(res, 'Gemini');
      if (!err.retryable) throw err;
      if (Date.now() > deadline) throw timeout();
      continue;
    }
    const j = await res.json();
    if (!j.done) {
      if (Date.now() > deadline) throw timeout();
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
      const blob = await downloadPaid(smp.video.uri, { headers: { 'x-goog-api-key': job.key }, redirect: 'follow' }, job.signal, `The Veo video (operation ${name})`);
      out.push({ kind: 'video', blob });
    }
    if (!out.length) throw new ApiError('error', `Veo finished without a video link (operation ${name})`);
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

/** Text model per key: keys can see different model lists. */
const textModels = new Map<string, string>();

/** "gemini-3.10-flash" -> [3, 10]; compared numerically so 3.10 sorts above 3.8. */
export function modelVersion(name: string): number[] {
  return (name.match(/^gemini-([\d.]+)/)?.[1] ?? '').split('.').filter(Boolean).map(Number);
}

export function byVersionDesc(a: string, b: string) {
  const va = modelVersion(a);
  const vb = modelVersion(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? 0) - (va[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Pick a fast text model the key can use (newest "flash" that supports generateContent). */
export async function geminiTextModel(key: string) {
  const hit = textModels.get(key);
  if (hit) return hit;
  const models = await listGeminiModels(key);
  const text = models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini-[\d.]+-flash(-latest)?$|^gemini-flash-latest$/.test(n));
  text.sort(byVersionDesc);
  const model = text[0] ?? 'gemini-flash-latest';
  textModels.set(key, model);
  return model;
}

export async function geminiText(key: string, system: string, prompt: string, json = true): Promise<string> {
  const model = await geminiTextModel(key);
  const j = await post(
    `models/${model}:generateContent`,
    key,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 1,
        ...(json ? { responseMimeType: 'application/json' } : {}),
        // thinkingLevel exists from Gemini 3 on; 2.x models reject it.
        ...((modelVersion(model)[0] ?? 3) >= 3 ? { thinkingConfig: { thinkingLevel: 'low' } } : {})
      }
    },
    AbortSignal.timeout(60_000)
  );
  return j?.candidates?.[0]?.content?.parts?.filter((p: Part) => !p.thought).map((p: Part) => p.text ?? '').join('') ?? '';
}
