import { describe, expect, it } from 'vitest';
import {
  applyTemplate, expandVariations, fillVars, guessMapping, kindOfFile, normAspect, readCsv, readJson,
  rowsFromTable, sheetsCsvUrl, splitPrompts, stripPrefix
} from '../src/shared/parse';

describe('splitPrompts', () => {
  it('splits single lines and strips chat numbering', () => {
    expect(splitPrompts('1. a cat\nP2: a dog\nPrompt 3 - a fox\n\n')).toEqual(['a cat', 'a dog', 'a fox']);
  });

  it('keeps multi-line blocks together in auto mode', () => {
    expect(splitPrompts('a cat\non a roof\n\na dog\nin rain')).toEqual(['a cat on a roof', 'a dog in rain']);
  });

  it('splits on a delimiter', () => {
    expect(splitPrompts('one\n---\ntwo\nlines', 'delimiter')).toEqual(['one', 'two lines']);
  });

  it('reads JSON arrays and keeps JSON prompts whole', () => {
    expect(splitPrompts('["a", {"prompt":"b"}, {"shot":"wide"}]')).toEqual(['a', 'b', '{"shot":"wide"}']);
    expect(splitPrompts('{"prompts":["x","y"]}')).toEqual(['x', 'y']);
  });

  it('handles CRLF and empty input', () => {
    expect(splitPrompts('a\r\nb')).toEqual(['a', 'b']);
    expect(splitPrompts('  \n ')).toEqual([]);
  });

  it('does not strip numbers that belong to the prompt', () => {
    expect(stripPrefix('3 dogs on a beach')).toBe('3 dogs on a beach');
    expect(stripPrefix('2024 Tokyo street')).toBe('2024 Tokyo street');
  });
});

describe('variations and templates', () => {
  it('expands the cartesian product', () => {
    expect(expandVariations('a {red|blue} car at {dawn|night}')).toEqual([
      'a red car at dawn', 'a red car at night', 'a blue car at dawn', 'a blue car at night'
    ]);
  });

  it('caps runaway expansions', () => {
    expect(expandVariations('{a|b|c|d|e|f|g|h|i|j} {a|b|c|d|e|f|g|h|i|j} {a|b|c|d|e|f|g|h|i|j}', 50)).toHaveLength(50);
    expect(expandVariations('{a|b|c|d|e|f|g|h|i|j} {a|b|c|d|e|f|g|h|i|j} {a|b|c|d|e|f|g|h|i|j}', 50).every((p) => !p.includes('{'))).toBe(true);
  });

  it('leaves unknown variables visible', () => {
    expect(fillVars('{city} at {time}', { city: 'Paris' })).toBe('Paris at {time}');
  });

  it('applies prefix, suffix and repeat', () => {
    expect(applyTemplate('a cat', { prefix: 'cinematic,', suffix: '4k', repeat: 2 })).toEqual(['cinematic, a cat 4k', 'cinematic, a cat 4k']);
    expect(applyTemplate('{a|b}', { variations: false })).toEqual(['{a|b}']);
  });
});

describe('tables', () => {
  it('guesses columns and falls back to the longest text column', () => {
    expect(guessMapping(['Prompt', 'AR', 'Neg'])).toEqual({ Prompt: 'prompt', AR: 'aspect', Neg: 'negative' });
    const table = [{ id: '1', body: 'a long description of a scene' }];
    expect(guessMapping(['id', 'body'], table)).toEqual({ id: 'ignore', body: 'prompt' });
  });

  it('builds rows with overrides and per-row variables', () => {
    const rows = rowsFromTable(
      [
        { prompt: '{city} skyline', city: 'Tokyo', ar: 'portrait', n: '9', refs: 'https://a/1.png, https://a/2.png' },
        { prompt: '', city: 'x', ar: '', n: '', refs: '' }
      ],
      { prompt: 'prompt', city: 'ignore', ar: 'aspect', n: 'count', refs: 'refs' }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt).toBe('Tokyo skyline');
    expect(rows[0].overrides).toEqual({ aspect: '9:16', count: 4 });
    expect(rows[0].refs).toEqual(['https://a/1.png', 'https://a/2.png']);
  });

  it('normalises aspect ratios', () => {
    expect(normAspect('16x9')).toBe('16:9');
    expect(normAspect('9 / 16')).toBe('9:16');
    expect(normAspect('Square')).toBe('1:1');
  });

  it('reads CSV with a BOM and header-less single columns', async () => {
    expect((await readCsv('﻿prompt,ar\n"a, b",16:9\n')).rows).toEqual([{ prompt: 'a, b', ar: '16:9' }]);
    expect((await readCsv('a red car\na blue car\n')).rows).toEqual([{ prompt: 'a red car' }, { prompt: 'a blue car' }]);
  });

  it('reads JSON tables', () => {
    expect(readJson('["a","b"]').rows).toEqual([{ prompt: 'a' }, { prompt: 'b' }]);
    expect(readJson('[{"prompt":"a","refs":["x","y"]}]').rows).toEqual([{ prompt: 'a', refs: 'x,y' }]);
  });

  it('turns Sheets links into CSV export URLs', () => {
    expect(sheetsCsvUrl('https://docs.google.com/spreadsheets/d/AbC-1_2/edit#gid=42')).toBe(
      'https://docs.google.com/spreadsheets/d/AbC-1_2/export?format=csv&gid=42'
    );
    expect(sheetsCsvUrl('https://example.com')).toBeNull();
  });

  it('detects file kinds', () => {
    expect(['a.CSV', 'b.xlsx', 'c.json', 'd.docx', 'e.txt'].map(kindOfFile)).toEqual(['csv', 'xlsx', 'json', 'docx', 'text']);
  });
});

describe('import fixes', () => {
  it('strips bullets and #N numbering but keeps content that looks similar', () => {
    expect(['- a cat', '• a dog', '* a fox', '– an owl', '#8 a bee', '#8. a bat', '#8: a cow', '- 2. a pig'].map(stripPrefix)).toEqual([
      'a cat', 'a dog', 'a fox', 'an owl', 'a bee', 'a bat', 'a cow', 'a pig'
    ]);
    expect(stripPrefix('-10 degrees outside')).toBe('-10 degrees outside');
    expect(stripPrefix('#sunset over the bay')).toBe('#sunset over the bay');
    expect(stripPrefix('*dramatic* light')).toBe('*dramatic* light');
    expect(splitPrompts('- a cat\n- a dog')).toEqual(['a cat', 'a dog']);
  });

  it('dedupes nested variations and tidies empty options', () => {
    expect(expandVariations('{a|{b|c}}')).toEqual(['a', 'b', 'c']);
    expect(expandVariations('{x|x} {y|y}')).toEqual(['x y']);
    expect(expandVariations('a {|big} cat')).toEqual(['a cat', 'a big cat']);
    expect(expandVariations('cat {|fluffy}, 4k')).toEqual(['cat, 4k', 'cat fluffy, 4k']);
    expect(expandVariations('plain  prompt')).toEqual(['plain  prompt']);
  });

  it('joins a punctuation-led suffix without a stray space', () => {
    expect(applyTemplate('dawn', { suffix: ', SUF' })).toEqual(['dawn, SUF']);
    expect(applyTemplate(' dawn ', { prefix: ' wide shot: ', suffix: ' 4k ' })).toEqual(['wide shot: dawn 4k']);
    expect(applyTemplate('at {dawn|night}', { suffix: '. soft light' })).toEqual(['at dawn. soft light', 'at night. soft light']);
  });

  it('maps the model column by id, label or target and sets engine and kind', () => {
    const map = { prompt: 'prompt', model: 'model' } as const;
    const rows = rowsFromTable(
      [
        { prompt: 'a', model: 'gemini:veo-3.1' },
        { prompt: 'b', model: 'veo 3.1 quality' },
        { prompt: 'c', model: 'black-forest-labs/flux-2-pro' },
        { prompt: 'd', model: 'Sora 9' }
      ],
      map
    );
    expect(rows.map((r) => r.overrides)).toEqual([
      { model: 'gemini:veo-3.1', engine: 'gemini', kind: 'video' },
      { model: 'flow:veo-quality', engine: 'flow', kind: 'video' },
      { model: 'replicate:flux-2-pro', engine: 'replicate', kind: 'image' },
      {}
    ]);
    expect(rows.slice(0, 3).every((r) => !r.warnings)).toBe(true);
    expect(rows[3].warnings).toEqual(['Unknown model "Sora 9" — the queue default is used']);
  });

  it('warns about unsupported aspects instead of coercing them', () => {
    const rows = rowsFromTable(
      [
        { prompt: 'a', ar: '7:3' },
        { prompt: 'b', ar: 'portrait' },
        { prompt: 'c', ar: '4:3', model: 'flow:veo-fast' }
      ],
      { prompt: 'prompt', ar: 'aspect', model: 'model' }
    );
    expect(rows[0].overrides).toEqual({});
    expect(rows[0].warnings).toEqual(['Unsupported aspect "7:3" — the queue default is used']);
    expect(rows[1].overrides).toEqual({ aspect: '9:16' });
    expect(rows[1].warnings).toBeUndefined();
    expect(rows[2].overrides.aspect).toBe('4:3');
    expect(rows[2].warnings).toEqual(['Veo 3.1 Fast has no 4:3 aspect — 16:9 is used']);
  });
});
