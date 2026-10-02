import type { HelperMode } from '../shared/messages';
import { geminiText } from '../engines/api/gemini';
import { get } from '../shared/storage';

const BASE = `You write prompts for AI image and video generators (Google Veo, Nano Banana, Kling, Seedance).
A good prompt is one paragraph, concrete and visual: subject, action, setting, camera (shot size, lens, movement),
lighting, style, mood, and for video what happens over time and any sound. No lists, no markdown, no numbering.
Answer with JSON only: {"prompts": ["...", "..."]}.`;

const TASKS: Record<HelperMode, (n: number, lang: string) => string> = {
  expand: (n) => `Turn the user's idea into ${n} distinct, production-ready prompts that explore different angles of it.`,
  script: (n) =>
    `The user gives a story, script or topic. Split it into ${n} consecutive scenes and write one prompt per scene.
Keep characters, wardrobe, locations and style consistent: describe each recurring character the same way every time.
Scenes must follow in order so the clips can be edited together.`,
  variations: (n) => `Write ${n} variations of the user's prompt. Keep the subject, change composition, camera, lighting or style.`,
  translate: (_n, lang) =>
    `The user gives one or more prompts (one per line or separated by blank lines). Translate each into ${lang}, keeping every visual detail.
Return them in the same order, one array item per prompt.`,
  improve: () =>
    `The user gives one or more prompts (one per line or separated by blank lines). Rewrite each to be clearer and more specific
for the generator without changing what it depicts. Return them in the same order, one array item per prompt.`
};

export async function runHelper(mode: HelperMode, input: string, n: number, lang = 'English'): Promise<string[]> {
  const key = (await get('settings')).keys.gemini;
  if (!key) throw new Error('The prompt helper uses your Gemini API key (free tier works). Add it in Settings → API keys.');
  if (!input.trim()) throw new Error('Type an idea, a script or prompts first');
  const count = Math.max(1, Math.min(n || 5, 100));
  const system = `${BASE}\n\n${TASKS[mode](count, lang)}`;
  const text = await geminiText(key, system, input.slice(0, 30_000), true);
  return parsePrompts(text);
}

export function parsePrompts(text: string): string[] {
  const clean = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    const j = JSON.parse(clean);
    const arr = Array.isArray(j) ? j : Array.isArray(j?.prompts) ? j.prompts : [];
    const out = arr.map((x: unknown) => (typeof x === 'string' ? x : (x as { prompt?: string })?.prompt ?? '')).map((s: string) => s.trim()).filter(Boolean);
    if (out.length) return out;
  } catch {
    /* fall through to plain text */
  }
  return clean
    .split(/\n\s*\n|\n(?=\s*(?:\d+[.)]|[-*•])\s)/)
    .map((s) => s.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
    .filter(Boolean);
}
