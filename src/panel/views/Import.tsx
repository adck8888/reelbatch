import { useMemo, useState } from 'preact/hooks';
import type { Row } from '../../shared/types';
import type { HelperMode } from '../../shared/messages';
import {
  type BuildOptions, type Field as MapField, type ImportRow, type SplitMode, type Table,
  guessMapping, kindOfFile, readCsv, readDocx, readJson, readXlsx, rowsFromPrompts, rowsFromTable, sheetsCsvUrl, splitPrompts
} from '../../shared/parse';
import { errText } from '../../shared/util';
import { t } from '../i18n';
import { editQueue, pro, queue } from '../store';
import { Button, Field, Modal, NumberInput, ProBadge, Select, Toggle, call, toast } from '../ui';

type Source = 'paste' | 'file' | 'sheets' | 'helper';

const FIELDS: { value: MapField; label: string }[] = [
  { value: 'ignore', label: '— ignore —' },
  { value: 'prompt', label: 'Prompt' },
  { value: 'negative', label: 'Negative prompt' },
  { value: 'motionPrompt', label: 'Motion prompt (image→video)' },
  { value: 'kind', label: 'Type (image / video)' },
  { value: 'model', label: 'Model id' },
  { value: 'aspect', label: 'Aspect ratio' },
  { value: 'count', label: 'Outputs' },
  { value: 'duration', label: 'Duration' },
  { value: 'resolution', label: 'Resolution' },
  { value: 'seed', label: 'Seed' },
  { value: 'refs', label: 'Reference image URLs' },
  { value: 'startFrame', label: 'Start frame URL' },
  { value: 'endFrame', label: 'End frame URL' },
  { value: 'filename', label: 'File name' },
  { value: 'folder', label: 'Folder' }
];

/** Adds (or swaps in) the rows; returns false when nothing was done, so the dialog stays open. */
function addRows(rows: ImportRow[], replace: boolean): boolean {
  if (!rows.length) return (toast(t('No prompts found'), 'error'), false);
  const existing = queue.value?.rows.length ?? 0;
  if (replace && existing > 0 && !confirm(t('Replace the {n} rows in this queue with the imported ones?', { n: existing }))) return false;
  // import warnings are only for the preview; they are not part of a queue row
  const clean: Row[] = rows.map(({ warnings: _w, ...r }) => r);
  editQueue((q) => {
    q.rows = replace ? clean : [...q.rows, ...clean];
  });
  toast(t('Added {n} prompts', { n: rows.length }), 'ok');
  return true;
}

export function ImportDialog({ onClose, initial = 'paste' }: { onClose: () => void; initial?: Source }) {
  const [src, setSrc] = useState<Source>(initial);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<SplitMode>('auto');
  const [delim, setDelim] = useState('---');
  const [strip, setStrip] = useState(true);
  const [opts, setOpts] = useState<BuildOptions>({ prefix: '', suffix: '', repeat: 1, variations: true });
  const [table, setTable] = useState<Table | null>(null);
  const [map, setMap] = useState<Record<string, MapField>>({});
  const [sheetUrl, setSheetUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const pasted = useMemo(() => (src === 'paste' ? rowsFromPrompts(splitPrompts(text, mode, delim, strip), opts) : []), [src, text, mode, delim, strip, opts]);
  const tableRows = useMemo(() => (table ? rowsFromTable(table.rows, map, opts) : []), [table, map, opts]);

  const loadTable = (tb: Table) => {
    setTable(tb);
    setMap(guessMapping(tb.headers, tb.rows));
  };

  const onFile = async (f: File) => {
    const kind = kindOfFile(f.name);
    if ((kind === 'xlsx' || kind === 'json') && !pro.value) return toast(t('{what} import is a Pro feature', { what: kind.toUpperCase() }), 'error');
    setBusy(true);
    try {
      if (kind === 'text') {
        setText(await f.text());
        setSrc('paste');
      } else if (kind === 'docx') {
        setText(await readDocx(await f.arrayBuffer()));
        setSrc('paste');
      } else if (kind === 'csv') loadTable(await readCsv(await f.text()));
      else if (kind === 'xlsx') loadTable(await readXlsx(await f.arrayBuffer()));
      else loadTable(readJson(await f.text()));
    } catch (e) {
      toast(`${t('Could not read the file')}: ${errText(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const loadSheet = async () => {
    const url = sheetsCsvUrl(sheetUrl);
    if (!url) return toast(t('Paste a Google Sheets link'), 'error');
    const granted = await chrome.permissions.request({ origins: ['https://docs.google.com/*', 'https://*.googleusercontent.com/*'] });
    if (!granted) return toast(t('Reelbatch needs permission to read docs.google.com for this'), 'error');
    setBusy(true);
    try {
      const res = await fetch(url);
      const body = await res.text();
      if (!res.ok || /<html/i.test(body.slice(0, 200))) throw new Error(t('The sheet must be shared as “Anyone with the link can view”'));
      loadTable(await readCsv(body));
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const rows: ImportRow[] = src === 'paste' ? pasted : tableRows;
  const canAdd = rows.length > 0 && src !== 'helper';
  const warned = rows.filter((r) => r.warnings?.length).length;
  /** The first rows, plus any later row that has warnings, so none of them goes unseen. */
  const previewRows = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => i < 8 || r.warnings?.length)
    .slice(0, 40);

  return (
    <Modal
      title={t('Add prompts')}
      onClose={onClose}
      wide
      footer={
        src !== 'helper' && (
          <>
            <span class="muted">{t('{n} rows', { n: rows.length })}</span>
            <span class="grow" />
            <Button disabled={!canAdd} onClick={() => addRows(rows, true) && onClose()}>
              {t('Replace queue')}
            </Button>
            <Button variant="primary" disabled={!canAdd} onClick={() => addRows(rows, false) && onClose()}>
              {t('Add to queue')}
            </Button>
          </>
        )
      }
    >
      <div class="seg">
        {(['paste', 'file', 'sheets', 'helper'] as Source[]).map((s) => (
          <button type="button" key={s} class={src === s ? 'on' : ''} onClick={() => setSrc(s)}>
            {{ paste: t('Paste'), file: t('File'), sheets: 'Google Sheets', helper: t('AI helper') }[s]}
            {(s === 'sheets' || s === 'helper') && !pro.value && <ProBadge />}
          </button>
        ))}
      </div>

      {src === 'paste' && (
        <>
          <textarea
            class="big"
            value={text}
            placeholder={t('One prompt per line, or blocks separated by a blank line. “P1:” / “1.” numbering is removed. {a|b} makes variations.')}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          />
          <div class="row-wrap">
            <Field label={t('Split by')} inline>
              <Select<SplitMode>
                value={mode}
                options={[
                  { value: 'auto', label: t('Auto') },
                  { value: 'lines', label: t('Each line') },
                  { value: 'blocks', label: t('Blank lines') },
                  { value: 'delimiter', label: t('Delimiter') }
                ]}
                onChange={setMode}
              />
            </Field>
            {mode === 'delimiter' && <input type="text" value={delim} style={{ width: '80px' }} onInput={(e) => setDelim((e.target as HTMLInputElement).value)} />}
            <Toggle checked={strip} onChange={setStrip} label={t('Strip numbering')} />
          </div>
        </>
      )}

      {src === 'file' && !table && (
        <div
          class="drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer?.files[0];
            if (f) void onFile(f);
          }}
        >
          <p>{t('Drop a file here or choose one')}</p>
          <p class="muted">TXT, CSV, DOCX · XLSX, JSON (Pro)</p>
          <input type="file" accept=".txt,.md,.csv,.tsv,.xlsx,.xls,.ods,.json,.docx" disabled={busy} onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) void onFile(f);
          }} />
        </div>
      )}

      {src === 'sheets' && !table && (
        <div class="stack">
          <p class="muted">{t('Share the sheet as “Anyone with the link can view”, then paste its link. The first row must be column names.')}</p>
          <div class="row-wrap">
            <input type="url" class="grow" value={sheetUrl} placeholder="https://docs.google.com/spreadsheets/d/…" onInput={(e) => setSheetUrl((e.target as HTMLInputElement).value)} />
            <Button variant="primary" disabled={!pro.value || busy} title={pro.value ? undefined : t('Google Sheets import is a Pro feature')} onClick={loadSheet}>
              {t('Load')}
            </Button>
          </div>
          {!pro.value && <span class="hint">{t('Google Sheets import is a Pro feature')}</span>}
        </div>
      )}

      {(src === 'file' || src === 'sheets') && table && (
        <div class="stack">
          <div class="row-wrap">
            <b>{t('Map columns')}</b>
            <span class="muted">{t('{n} rows in the file', { n: table.rows.length })}</span>
            {warned > 0 && <span class="warn">· {t('{n} rows with warnings', { n: warned })}</span>}
            <span class="grow" />
            <Button small variant="ghost" onClick={() => setTable(null)}>
              {t('Choose another')}
            </Button>
          </div>
          <div class="map-grid">
            {table.headers.map((h) => (
              <div class="map-row" key={h}>
                <span class="map-col" title={table.rows[0]?.[h] ?? ''}>
                  {h}
                  <small class="muted">{(table.rows[0]?.[h] ?? '').slice(0, 60)}</small>
                </span>
                <Select<MapField> value={map[h] ?? 'ignore'} options={FIELDS.map((f) => ({ ...f, label: t(f.label) }))} onChange={(v) => setMap({ ...map, [h]: v })} />
              </div>
            ))}
          </div>
          <p class="muted">{t('Unmapped columns are available as {column} in prompts and file names.')}</p>
        </div>
      )}

      {src === 'helper' && <HelperPane />}

      {src !== 'helper' && (
        <details class="template">
          <summary>{t('Template: prefix, suffix, repeat')}</summary>
          <div class="row-wrap">
            <Field label={t('Prefix')}>
              <input type="text" value={opts.prefix} placeholder={t('e.g. Cinematic 35mm film,')} onInput={(e) => setOpts({ ...opts, prefix: (e.target as HTMLInputElement).value })} />
            </Field>
            <Field label={t('Suffix')}>
              <input type="text" value={opts.suffix} placeholder={t('e.g. soft light, 4k')} onInput={(e) => setOpts({ ...opts, suffix: (e.target as HTMLInputElement).value })} />
            </Field>
            <Field label={t('Repeat each')}>
              <NumberInput value={opts.repeat ?? 1} min={1} max={100} width={70} onChange={(repeat) => setOpts({ ...opts, repeat })} />
            </Field>
            <Toggle checked={opts.variations !== false} onChange={(variations) => setOpts({ ...opts, variations })} label={t('Expand {a|b} variations')} />
          </div>
        </details>
      )}

      {src !== 'helper' && rows.length > 0 && (
        <ol class="preview">
          {previewRows.map(({ r, i }) => (
            <li key={r.id} value={i + 1}>
              <span class="pv-prompt">{r.prompt}</span>
              {r.warnings?.map((w) => (
                <span key={w} class="pv-warn">⚠ {w}</span>
              ))}
            </li>
          ))}
          {rows.length > previewRows.length && <li class="muted">… {t('and {n} more', { n: rows.length - previewRows.length })}</li>}
        </ol>
      )}
    </Modal>
  );
}

// ---------- AI prompt helper ----------

const HELPER_MODES: { value: HelperMode; label: string; hint: string }[] = [
  { value: 'expand', label: 'Idea → prompts', hint: 'Describe an idea; get N distinct prompts' },
  { value: 'script', label: 'Script → scenes', hint: 'Paste a story or script; get one prompt per scene with consistent characters' },
  { value: 'variations', label: 'Variations', hint: 'Paste one prompt; get N variations' },
  { value: 'improve', label: 'Improve', hint: 'Paste prompts; get clearer, more visual versions' },
  { value: 'translate', label: 'Translate to English', hint: 'Paste prompts in any language' }
];

function HelperPane() {
  const [mode, setMode] = useState<HelperMode>('expand');
  const [input, setInput] = useState('');
  const [n, setN] = useState(10);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ text: string; on: boolean }[]>([]);
  const cur = HELPER_MODES.find((m) => m.value === mode)!;

  const go = async () => {
    setBusy(true);
    const r = await call<{ prompts: string[] }>({ type: 'helper', mode, input, n, lang: 'English' });
    setBusy(false);
    if (r) setOut(r.prompts.map((text) => ({ text, on: true })));
  };

  const chosen = out.filter((o) => o.on).map((o) => o.text);
  return (
    <div class="stack">
      <p class="muted">{t('Uses your Gemini API key (the free tier is enough). Nothing is sent anywhere else.')}</p>
      <div class="row-wrap">
        <Select<HelperMode> value={mode} options={HELPER_MODES.map((m) => ({ value: m.value, label: t(m.label) }))} onChange={setMode} />
        {(mode === 'expand' || mode === 'script' || mode === 'variations') && (
          <Field label={t('How many')} inline>
            <NumberInput value={n} min={1} max={100} width={70} onChange={setN} />
          </Field>
        )}
      </div>
      <textarea class="mid" value={input} placeholder={t(cur.hint)} onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)} />
      <div class="row-wrap">
        <Button variant="primary" icon="spark" disabled={busy || !pro.value || !input.trim()} onClick={go}>
          {busy ? t('Writing…') : t('Generate prompts')}
        </Button>
        {!pro.value && <span class="muted">{t('Pro feature')}</span>}
      </div>
      {out.length > 0 && (
        <>
          <ul class="helper-out">
            {out.map((o, i) => (
              <li key={i}>
                <input type="checkbox" checked={o.on} onChange={(e) => setOut(out.map((x, j) => (j === i ? { ...x, on: (e.target as HTMLInputElement).checked } : x)))} />
                <textarea value={o.text} rows={3} onInput={(e) => setOut(out.map((x, j) => (j === i ? { ...x, text: (e.target as HTMLTextAreaElement).value } : x)))} />
              </li>
            ))}
          </ul>
          <div class="row-wrap">
            <span class="grow" />
            <Button variant="primary" disabled={!chosen.length} onClick={() => addRows(rowsFromPrompts(chosen, { variations: false }), false)}>
              {t('Add {n} to queue', { n: chosen.length })}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
