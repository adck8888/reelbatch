// Translations keyed by the English UI text. Keys come from scripts/i18n-keys.mjs; missing ones fall back to English.
import es from './es.json';
import hi from './hi.json';
import id from './id.json';
import pt_BR from './pt_BR.json';
import ru from './ru.json';
import tr from './tr.json';
import vi from './vi.json';

export const LOCALES: Record<string, Record<string, string>> = { ru, es, pt_BR, vi, hi, id, tr };
