import { describe, expect, it } from 'vitest';
import { mentionsIn, resolveMentions, unknownMentions } from '../src/shared/characters';
import { GRACE_MS, PRO, licenseStatus, trialDaysLeft } from '../src/shared/license';
import { DEFAULT_SETTINGS, MODELS, effectiveSettings, estimateCost, modelById } from '../src/shared/models';
import { buildPath, renderName, safeSegment, slug } from '../src/shared/template';
import type { Character, LicenseState } from '../src/shared/types';
import { parsePrompts } from '../src/background/helper';

const char = (name: string, description = ''): Character => ({ id: name, name, description, refs: [], createdAt: 0 });

describe('characters', () => {
  const mia = char('Mia', 'red hair, green raincoat');
  const car = char('Red_Car');

  it('adds the description on the first mention only', () => {
    const r = resolveMentions('@Mia waves. Later @mia smiles at @RedCar.', [mia, car]);
    expect(r.prompt).toBe('Mia (red hair, green raincoat) waves. Later Mia smiles at Red_Car.');
    expect(r.used).toEqual([mia, car]);
  });

  it('leaves unknown mentions and emails alone', () => {
    expect(resolveMentions('@Bob and me@x.com', [mia]).prompt).toBe('@Bob and me@x.com');
    expect(unknownMentions('@Bob meets @Mia.', [mia])).toEqual(['Bob']);
    expect(mentionsIn('hi @Mia.')).toEqual(['Mia']);
  });
});

describe('license', () => {
  const now = 1_800_000_000_000;
  const base: LicenseState = { key: '', keyStatus: 'none' } as LicenseState;

  it('is pro while the key was validated within the grace period', () => {
    expect(licenseStatus({ ...base, key: 'k', keyStatus: 'active', lastOkAt: now - 1000 }, now)).toBe('pro');
    expect(licenseStatus({ ...base, key: 'k', keyStatus: 'active', lastOkAt: now - GRACE_MS - 1 }, now)).toBe('free');
  });

  it('runs a 7-day trial', () => {
    const day = 24 * 3600 * 1000;
    expect(licenseStatus({ ...base, trialStartedAt: now - day }, now)).toBe('trial');
    expect(trialDaysLeft({ ...base, trialStartedAt: now - day }, now)).toBe(PRO.trialDays - 1);
    expect(licenseStatus({ ...base, trialStartedAt: now - PRO.trialDays * day }, now)).toBe('free');
  });
});

describe('models', () => {
  it('has unique ids and sane options', () => {
    expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length);
    for (const m of MODELS) {
      expect(m.aspects.length, m.id).toBeGreaterThan(0);
      expect(m.counts.length, m.id).toBeGreaterThan(0);
    }
  });

  it('defaults to a free Flow image model', () => {
    const m = modelById(DEFAULT_SETTINGS.model)!;
    expect(m.engine).toBe('flow');
    expect(m.pro).toBeFalsy();
    expect(estimateCost(DEFAULT_SETTINGS)).toBe(0);
  });

  it('coerces overrides to what the model supports', () => {
    const s = effectiveSettings(DEFAULT_SETTINGS, { kind: 'video', aspect: '4:3', count: 3, duration: 100 });
    const m = modelById(s.model)!;
    expect(m.kind).toBe('video');
    expect(m.aspects).toContain(s.aspect);
    expect(m.counts).toContain(s.count);
    if (m.durations) expect(m.durations).toContain(s.duration);
    expect(effectiveSettings(DEFAULT_SETTINGS, { model: 'nope' }).model).toBe(DEFAULT_SETTINGS.model);
  });
});

describe('file names', () => {
  const ctx = { n: 7, total: 120, prompt: 'Café at night: rain / neon!', model: 'Veo 3.1 Fast', queue: 'Ads', variant: 1, kind: 'video', date: new Date(2026, 9, 2, 9, 5, 3) };

  it('renders tokens', () => {
    expect(renderName('{n}_{prompt30}_{date}', ctx)).toBe('007_cafe_at_night_rain_neon_2026-10-02');
    expect(renderName('{unknown}', ctx)).toBe('{unknown}');
  });

  it('builds safe relative paths and numbers extra variants', () => {
    expect(buildPath('Reelbatch/{queue}', '{n}', 'mp4', ctx)).toBe('Reelbatch/Ads/007.mp4');
    expect(buildPath('', '{n}', 'png', { ...ctx, variant: 2 })).toBe('007_2.png');
    expect(buildPath('../{queue}', 'x', 'png', ctx)).not.toContain('..');
  });

  it('sanitises Windows-hostile names', () => {
    expect(safeSegment('a<b>:c?.')).toBe('a b c');
    expect(safeSegment('CON')).toBe('_CON');
    expect(slug('')).toBe('_');
  });
});

describe('helper output parsing', () => {
  it('reads JSON, fenced JSON and numbered text', () => {
    expect(parsePrompts('{"prompts":["a","b"]}')).toEqual(['a', 'b']);
    expect(parsePrompts('```json\n["a", {"prompt":"b"}]\n```')).toEqual(['a', 'b']);
    expect(parsePrompts('1. first idea\n2) second idea\n- third')).toEqual(['first idea', 'second idea', 'third']);
  });
});
