import { blobToDataUrl, sleep } from '../../shared/util';
import { ApiError, asSubmitted, downloadPaid, readError, type ApiJob, type ApiOutput } from './types';

const BASE = 'https://api.replicate.com/v1';

interface Prop {
  type?: string;
  enum?: unknown[];
  allOf?: { $ref?: string }[];
  items?: { type?: string; format?: string };
  format?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

interface Schema {
  props: Record<string, Prop>;
  enums: Record<string, unknown[]>;
  required: string[];
}

const schemaCache = new Map<string, Schema>();

/** Read the model's input schema so our generic settings map onto its real field names. */
async function schemaOf(slug: string, key: string): Promise<Schema> {
  const hit = schemaCache.get(slug);
  if (hit) return hit;
  const res = await fetch(`${BASE}/models/${slug}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw await readError(res, 'Replicate');
  const j = await res.json();
  const comps = j?.latest_version?.openapi_schema?.components?.schemas ?? {};
  const input = comps.Input ?? {};
  const enums: Record<string, unknown[]> = {};
  const props: Record<string, Prop> = input.properties ?? {};
  for (const [name, p] of Object.entries(props)) {
    const ref = p.allOf?.[0]?.$ref?.split('/').pop();
    const values = p.enum ?? (ref ? comps[ref]?.enum : undefined);
    if (values) enums[name] = values;
  }
  const s = { props, enums, required: input.required ?? [] };
  schemaCache.set(slug, s);
  return s;
}

const first = (s: Schema, names: string[]) => names.find((n) => n in s.props);

function fitEnum(s: Schema, field: string, value: unknown) {
  const e = s.enums[field];
  if (!e) return value;
  if (e.includes(value)) return value;
  const str = String(value).toLowerCase();
  return e.find((x) => String(x).toLowerCase() === str) ?? e.find((x) => String(x).toLowerCase().includes(str)) ?? undefined;
}

/** Replicate takes data URLs only for files up to 256 KB. */
export const DATA_URL_MAX = 256_000;
const FILE_MAX = 180_000; // base64 adds a third

/** Inline an image as a data URL, re-encoding big ones as a smaller JPEG so they stay under the limit. */
export async function smallDataUrl(b: Blob): Promise<string> {
  if (b.size <= FILE_MAX || typeof OffscreenCanvas === 'undefined') return blobToDataUrl(b);
  const bmp = await createImageBitmap(b);
  try {
    let out: Blob = b;
    for (const side of [1536, 1280, 1024, 768, 512]) {
      const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff'; // JPEG has no alpha
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      for (const quality of [0.85, 0.7]) {
        out = await c.convertToBlob({ type: 'image/jpeg', quality });
        if (out.size <= FILE_MAX) return blobToDataUrl(out);
      }
    }
    return blobToDataUrl(out);
  } finally {
    bmp.close();
  }
}

export async function buildInput(job: ApiJob, s: Schema): Promise<Record<string, unknown>> {
  const st = job.settings;
  const input: Record<string, unknown> = {};
  const put = (names: string[], value: unknown) => {
    const f = first(s, names);
    if (!f || value === undefined || value === null || value === '') return false;
    const v = fitEnum(s, f, s.props[f].type === 'integer' || s.props[f].type === 'number' ? Number(value) : value);
    if (v === undefined) return false;
    input[f] = v;
    return true;
  };
  put(['prompt', 'text', 'text_prompt'], job.prompt);
  put(['aspect_ratio', 'aspect', 'ratio'], st.aspect);
  put(['duration', 'duration_seconds', 'seconds', 'video_length'], st.duration);
  put(['resolution', 'quality'], st.resolution);
  put(['negative_prompt', 'negative'], st.negative);
  put(['seed'], st.seed);
  put(['num_outputs', 'number_of_images', 'n', 'num_images'], st.count > 1 ? st.count : undefined);

  const img = smallDataUrl;
  const video = st.kind === 'video';
  // Video: frames only in frames mode, references only in ingredients mode. Images: references as given.
  // Models without an end-frame field (e.g. Hailuo) simply get no end frame.
  if (video && st.videoMode === 'frames') {
    if (job.startFrame) put(['start_image', 'first_frame_image', 'image', 'input_image', 'first_frame'], await img(job.startFrame));
    if (job.endFrame) put(['end_image', 'last_frame_image', 'last_frame', 'tail_image', 'end_frame'], await img(job.endFrame));
  }
  if (job.refs.length && (!video || st.videoMode === 'ingredients')) {
    const listField = first(s, ['reference_images', 'image_input', 'input_images', 'images', 'subject_reference', 'reference_image_urls']);
    if (listField && s.props[listField].type === 'array') input[listField] = await Promise.all(job.refs.map(img));
    else if (!video) {
      // With a mask, "image" is the inpainting source (Ideogram), not a reference.
      const single = ['image', 'input_image', 'image_prompt', 'subject_reference', 'start_image'].filter((n) => !(n === 'image' && 'mask' in s.props));
      put(single, await img(job.refs[0]));
    }
    // Veo 3.1 takes reference images only at 16:9 and 8 s.
    if (video && job.target === 'google/veo-3.1' && input.reference_images) {
      if ('aspect_ratio' in s.props) input.aspect_ratio = '16:9';
      if ('duration' in s.props) input.duration = 8;
    }
  }
  // Pass-through extras the user set for this model.
  for (const [k, v] of Object.entries(st.extra ?? {})) if (k in s.props) input[k] = v;
  for (const r of s.required) if (!(r in input) && s.props[r]?.default === undefined) throw new ApiError('input', `This model needs "${r}", which Reelbatch could not fill — add it in Advanced`);
  return input;
}

function outputsOf(out: unknown, kind: 'image' | 'video'): ApiOutput[] {
  const urls: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string' && /^https?:\/\//.test(v)) urls.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(out);
  return urls.map((url) => ({ kind: /\.(mp4|webm|mov)(\?|$)/i.test(url) ? 'video' : /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url) ? 'image' : kind, url }));
}

/** Our key goes only to Replicate's own hosts. */
export function needsAuth(url: string) {
  try {
    const h = new URL(url).hostname;
    return h === 'replicate.delivery' || h.endsWith('.replicate.delivery') || h === 'api.replicate.com';
  } catch {
    return false;
  }
}

export async function runReplicate(job: ApiJob): Promise<ApiOutput[]> {
  const schema = await schemaOf(job.target, job.key);
  const input = await buildInput(job, schema);
  job.onStatus('sending');
  const auth = { Authorization: `Bearer ${job.key}` };
  const res = await fetch(`${BASE}/models/${job.target}/predictions`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'wait=5' },
    body: JSON.stringify({ input }),
    signal: job.signal
  });
  if (!res.ok) throw await readError(res, 'Replicate');
  let p = await res.json();
  job.onStatus('rendering');
  // From here the prediction is paid for: stop it when the run is stopped, and never let the runner re-run it.
  let done = false;
  const cancel = () => {
    if (!done) fetch(p.urls?.cancel ?? `${BASE}/predictions/${p.id}/cancel`, { method: 'POST', headers: auth }).catch(() => {});
  };
  job.signal.addEventListener('abort', cancel, { once: true });
  if (job.signal.aborted) cancel();
  try {
    const deadline = Date.now() + 20 * 60_000;
    while (!['succeeded', 'failed', 'canceled'].includes(p.status)) {
      await sleep(p.status === 'starting' ? 3000 : 2500, job.signal);
      if (Date.now() > deadline) {
        cancel();
        throw new ApiError('timeout', `Replicate did not finish within 20 minutes (prediction ${p.id})`, false, { submitted: true });
      }
      const r = await fetch(p.urls?.get ?? `${BASE}/predictions/${p.id}`, { headers: auth, signal: job.signal });
      if (!r.ok) {
        const err = await readError(r, 'Replicate');
        if (!err.retryable) throw err;
        continue;
      }
      p = await r.json();
    }
    done = true;
    if (p.status !== 'succeeded') {
      const msg = String(p.error ?? p.status);
      throw new ApiError(/nsfw|safety|sensitive|policy|flagged/i.test(msg) ? 'policy' : 'error', `Replicate: ${msg.slice(0, 300)}`);
    }
    const outs = outputsOf(p.output, job.settings.kind);
    if (!outs.length) throw new ApiError('error', `Replicate returned no output (prediction ${p.id})`);
    // Replicate deletes outputs after an hour: fetch the bytes now.
    return await Promise.all(
      outs.map(async (o) => ({
        ...o,
        blob: await downloadPaid(o.url!, needsAuth(o.url!) ? { headers: auth } : {}, job.signal, `The Replicate output (prediction ${p.id})`)
      }))
    );
  } catch (e) {
    throw asSubmitted(e);
  } finally {
    done = true;
    job.signal.removeEventListener('abort', cancel);
  }
}

export async function testReplicateKey(key: string) {
  const res = await fetch(`${BASE}/account`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw await readError(res, 'Replicate');
  const j = await res.json();
  return { ok: true, username: j.username as string };
}
