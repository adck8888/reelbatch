import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byVersionDesc, noImageError } from '../src/engines/api/gemini';
import { buildInput, needsAuth } from '../src/engines/api/replicate';
import { ApiError, asSubmitted, classifyError, downloadPaid, type ApiJob } from '../src/engines/api/types';
import { DEFAULT_SETTINGS, effectiveSettings, estimateCost, veoNeeds8s } from '../src/shared/models';
import type { GenSettings } from '../src/shared/types';

const eff = (o: Partial<GenSettings>) => effectiveSettings({ ...DEFAULT_SETTINGS, ...o });

describe('api errors', () => {
  it('treats an invalid Gemini key (HTTP 400) as auth', () => {
    expect(classifyError(400, 'API key not valid. Please pass a valid API key. [API_KEY_INVALID]', 'Gemini').reason).toBe('auth');
    expect(classifyError(400, 'expired [API_KEY_EXPIRED]', 'Gemini').reason).toBe('auth');
    expect(classifyError(400, 'bad aspect ratio', 'Gemini').reason).toBe('input');
  });

  it('retries 5xx only before submit', () => {
    const e = classifyError(503, 'busy', 'Replicate');
    expect(e.retryable).toBe(true);
    const s = asSubmitted(e) as ApiError;
    expect(s.submitted).toBe(true);
    expect(s.retryable).toBe(false);
    expect(new ApiError('timeout', 'x', true, { submitted: true }).retryable).toBe(false);
    const wrapped = asSubmitted(new TypeError('Failed to fetch')) as ApiError;
    expect(wrapped).toBeInstanceOf(ApiError);
    expect(wrapped.submitted).toBe(true);
    const abort = new DOMException('Aborted', 'AbortError');
    expect(asSubmitted(abort)).toBe(abort);
  });

  it('separates blocked prompts from retryable empty answers', () => {
    expect(noImageError('IMAGE_SAFETY', '').reason).toBe('policy');
    expect(noImageError('PROHIBITED_CONTENT', '').reason).toBe('policy');
    for (const r of ['OTHER', 'IMAGE_OTHER', 'NO_IMAGE']) {
      const e = noImageError(r, '');
      expect(e.reason).toBe('error');
      expect(e.retryable).toBe(true);
    }
  });
});

describe('paid downloads', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries in place, then fails without a re-run', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 502 })).mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const b = await downloadPaid('https://x/y.mp4', {}, new AbortController().signal, 'Video', [0, 0, 0]);
    expect(await b.text()).toBe('ok');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    const err = await downloadPaid('https://x/y.mp4', {}, new AbortController().signal, 'Video', [0, 0, 0]).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.submitted).toBe(true);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('https://x/y.mp4');
  });
});

describe('model rules and prices', () => {
  it('forces 8 s on Veo only for references or 1080p/4k', () => {
    expect(veoNeeds8s({ videoMode: 'frames', resolution: '720p' })).toBe(false);
    expect(veoNeeds8s({ videoMode: 'ingredients', resolution: '720p' })).toBe(true);
    expect(veoNeeds8s({ videoMode: 'text', resolution: '1080p' })).toBe(true);
    const base = { engine: 'gemini', kind: 'video', model: 'gemini:veo-3.1-fast', duration: 4 } as const;
    expect(eff({ ...base, videoMode: 'frames', resolution: '720p' }).duration).toBe(4);
    expect(eff({ ...base, videoMode: 'text', resolution: '1080p' }).duration).toBe(8);
    expect(estimateCost({ ...DEFAULT_SETTINGS, ...base, videoMode: 'ingredients', resolution: '720p' })).toBeCloseTo(0.12 * 8);
  });

  it('coerces Hailuo 1080p to 6 s and prices it', () => {
    const s = eff({ engine: 'replicate', kind: 'video', model: 'replicate:hailuo-2.3', duration: 10, resolution: '1080p' });
    expect(s.duration).toBe(6);
    expect(estimateCost(s)).toBeCloseTo(0.49);
    expect(estimateCost(eff({ engine: 'replicate', kind: 'video', model: 'replicate:hailuo-2.3', duration: 10, resolution: '768p' }))).toBeCloseTo(0.56);
  });

  it('prices Replicate video per second', () => {
    const sd = (resolution: string) => estimateCost(eff({ engine: 'replicate', kind: 'video', model: 'replicate:seedance-2', duration: 10, resolution }));
    expect(sd('480p')).toBeCloseTo(0.8);
    expect(sd('720p')).toBeCloseTo(1.8);
    expect(sd('1080p')).toBeCloseTo(4.5);
    expect(estimateCost(eff({ engine: 'replicate', kind: 'video', model: 'replicate:kling-v3', duration: 5 }))).toBeCloseTo(1.12);
    expect(estimateCost(eff({ engine: 'replicate', kind: 'image', model: 'replicate:gpt-image-2', count: 2 }))).toBeCloseTo(0.256);
    expect(eff({ engine: 'gemini', kind: 'image', model: 'gemini:nb2-lite', resolution: '2K' }).resolution).toBe('1K');
  });

  it('pins Replicate Veo ingredients to 16:9 and 8 s', () => {
    const s = eff({ engine: 'replicate', kind: 'video', model: 'replicate:veo-3.1', videoMode: 'ingredients', aspect: '9:16', duration: 4 });
    expect(s.aspect).toBe('16:9');
    expect(s.duration).toBe(8);
  });
});

describe('replicate input', () => {
  beforeEach(() => {
    vi.stubGlobal('FileReader', class {
      result = '';
      onload = () => {};
      onerror = () => {};
      readAsDataURL(b: Blob) {
        b.arrayBuffer().then((buf) => {
          this.result = `data:${b.type};base64,${Buffer.from(buf).toString('base64')}`;
          this.onload();
        });
      }
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const schema = (props: Record<string, object>) => ({ props, enums: {}, required: [] as string[] });
  const blob = () => new Blob(['x'], { type: 'image/png' });
  const job = (settings: Partial<GenSettings>, extra: Partial<ApiJob> = {}): ApiJob => ({
    prompt: 'p', settings: { ...DEFAULT_SETTINGS, ...settings }, target: 'x/y', refs: [], key: 'k',
    signal: new AbortController().signal, onStatus: () => {}, ...extra
  });

  it('sends frames only in frames mode and references only in ingredients mode', async () => {
    const s = schema({ prompt: { type: 'string' }, start_image: { type: 'string' }, reference_images: { type: 'array' } });
    const frames = await buildInput(job({ kind: 'video', videoMode: 'frames' }, { startFrame: blob(), refs: [blob()] }), s);
    expect(frames.start_image).toBeTruthy();
    expect(frames.reference_images).toBeUndefined();
    const ingr = await buildInput(job({ kind: 'video', videoMode: 'ingredients' }, { startFrame: blob(), refs: [blob()] }), s);
    expect(ingr.start_image).toBeUndefined();
    expect(ingr.reference_images).toHaveLength(1);
  });

  it('does not put a reference into an inpainting image field', async () => {
    const s = schema({ prompt: { type: 'string' }, image: { type: 'string' }, mask: { type: 'string' } });
    const input = await buildInput(job({ kind: 'image' }, { refs: [blob()] }), s);
    expect(input.image).toBeUndefined();
  });

  it('sends the key only to Replicate hosts', () => {
    expect(needsAuth('https://replicate.delivery/xezq/a.mp4')).toBe(true);
    expect(needsAuth('https://api.replicate.com/v1/files/x')).toBe(true);
    expect(needsAuth('https://example.com/a.png')).toBe(false);
  });
});

describe('gemini text model', () => {
  it('sorts versions numerically', () => {
    expect(['gemini-3.8-flash', 'gemini-3.10-flash', 'gemini-2.5-flash'].sort(byVersionDesc)[0]).toBe('gemini-3.10-flash');
  });
});
