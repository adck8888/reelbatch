import type { Row, VideoMode } from './types';
import { expandVariations, fillVars, newRow } from './parse';

/** "Animate photos in bulk": one video row per source image. Pure helpers (no DOM), unit-tested. */

export const IMAGE_IMPORT_MAX = 200;
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** How each image is used: the video's first frame, or a reference ("ingredient"). */
export type ImageRole = 'start' | 'ref';
/** One prompt for every image, or one prompt per line matched to the images in order. */
export type ImagePromptMode = 'same' | 'lines';

/** "Beach Day.final.JPG" -> "Beach Day.final"; braces are dropped so the name is never read as a {template}. */
export function fileStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const stem = base.replace(/\.[^.]+$/, '') || base;
  return stem.replace(/[{}|]/g, '').trim() || 'image';
}

export interface ImagePrompt {
  prompt: string;
  warnings?: string[];
}

/**
 * The prompt each image gets.
 * same: the text is a template; {filename} becomes the image name, and {a|b} variations
 * are dealt out in turn (image 1 gets the first variant, image 2 the second, …).
 * lines: line i (blank lines ignored) goes to image i; images past the last line get no prompt.
 */
export function promptsForImages(names: string[], text: string, mode: ImagePromptMode, variations = true): ImagePrompt[] {
  if (mode === 'lines') {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return names.map((name, i) => {
      const line = lines[i];
      if (line === undefined) return { prompt: '', warnings: ['No prompt line for this image (it will be skipped)'] };
      return { prompt: fillVars(line, { filename: fileStem(name) }) };
    });
  }
  const tpl = text.trim();
  const variants = variations ? expandVariations(tpl) : [tpl];
  return names.map((name, i) => ({ prompt: fillVars(variants[i % variants.length], { filename: fileStem(name) }) }));
}

export interface ImageRowOptions {
  role: ImageRole;
  /** Video model id for every row. */
  model: string;
  engine: Row['overrides']['engine'];
}

/** One queue row per image: a video row with the image as its start frame or its reference. */
export function rowsFromImages(images: { asset: string; name: string }[], prompts: ImagePrompt[], o: ImageRowOptions): (Row & { warnings?: string[] })[] {
  const videoMode: VideoMode = o.role === 'start' ? 'frames' : 'ingredients';
  return images.map((img, i) => {
    const p = prompts[i] ?? { prompt: '' };
    const row = newRow({
      prompt: p.prompt,
      overrides: { engine: o.engine, kind: 'video', model: o.model, videoMode },
      refs: o.role === 'ref' ? [img.asset] : [],
      ...(o.role === 'start' ? { startFrame: img.asset } : {}),
      filename: fileStem(img.name)
    });
    return p.warnings?.length ? { ...row, warnings: p.warnings } : row;
  });
}

/** Size to downscale a w×h image to so its long side is at most `max` (null when it already fits). */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number } | null {
  const long = Math.max(w, h);
  if (long <= max) return null;
  const k = max / long;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
