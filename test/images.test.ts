import { describe, expect, it } from 'vitest';
import { effectiveSettings, DEFAULT_SETTINGS } from '../src/shared/models';
import { fileStem, fitWithin, promptsForImages, rowsFromImages } from '../src/shared/images';

describe('fileStem', () => {
  it('drops the folder and the last extension', () => {
    expect(fileStem('Beach Day.final.JPG')).toBe('Beach Day.final');
    expect(fileStem('C:\\photos\\cat.png')).toBe('cat');
    expect(fileStem('a/b/dog.webp')).toBe('dog');
  });
  it('removes template characters and never returns empty', () => {
    expect(fileStem('{x|y}.jpg')).toBe('xy');
    expect(fileStem('{}.png')).toBe('image');
    expect(fileStem('.jpg')).toBe('.jpg');
  });
});

describe('promptsForImages', () => {
  const names = ['cat.jpg', 'dog.png', 'fox.webp'];

  it('gives every image the same prompt with {filename} filled in', () => {
    expect(promptsForImages(names, 'Slow zoom on {filename}', 'same').map((p) => p.prompt)).toEqual([
      'Slow zoom on cat', 'Slow zoom on dog', 'Slow zoom on fox'
    ]);
  });

  it('deals variations out across the images in turn', () => {
    expect(promptsForImages(names, 'Pan {left|right}', 'same').map((p) => p.prompt)).toEqual(['Pan left', 'Pan right', 'Pan left']);
  });

  it('keeps {a|b} as text when variations are off', () => {
    expect(promptsForImages(['a.jpg'], 'Pan {left|right}', 'same', false)[0].prompt).toBe('Pan {left|right}');
  });

  it('does not expand braces or pipes that come from a file name', () => {
    expect(promptsForImages(['{a|b}.jpg'], 'Look at {filename}', 'same')[0].prompt).toBe('Look at ab');
  });

  it('matches lines to images by order, ignoring blank lines', () => {
    const out = promptsForImages(names, 'walks\n\n  runs {filename}  \n', 'lines');
    expect(out.map((p) => p.prompt)).toEqual(['walks', 'runs dog', '']);
    expect(out[2].warnings?.length).toBe(1);
    expect(out[0].warnings).toBeUndefined();
  });

  it('returns empty prompts for an empty template', () => {
    expect(promptsForImages(names, '   ', 'same').every((p) => p.prompt === '')).toBe(true);
  });
});

describe('rowsFromImages', () => {
  const imgs = [{ asset: 'a1', name: 'cat.jpg' }, { asset: 'a2', name: 'dog.png' }];
  const prompts = [{ prompt: 'p1' }, { prompt: 'p2' }];

  it('start frame role: frames mode, image as startFrame, file name kept', () => {
    const rows = rowsFromImages(imgs, prompts, { role: 'start', model: 'flow:veo-fast', engine: 'flow' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ prompt: 'p1', startFrame: 'a1', refs: [], filename: 'cat', enabled: true });
    expect(rows[0].overrides).toEqual({ engine: 'flow', kind: 'video', model: 'flow:veo-fast', videoMode: 'frames' });
    expect(rows[0].id).not.toBe(rows[1].id);
    // the overrides survive the coercion the runner applies
    const eff = effectiveSettings(DEFAULT_SETTINGS, rows[1].overrides);
    expect(eff).toMatchObject({ kind: 'video', model: 'flow:veo-fast', videoMode: 'frames' });
  });

  it('reference role: ingredients mode, image in refs', () => {
    const [r] = rowsFromImages(imgs, prompts, { role: 'ref', model: 'gemini:veo-3.1', engine: 'gemini' });
    expect(r.refs).toEqual(['a1']);
    expect(r.startFrame).toBeUndefined();
    expect(r.overrides.videoMode).toBe('ingredients');
    expect(effectiveSettings(DEFAULT_SETTINGS, r.overrides)).toMatchObject({ engine: 'gemini', model: 'gemini:veo-3.1', videoMode: 'ingredients' });
  });

  it('carries prompt warnings for the preview', () => {
    const rows = rowsFromImages(imgs, [{ prompt: 'x' }, { prompt: '', warnings: ['w'] }], { role: 'start', model: 'flow:veo-fast', engine: 'flow' });
    expect(rows[1].warnings).toEqual(['w']);
    expect('warnings' in rows[0]).toBe(false);
  });
});

describe('fitWithin', () => {
  it('leaves small images alone', () => expect(fitWithin(1920, 1080, 2048)).toBeNull());
  it('scales the long side down, keeping the aspect', () => {
    expect(fitWithin(4000, 3000, 2048)).toEqual({ w: 2048, h: 1536 });
    expect(fitWithin(1000, 8000, 2048)).toEqual({ w: 256, h: 2048 });
  });
});
