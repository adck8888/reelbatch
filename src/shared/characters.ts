import type { Character } from './types';

// "@" must open a word (start, whitespace or opening punctuation), so "a@b.com" is not a mention
const MENTION = /(?<=^|[\s([{"'“‘«])@([\p{L}\p{N}_][\p{L}\p{N}_.-]*)/gu;

const key = (s: string) => s.toLowerCase().replace(/[\s_.-]+/g, '');
// allow "@Anna." at the end of a sentence
const trimName = (s: string) => s.replace(/[.-]+$/, '');

/**
 * Expand @Name mentions. The first mention of a character carries its description so the model
 * keeps the look consistent; later mentions are just the name. Returns the characters used, whose
 * reference images the runner attaches.
 */
export function resolveMentions(prompt: string, chars: Character[]): { prompt: string; used: Character[] } {
  const byKey = new Map(chars.map((c) => [key(c.name), c]));
  const used: Character[] = [];
  const out = prompt.replace(MENTION, (all, name: string) => {
    const trimmed = trimName(name);
    const c = byKey.get(key(trimmed));
    if (!c) return all;
    const first = !used.includes(c);
    if (first) used.push(c);
    const tail = name.slice(trimmed.length);
    const desc = c.description.trim();
    return (first && desc ? `${c.name} (${desc})` : c.name) + tail;
  });
  return { prompt: out, used };
}

export function mentionsIn(prompt: string): string[] {
  return [...prompt.matchAll(MENTION)].map((m) => trimName(m[1]));
}

export function unknownMentions(prompt: string, chars: Character[]): string[] {
  const known = new Set(chars.map((c) => key(c.name)));
  return mentionsIn(prompt).filter((m) => !known.has(key(m)));
}
