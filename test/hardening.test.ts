import { describe, expect, it } from 'vitest';
import { BUNDLED_CONFIG, validConfig, versionAtLeast } from '../src/engines/flow/config';
import { renderName, safeSegment } from '../src/shared/template';
import { expandVariations } from '../src/shared/parse';

describe('safeSegment', () => {
  it('drops trailing dots and spaces left by the length cut', () => {
    const s = safeSegment('a'.repeat(79) + '. tail', 80);
    expect(s.endsWith('.')).toBe(false);
    expect(s.endsWith(' ')).toBe(false);
  });
  it('escapes reserved device names, also with an extension', () => {
    expect(safeSegment('con')).toBe('_con');
    expect(safeSegment('LPT1.png')).toBe('_LPT1.png');
    expect(safeSegment('console')).toBe('console');
  });
  it('never returns an empty segment', () => {
    expect(safeSegment('...')).toBe('_');
  });
});

describe('name template', () => {
  it('has a {run} token from the run start', () => {
    const name = renderName('{run}', { n: 1, total: 1, prompt: 'p', model: 'm', queue: 'q', variant: 1, kind: 'image', date: new Date(2026, 9, 2, 21, 5, 9) });
    expect(name).toBe('2026-10-02_21-05');
  });
});

describe('remote config', () => {
  it('accepts the bundled config', () => {
    expect(validConfig(BUNDLED_CONFIG)).toBe(true);
  });
  it('rejects broken regexps and odd versions', () => {
    expect(validConfig({ ...BUNDLED_CONFIG, mediaUrl: '([' })).toBe(false);
    expect(validConfig({ ...BUNDLED_CONFIG, version: 'latest' })).toBe(false);
    expect(validConfig({ ...BUNDLED_CONFIG, text: { ...BUNDLED_CONFIG.text, cost: 5 } })).toBe(false);
  });
  it('compares versions numerically', () => {
    expect(versionAtLeast('1.10.0', '1.9.0')).toBe(true);
    expect(versionAtLeast('1.9.0', '1.10.0')).toBe(false);
    expect(versionAtLeast('2026.10.02-1', '2026.10.02-2')).toBe(false);
    expect(versionAtLeast('2026.10.03', '2026.10.02-2')).toBe(true);
  });
});

describe('variations', () => {
  it('stops at the cap with every prompt fully expanded', () => {
    const out = expandVariations('{a|b|c} {d|e|f} {g|h|i}', 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.every((p) => !p.includes('{'))).toBe(true);
  });
});
