import { computed } from '@preact/signals';
import { settings } from './store';
import { LOCALES } from './locales';

/** UI languages. Strings are keyed by their English text; missing translations fall back to English. */
export const LANGS: { id: string; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'en', label: 'English' },
  { id: 'ru', label: 'Русский' },
  { id: 'es', label: 'Español' },
  { id: 'pt_BR', label: 'Português (Brasil)' },
  { id: 'vi', label: 'Tiếng Việt' },
  { id: 'hi', label: 'हिन्दी' },
  { id: 'id', label: 'Bahasa Indonesia' },
  { id: 'tr', label: 'Türkçe' }
];

function detect(): string {
  const ui = (chrome.i18n?.getUILanguage?.() ?? navigator.language ?? 'en').replace('-', '_');
  if (ui.startsWith('pt')) return 'pt_BR';
  const base = ui.split('_')[0];
  return LOCALES[base] ? base : 'en';
}

export const lang = computed(() => (settings.value.lang === 'auto' ? detect() : settings.value.lang));

/** Translate; `{name}` placeholders are filled from `vars`. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const dict = LOCALES[lang.value];
  let out = dict?.[text] ?? text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}
