import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { GenSettings, Row, RowRun, RunScope } from '../../shared/types';
import { type Estimate } from '../../shared/messages';
import { effectiveSettings, modelById } from '../../shared/models';
import { type BuildOptions, type SplitMode, newRow, rowsFromPrompts, splitPrompts } from '../../shared/parse';
import { deleteQueue, newQueue } from '../../shared/storage';
import { unknownMentions } from '../../shared/characters';
import { formatDuration } from '../../shared/util';
import { PRO } from '../../shared/license';
import { te } from '../errors';
import { t } from '../i18n';
import { characters, createQueue, editQueue, flowStatus, flushQueue, license, openFlow, pro, queue, queueIndex, run, running, selected, sheet, showPlans, showSettings, switchQueue, tab, usedToday } from '../store';
import { Button, Chip, Disclosure, Field, Icon, Menu, Modal, NumberInput, ProBadge, Select, Thumb, Toggle, attempt, call, imagesFromDrop, pickImages, toast, type MenuItem } from '../ui';
import { GenEditor, costLabel, diffSettings } from './GenEditor';
import { ImportDialog, type Source } from './Import';

/** Built on each call so the labels follow the UI language. */
const statusLabel = (s: RowRun['status']): string =>
  ({
    queued: t('Queued'),
    waiting: t('Waiting'),
    sending: t('Sending'),
    rendering: t('Rendering'),
    downloading: t('Saving'),
    done: t('Done'),
    failed: t('Failed'),
    skipped: t('Skipped')
  })[s];

const BUSY: RowRun['status'][] = ['waiting', 'sending', 'rendering', 'downloading'];

export function QueueView() {
  const q = queue.value;
  const [importing, setImporting] = useState<Source | null>(null);
  const [editing, setEditing] = useState<{ row: Row; isNew?: boolean } | null>(null);
  const [editDefaults, setEditDefaults] = useState(false);
  /** The inline "Add prompts" box is always there for an empty queue; with rows it is opened on demand. */
  const [adding, setAdding] = useState(false);
  const [selecting, setSelecting] = useState(false);
  if (!q) return null;
  const sel = selected.value;
  const r = run.value;
  const thisRun = r.queueId === q.id ? r.rows : {};
  const empty = q.rows.length === 0;
  const showAdd = empty || adding;

  const toggleSel = (id: string, on: boolean) => {
    const s = new Set(sel);
    if (on) s.add(id);
    else s.delete(id);
    selected.value = s;
  };
  const stopSelecting = () => {
    setSelecting(false);
    selected.value = new Set();
  };

  const move = (i: number, d: number) =>
    editQueue((x) => {
      const j = i + d;
      if (j < 0 || j >= x.rows.length) return;
      [x.rows[i], x.rows[j]] = [x.rows[j], x.rows[i]];
    });

  const importMenu: MenuItem[] = [
    { label: t('File (TXT, CSV, DOCX, XLSX, JSON)'), icon: 'file', run: () => setImporting('file') },
    { label: 'Google Sheets', icon: 'sheet', run: () => setImporting('sheets') },
    { label: t('Images (animate photos)'), icon: 'image', run: () => setImporting('images') },
    { label: t('AI helper'), icon: 'spark', run: () => setImporting('helper') },
    { label: t('Characters'), icon: 'at', run: () => (sheet.value = 'characters'), sep: true }
  ];

  return (
    <div class="queue-view">
      <GettingStarted />

      <div class="list-head">
        <span class="queue-name" title={q.name}>
          {q.name}
        </span>
        <span class="muted">{selecting ? t('{n} selected', { n: sel.size }) : empty ? t('Empty') : t('{n} prompts', { n: q.rows.length })}</span>
        <span class="grow" />
        {!empty && !selecting && (
          <Button small variant="ghost" onClick={() => setSelecting(true)} title={t('Tick rows to run, switch off or delete only some of them')}>
            {t('Select')}
          </Button>
        )}
        {selecting && (
          <>
            <Button small variant="ghost" onClick={() => (selected.value = sel.size === q.rows.length ? new Set() : new Set(q.rows.map((x) => x.id)))}>
              {sel.size === q.rows.length ? t('None') : t('All')}
            </Button>
            <Button small variant="ghost" disabled={!sel.size} onClick={() => editQueue((x) => x.rows.forEach((row) => sel.has(row.id) && (row.enabled = !row.enabled)))}>
              {t('On/off')}
            </Button>
            <Button small variant="ghost" icon="trash" disabled={!sel.size} title={t('Delete')} onClick={() => {
              editQueue((x) => void (x.rows = x.rows.filter((row) => !sel.has(row.id))));
              selected.value = new Set();
            }} />
            <Button small onClick={stopSelecting}>{t('Done')}</Button>
          </>
        )}
        <QueueMenu hasDone={Object.values(thisRun).some((x) => x.status === 'done')} />
      </div>

      {showAdd && (
        <AddPrompts
          onDone={() => setAdding(false)}
          canClose={!empty}
          importMenu={importMenu}
        />
      )}
      {!showAdd && (
        <div class="row-wrap add-bar">
          <Button small icon="plus" class="add-prompts" onClick={() => setAdding(true)}>
            {t('Add prompts')}
          </Button>
          <Menu items={importMenu} label={t('Import')} icon="upload" variant="default" align="left" class="import-menu" />
        </div>
      )}

      <DefaultsCard onEdit={() => setEditDefaults(true)} />

      {!empty && (
        <ol class="rows">
          {q.rows.map((row, i) => (
            <RowItem
              key={row.id}
              row={row}
              n={i + 1}
              rr={thisRun[row.id]}
              defaults={q.defaults}
              selecting={selecting}
              checked={sel.has(row.id)}
              onCheck={(on) => toggleSel(row.id, on)}
              onEdit={() => setEditing({ row })}
              onMove={(d) => move(i, d)}
              onDuplicate={() => editQueue((x) => x.rows.splice(i + 1, 0, { ...structuredClone(row), id: crypto.randomUUID() }))}
              onKind={(kind) =>
                editQueue((x) => {
                  const it = x.rows[i];
                  // '' lets effectiveSettings pick the first model of the new kind
                  const model = kind === 'video' && x.defaults.motionModel ? x.defaults.motionModel : '';
                  it.overrides = diffSettings(x.defaults, effectiveSettings(x.defaults, { ...it.overrides, kind, model }));
                })
              }
              onDelete={() => editQueue((x) => void x.rows.splice(i, 1))}
              onToggle={() => editQueue((x) => void (x.rows[i].enabled = !x.rows[i].enabled))}
              onPrompt={(p) => editQueue((x) => void (x.rows[i].prompt = p))}
            />
          ))}
        </ol>
      )}

      <RunBar selecting={selecting} />
      {importing && <ImportDialog initial={importing} onClose={() => setImporting(null)} />}
      {editDefaults && (
        <Modal title={t('Default for all rows')} onClose={() => setEditDefaults(false)} sheet wide footer={<><span class="grow" /><Button variant="primary" onClick={() => setEditDefaults(false)}>{t('Done')}</Button></>}>
          <p class="hint">{t('Model, aspect and other settings every row uses unless it has its own')}</p>
          <GenEditor value={q.defaults} onChange={(d) => editQueue((x) => void (x.defaults = d))} />
        </Modal>
      )}
      {editing && (
        <RowEditor
          row={editing.row}
          onClose={(saved) => {
            // a row added with "Add a row" and cancelled before it got a prompt is dropped again
            if (!saved && editing.isNew) {
              editQueue((x) => void (x.rows = x.rows.filter((r) => r.id !== editing.row.id || r.prompt.trim())));
            }
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** The queue's "⋯": switch between queues, rename, new, delete, export, remove finished rows. */
function QueueMenu({ hasDone }: { hasDone: boolean }) {
  const q = queue.value!;
  const r = run.value;
  const idx = queueIndex.value;
  const items: MenuItem[] = [
    ...(idx.length > 1 ? idx.map((x) => ({ label: x.name, checked: x.id === q.id, run: () => void switchQueue(x.id) })) : []),
    {
      label: t('New queue'),
      icon: 'plus',
      sep: idx.length > 1,
      run: async () => {
        const name = prompt(t('Name of the new queue'), `${t('Queue')} ${idx.length + 1}`);
        if (name) await createQueue({ ...newQueue(name.trim() || t('Queue')), defaults: { ...q.defaults } });
      }
    },
    {
      label: t('Rename queue'),
      icon: 'edit',
      run: () => {
        const name = prompt(t('Rename queue'), q.name);
        if (name?.trim()) editQueue((x) => void (x.name = name.trim()));
      }
    },
    { label: t('Export run.csv'), icon: 'download', disabled: !q.rows.length, run: () => call({ type: 'export:sidecar', queueId: q.id }, t('run.csv saved to Downloads')) },
    ...(hasDone ? [{ label: t('Remove done'), icon: 'check', run: () => editQueue((x) => void (x.rows = x.rows.filter((row) => r.rows[row.id]?.status !== 'done'))) }] : []),
    {
      label: t('Delete queue'),
      icon: 'trash',
      danger: true,
      sep: true,
      disabled: running.value && r.queueId === q.id,
      run: async () => {
        if (!confirm(t('Delete the queue “{name}” and its {n} rows?', { name: q.name, n: q.rows.length }))) return;
        await deleteQueue(q.id);
        const next = queueIndex.value.find((x) => x.id !== q.id);
        if (next) await switchQueue(next.id);
        else await createQueue(newQueue(`${t('Queue')} 1`));
      }
    }
  ];
  return <Menu items={items} title={t('Queue options')} />;
}

// ---------- inline "Add prompts" ----------

/** Text typed into the add box but not added yet; the run bar warns about it. */
const draft = signal('');

function AddPrompts({ onDone, canClose, importMenu }: { onDone: () => void; canClose: boolean; importMenu: MenuItem[] }) {
  const text = draft.value;
  const setText = (v: string) => (draft.value = v);
  const [mode, setMode] = useState<SplitMode>('auto');
  const [delim, setDelim] = useState('---');
  const [strip, setStrip] = useState(true);
  const [opts, setOpts] = useState<BuildOptions>({ prefix: '', suffix: '', repeat: 1, variations: true });
  const rows = useMemo(() => rowsFromPrompts(splitPrompts(text, mode, delim, strip), opts), [text, mode, delim, strip, opts]);
  const add = () => {
    if (!rows.length) return;
    editQueue((q) => void (q.rows = [...q.rows, ...rows]));
    toast(t('Added {n} prompts', { n: rows.length }), 'ok');
    setText('');
    onDone();
  };
  return (
    <section class="card add-card">
      <textarea
        class="big"
        value={text}
        placeholder={t('One prompt per line, or blocks separated by a blank line. “P1:” / “1.” numbering is removed. {a|b} makes variations.')}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && add()}
      />
      <div class="row-wrap">
        <Button variant="primary" icon="plus" class="add-prompts" disabled={!rows.length} onClick={add}>
          {rows.length ? t('Add {n} prompts', { n: rows.length }) : t('Add')}
        </Button>
        <Menu items={importMenu} label={t('Import')} icon="upload" variant="default" align="left" class="import-menu" />
        <span class="grow" />
        {canClose && <Button small variant="ghost" icon="x" aria-label={t('Close')} onClick={onDone} />}
      </div>
      <Disclosure title={t('Options')}>
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
        </div>
        <Toggle checked={opts.variations !== false} onChange={(variations) => setOpts({ ...opts, variations })} label={t('Expand {a|b} variations')} />
      </Disclosure>
    </section>
  );
}

// ---------- defaults ----------

function DefaultsCard({ onEdit }: { onEdit: () => void }) {
  const d = queue.value!.defaults;
  const m = modelById(d.model);
  return (
    <section class="defaults">
      <span class="eyebrow">{t('Default for all rows')}</span>
      <div class="defaults-chips">
        <Chip icon={d.kind === 'video' ? 'video' : 'image'}>{m?.label ?? d.model}</Chip>
        <Chip>{d.aspect}</Chip>
        {d.count > 1 && <Chip>×{d.count}</Chip>}
        {d.duration && d.kind === 'video' && <Chip>{d.duration}s</Chip>}
        <Chip>{costLabel(d)}</Chip>
        {m?.pro && !pro.value && <ProBadge />}
      </div>
      <button type="button" class="link accent" onClick={onEdit}>
        {t('Edit')}
      </button>
    </section>
  );
}

// ---------- getting started ----------

const GS_KEY = 'reelbatch.gettingStarted';
const readGs = (): string | null => {
  try {
    return localStorage.getItem(GS_KEY);
  } catch {
    return null;
  }
};
const writeGs = (v: string) => {
  try {
    localStorage.setItem(GS_KEY, v);
  } catch {
    /* storage blocked: the checklist simply shows again next time */
  }
};

/**
 * First-run checklist: Flow project open → prompts added → Run pressed. Hidden for good once all
 * three are done or the user dismisses it. The Flow step mirrors the status pill in the header.
 */
function GettingStarted() {
  const [state, setState] = useState(readGs);
  const q = queue.value;
  const r = run.value;
  const f = flowStatus.value;
  const hasRows = !!q && q.rows.length > 0;
  const ran = !!r.runId || r.status !== 'idle' || usedToday.value > 0;
  const flowOk = f?.state === 'project' || ran;
  const hidden = state === 'done' || state === 'dismissed';

  const allDone = flowOk && hasRows && ran;
  useEffect(() => {
    if (allDone && !hidden) {
      writeGs('done');
      // leave the finished list up for a moment so the last tick is seen
      const id = setTimeout(() => setState('done'), 2500);
      return () => clearTimeout(id);
    }
  }, [allDone, hidden]);

  if (hidden) return null;
  const dismiss = () => {
    writeGs('dismissed');
    setState('dismissed');
  };
  const steps: { done: boolean; title: string; action?: preact.ComponentChildren }[] = [
    {
      done: flowOk,
      title: flowOk ? t('Flow project open') : f?.state === 'tab' ? t('Open a project in the Flow tab') : t('Open a Flow project'),
      action: !flowOk && (
        <Button small icon="external" onClick={() => void openFlow()}>
          {f?.state === 'tab' ? t('Show Flow') : t('Open Flow')}
        </Button>
      )
    },
    { done: hasRows, title: hasRows ? t('{n} prompts', { n: q?.rows.length ?? 0 }) : t('Paste prompts') },
    { done: ran, title: ran ? t('Your first run has started') : t('Press Run') }
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <section class="getting-started" aria-label={t('Getting started')}>
      <header>
        <b>{t('Getting started')}</b>
        <span class="muted">{t('{n} of {max}', { n: doneCount, max: steps.length })}</span>
        <span class="grow" />
        <Button small variant="ghost" icon="x" title={t('Hide this checklist')} aria-label={t('Hide this checklist')} onClick={dismiss} />
      </header>
      <ol>
        {steps.map((s, i) => (
          <li key={i} class={s.done ? 'done' : ''}>
            <span class="gs-mark">{s.done ? <Icon name="check" size={12} /> : i + 1}</span>
            <span class="gs-title">{s.title}</span>
            {s.action || null}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------- rows ----------

function RowItem(p: {
  row: Row;
  n: number;
  rr?: RowRun;
  defaults: GenSettings;
  selecting: boolean;
  checked: boolean;
  onCheck: (on: boolean) => void;
  onEdit: () => void;
  onMove: (d: number) => void;
  onDuplicate: () => void;
  onKind: (kind: 'image' | 'video') => void;
  onDelete: () => void;
  onToggle: () => void;
  onPrompt: (s: string) => void;
}) {
  const { row, rr } = p;
  const eff = effectiveSettings(p.defaults, row.overrides);
  const overridden = Object.keys(row.overrides).length > 0;
  const unknown = unknownMentions(row.prompt, characters.value);
  const status = rr?.status;
  const [open, setOpen] = useState(!row.prompt);
  const [errOpen, setErrOpen] = useState(false);
  const busy = !!status && BUSY.includes(status);
  const results = rr?.results ?? [];
  return (
    <li class={`row ${row.enabled ? '' : 'off'} ${status ?? ''} ${open ? 'open' : ''}`}>
      {p.selecting && <input type="checkbox" checked={p.checked} onChange={(e) => p.onCheck((e.target as HTMLInputElement).checked)} aria-label={t('Select row {n}', { n: p.n })} />}
      <span class="n">{p.n}</span>
      <div class="row-main">
        {open ? (
          <textarea
            class="prompt"
            rows={2}
            value={row.prompt}
            placeholder={t('Prompt…')}
            autoFocus
            onInput={(e) => p.onPrompt((e.target as HTMLTextAreaElement).value)}
            onBlur={() => row.prompt.trim() && setOpen(false)}
          />
        ) : (
          <button type="button" class="prompt-line" title={t('Click to edit')} onClick={() => setOpen(true)}>
            {row.prompt || <span class="muted">{t('Prompt…')}</span>}
          </button>
        )}
        <div class="row-meta">
          {overridden && (
            <Chip icon={eff.kind === 'video' ? 'video' : 'image'} title={t('This row has its own settings')}>
              {modelById(eff.model)?.label} · {eff.aspect}
            </Chip>
          )}
          {row.refs.length > 0 && <Chip icon="image" title={t('Reference images')}>{row.refs.length}</Chip>}
          {(row.startFrame || row.endFrame) && <Chip>{t('frames')}</Chip>}
          {row.chain && <Chip icon="link" title={t('Continues from the previous row')}>{t('chain')}</Chip>}
          {row.motionPrompt && <Chip icon="video" title={row.motionPrompt}>{t('animate')}</Chip>}
          {unknown.length > 0 && (
            <Chip tone="warn" title={t('Add these characters in Import → Characters')} onClick={() => (sheet.value = 'characters')}>
              @{unknown.join(', @')}?
            </Chip>
          )}
          {!row.enabled && <Chip>{t('Off')}</Chip>}
          {results.map((res, i) => (
            <a key={i} class="result-thumb" href={res.url || undefined} target="_blank" rel="noreferrer" title={res.file ?? res.url}>
              <Thumb id={res.thumbId ?? res.assetId ?? res.url} size={28} icon={res.kind === 'video' ? 'video' : 'image'} />
            </a>
          ))}
          {rr?.error && (
            <span
              class={`err ${status === 'done' || rr.retrying ? 'soft' : ''} ${errOpen ? 'open' : ''}`}
              title={errOpen ? t('Click to collapse') : te(rr.error)}
              role="button"
              tabIndex={0}
              aria-expanded={errOpen}
              onClick={() => setErrOpen(!errOpen)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setErrOpen(!errOpen))}
            >
              {rr.retrying ? t('Retrying: {error}', { error: te(rr.error) }) : te(rr.error)}
            </span>
          )}
        </div>
      </div>
      <div class="row-side">
        {status && (
          <span class={`status ${status} ${rr?.retrying ? 'retrying' : ''}`} title={statusLabel(status)}>
            <span class="status-dot" />
            <span class="status-text">{rr?.retrying ? t('Retrying') : busy && rr?.startedAt ? <Elapsed since={rr.startedAt} /> : statusLabel(status)}</span>
          </span>
        )}
        <Menu
          items={[
            { label: t('Edit'), icon: 'edit', run: p.onEdit },
            { label: row.enabled ? t('Disable') : t('Enable'), icon: 'toggle', run: p.onToggle },
            { label: t('Move up'), icon: 'up', run: () => p.onMove(-1) },
            { label: t('Move down'), icon: 'down', run: () => p.onMove(1) },
            eff.kind === 'video' ? { label: t('Make it an image'), icon: 'image', run: () => p.onKind('image') } : { label: t('Make it a video'), icon: 'video', run: () => p.onKind('video') },
            { label: t('Duplicate'), icon: 'copy', run: p.onDuplicate },
            { label: t('Delete'), icon: 'trash', run: p.onDelete, danger: true, sep: true }
          ]}
        />
      </div>
    </li>
  );
}

/** Seconds since `since`, ticking once a second. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{formatDuration(now - since)}</>;
}

// ---------- row editor ----------

function RowEditor({ row: initial, onClose }: { row: Row; onClose: (saved: boolean) => void }) {
  const q = queue.value!;
  const [row, setRow] = useState<Row>(() => structuredClone(q.rows.find((r) => r.id === initial.id) ?? initial));
  const [original] = useState(() => JSON.stringify(row));
  const eff = effectiveSettings(q.defaults, row.overrides);
  const model = modelById(eff.model);
  const isPro = pro.value;
  const save = () => {
    editQueue((x) => {
      const i = x.rows.findIndex((r) => r.id === row.id);
      if (i >= 0) x.rows[i] = row;
    });
    onClose(true);
  };
  /** Esc, the backdrop, the close button and Cancel all land here: ask before throwing edits away. */
  const cancel = () => {
    if (JSON.stringify(row) !== original && !confirm(t('Discard your changes to this row?'))) return;
    onClose(false);
  };
  const addRefs = async (ids: string[]) => setRow({ ...row, refs: [...row.refs, ...ids].slice(0, model?.maxRefs ?? 14) });

  return (
    <Modal
      title={t('Edit row')}
      onClose={cancel}
      wide
      sheet
      footer={
        <>
          <span class="grow" />
          <Button onClick={cancel}>{t('Cancel')}</Button>
          <Button variant="primary" onClick={save}>
            {t('Save')}
          </Button>
        </>
      }
    >
      <Field label={t('Prompt')} hint={t('Use @Name to bring in a character, {a|b} for variations')}>
        <textarea class="mid" value={row.prompt} onInput={(e) => setRow({ ...row, prompt: (e.target as HTMLTextAreaElement).value })} />
      </Field>
      <div class="row-wrap">
        <Button small icon="at" onClick={() => (sheet.value = 'characters')} title={t('Add or edit characters, then write @Name in the prompt')}>
          {t('Character')} {!isPro && <ProBadge />}
        </Button>
        {characters.value.slice(0, 6).map((c) => (
          <Chip key={c.id} onClick={() => setRow({ ...row, prompt: `${row.prompt}${row.prompt && !row.prompt.endsWith(' ') ? ' ' : ''}@${c.name} ` })} title={c.description}>
            @{c.name}
          </Chip>
        ))}
      </div>

      <div class="sub">
        <div class="row-wrap">
          <b>{t('Settings')}</b>
          {Object.keys(row.overrides).length > 0 ? (
            <Button small variant="ghost" onClick={() => setRow({ ...row, overrides: {} })}>
              {t('Use queue settings')}
            </Button>
          ) : (
            <span class="muted">{t('Same as the queue')}</span>
          )}
        </div>
        <GenEditor value={eff} onChange={(s) => setRow({ ...row, overrides: diffSettings(q.defaults, s) })} />
      </div>

      <div class="sub">
        <b>{eff.kind === 'video' && eff.videoMode === 'frames' ? t('Frames') : t('Reference images')}</b>
        {eff.kind === 'video' && eff.videoMode === 'frames' ? (
          <div class="row-wrap">
            <FrameSlot label={t('Start frame')} id={row.startFrame} onChange={(id) => setRow({ ...row, startFrame: id })} />
            {!modelById(eff.model)?.startFrameOnly && (
              <FrameSlot label={t('End frame (optional)')} id={row.endFrame} onChange={(id) => setRow({ ...row, endFrame: id })} />
            )}
          </div>
        ) : (
          <div
            class="refs"
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              e.preventDefault();
              await addRefs(await imagesFromDrop(e));
            }}
          >
            {row.refs.map((id) => (
              <Thumb key={id} id={id} size={56} onRemove={() => setRow({ ...row, refs: row.refs.filter((x) => x !== id) })} />
            ))}
            {(model?.maxRefs ?? 0) > row.refs.length ? (
              <button type="button" class="thumb add" onClick={async () => addRefs(await pickImages())}>
                <Icon name="plus" />
              </button>
            ) : (
              model?.maxRefs === undefined && <span class="muted">{t('This model does not take reference images')}</span>
            )}
          </div>
        )}
      </div>

      <div class="sub">
        <Toggle
          checked={!!row.chain}
          onChange={(chain) => setRow({ ...row, chain })}
          label={
            <>
              {t('Continue from the previous row')} {!isPro && <ProBadge />}
              <span class="hint">{eff.kind === 'video' ? t('Uses the last frame of the previous video as the start frame') : t('Uses the previous row’s image as a reference')}</span>
            </>
          }
        />
        {eff.kind === 'image' && (
          <Field label={<>{t('Then animate it (motion prompt)')} {!isPro && <ProBadge />}</>} hint={t('Leave empty to only make the image')}>
            <textarea rows={2} value={row.motionPrompt ?? ''} placeholder={t('e.g. slow dolly-in, leaves drifting, warm light flickers')} onInput={(e) => setRow({ ...row, motionPrompt: (e.target as HTMLTextAreaElement).value || undefined })} />
          </Field>
        )}
      </div>

      <div class="sub name-fields">
        <Field label={t('File name')} tip={t('A template: words in {braces} are replaced for each file, e.g. {n}_{prompt30} → 007_A red fox jumping.mp4')} hint={t('Template, e.g. {n}_{prompt30}. Empty = queue default')}>
          <input type="text" value={row.filename ?? ''} onInput={(e) => setRow({ ...row, filename: (e.target as HTMLInputElement).value || undefined })} />
        </Field>
        <Field label={t('Folder')}>
          <input type="text" value={row.folder ?? ''} placeholder="Reelbatch/{queue}" onInput={(e) => setRow({ ...row, folder: (e.target as HTMLInputElement).value || undefined })} />
        </Field>
      </div>
    </Modal>
  );
}

function FrameSlot({ label, id, onChange }: { label: string; id?: string; onChange: (id?: string) => void }) {
  return (
    <div
      class="frame-slot"
      onDragOver={(e) => e.preventDefault()}
      onDrop={async (e) => {
        e.preventDefault();
        const [first] = await imagesFromDrop(e);
        if (first) onChange(first);
      }}
    >
      <span class="label">{label}</span>
      {id ? (
        <Thumb id={id} size={88} onRemove={() => onChange(undefined)} />
      ) : (
        <button type="button" class="thumb add" style={{ width: '88px', height: '88px' }} onClick={async () => onChange((await pickImages(false))[0])}>
          <Icon name="upload" />
        </button>
      )}
    </div>
  );
}

// ---------- run bar ----------

/** Why Run cannot go ahead right now, with the one action that fixes it. */
interface Block {
  text: string;
  action?: { label: string; icon?: string; run: () => void };
  tone?: 'warn' | 'bad';
}

function RunBar({ selecting }: { selecting: boolean }) {
  // toasts stack above the bar, whatever its height is right now (cards, summary)
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--runbar-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--runbar-h');
    };
  }, []);
  const q = queue.value!;
  const r = run.value;
  const mine = r.queueId === q.id;
  const active = running.value;
  const n = Math.max(1, q.rows.length);
  const [rangeOn, setRangeOn] = useState(false);
  const [range, setRange] = useState({ from: 1, to: n });
  /** Until the user edits the range it follows the row count; after that it is only clamped to it. */
  const [rangeEdited, setRangeEdited] = useState(false);
  useEffect(() => {
    setRange((cur) => (rangeEdited ? { from: Math.min(cur.from, n), to: Math.min(cur.to, n) } : { from: 1, to: n }));
  }, [n]);
  const setEdge = (edge: 'from' | 'to', input: HTMLInputElement) => {
    const v = Math.min(n, Math.max(1, Math.round(parseFloat(input.value)) || 1));
    let next = { ...range, [edge]: v };
    if (next.from > next.to) next = { from: next.to, to: next.from };
    // write back even when the state does not change (e.g. "-3" clamped to the 1 already there)
    input.value = String(next[edge]);
    setRangeEdited(true);
    setRange(next);
  };
  const [est, setEst] = useState<Estimate | null>(null);
  const [now, setNow] = useState(Date.now());
  /** The error the background returned for the last Run press; shown in the preflight card, never as a toast. */
  const [runError, setRunError] = useState<string | null>(null);
  /** The finished-run summary the user closed (by run id). */
  const [closedSummary, setClosedSummary] = useState<string | undefined>();

  const scope: RunScope = useMemo(() => {
    if (selecting) return { kind: 'selected', ids: [...selected.value] };
    if (rangeOn) return { kind: 'range', from: range.from, to: range.to };
    return { kind: 'all' };
  }, [selecting, selected.value, rangeOn, range]);

  useEffect(() => {
    const id = setTimeout(async () => setEst(await call<Estimate>({ type: 'run:estimate', queueId: q.id, scope })), 300);
    return () => clearTimeout(id);
  }, [q, scope, pro.value, usedToday.value, run.value.status]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  useEffect(() => setRunError(null), [q.rows.length, flowStatus.value?.state, pro.value]);

  // only the rows of the latest run: rows kept from earlier runs must not inflate "1 of 4"
  const rows = mine ? (r.ids ?? Object.keys(r.rows)).map((id) => r.rows[id]).filter(Boolean) : [];
  const total = rows.length;
  const finished = rows.filter((x) => ['done', 'failed', 'skipped'].includes(x.status)).length;
  const done = rows.filter((x) => x.status === 'done').length;
  const failed = rows.filter((x) => x.status === 'failed').length;
  const skipped = rows.filter((x) => x.status === 'skipped').length;
  const elapsed = r.startedAt ? now - r.startedAt : 0;
  const eta = finished > 0 && total > finished ? (elapsed / finished) * (total - finished) : NaN;
  const current = q.rows.find((row) => BUSY.includes(r.rows[row.id]?.status));

  const start = async (sc: RunScope = scope) => {
    setRunError(null);
    await flushQueue(); // a prompt typed a moment ago must reach storage before the background reads the queue
    const res = await attempt({ type: 'run:start', queueId: q.id, scope: sc });
    if (res.error) setRunError(res.error);
  };
  const startTrial = async () => {
    if (!confirm(t('Start the {n}-day Pro trial now?', { n: PRO.trialDays }))) return;
    const r = await call<{ plan: string }>({ type: 'license:trial' });
    if (r) toast(r.plan === 'trial' ? t('Trial started: 7 days of Pro') : t('The trial already ran on this Google account'), r.plan === 'trial' ? 'ok' : 'error');
  };
  const proAction = license.value.trialStartedAt ? { label: t('Upgrade'), icon: 'rocket', run: showPlans } : { label: t('Start free trial'), icon: 'rocket', run: startTrial };

  // ----- preflight: everything the panel can tell before asking the background -----
  const f = flowStatus.value;
  const usesFlow = q.rows.some((row) => row.enabled && effectiveSettings(q.defaults, row.overrides).engine === 'flow');
  const blocks: Block[] = [];
  // the preflight "Needs Pro" card already lists the same features
  if (runError && !(/Reelbatch Pro/.test(runError) && est?.proNeeded.length)) {
    blocks.push({
      text: runError,
      tone: 'bad',
      action: /\bPro\b/.test(runError) ? proAction : /\bFlow\b/.test(runError) ? { label: t('Open Flow'), icon: 'external', run: () => void openFlow() } : { label: t('Open Settings'), icon: 'gear', run: () => showSettings('advanced') }
    });
  }
  // the background's own "Flow is not ready" error already covers the Flow state: don't say it twice
  if (usesFlow && f && f.state !== 'project' && !(runError && /\bFlow\b/.test(runError))) {
    blocks.push({
      text: f.state === 'tab' ? t('Flow is open but no project is: open or create a project in the Flow tab.') : t('Flow is not open. Open a Flow project to run prompts in it.'),
      action: { label: f.state === 'tab' ? t('Show Flow') : t('Open Flow'), icon: 'external', run: () => void openFlow() }
    });
  }
  if (!active && draft.value.trim()) {
    const n = splitPrompts(draft.value, 'auto', '---', true).length;
    blocks.push({
      text: t('The text in the box above is not in the queue yet ({n} prompts).', { n }),
      action: {
        label: t('Add it'),
        icon: 'plus',
        run: () => {
          const add = rowsFromPrompts(splitPrompts(draft.value, 'auto', '---', true), { prefix: '', suffix: '', repeat: 1, variations: true });
          editQueue((x) => void (x.rows = [...x.rows, ...add]));
          draft.value = '';
        }
      }
    });
  }
  if (est && est.proNeeded.length > 0) {
    blocks.push({ text: `${t('Needs Pro')}: ${est.proNeeded.map((x) => t(x)).join(', ')}.`, action: proAction });
  }
  if (est && est.freeLeft !== null && est.rows > est.freeLeft) {
    blocks.push({
      text: est.freeLeft === 0 ? t('Daily free limit used. Upgrade for unlimited prompts.') : t('Free plan: {n} of {max} prompts left today, this run has {rows}.', { n: est.freeLeft, max: PRO.freePerDay, rows: est.rows }),
      action: proAction
    });
  }

  const cost = !est ? '' : est.liveCost ? (est.credits > 0 ? t('{n}+ credits', { n: est.credits }) : t('credits set by Flow')) : est.credits > 0 ? t('{n} credits', { n: est.credits }) : est.usd > 0 ? `≈ $${est.usd.toFixed(2)}` : t('0 credits');
  const runLabel = selecting ? t('Run {n} selected', { n: est?.rows ?? selected.value.size }) : est ? `${t('Run {n} prompts', { n: est.rows })} · ${cost}` : t('Run');
  const moreItems: MenuItem[] = [
    { label: t('Run not finished'), icon: 'play', run: () => start({ kind: 'pending' }) },
    { label: t('Retry failed'), icon: 'refresh', disabled: !failed, run: () => start({ kind: 'failed' }) },
    { label: rangeOn ? t('Run all rows') : t('Run a range of rows…'), icon: 'list', run: () => setRangeOn(!rangeOn) },
    { label: t('Schedule'), icon: 'clock', sep: true, run: () => showSettings('advanced') }
  ];
  // a run saved by an older version has no ids: its counts can't be trusted, so no summary
  const showSummary = !active && mine && !!r.runId && !!r.ids && total > 0 && closedSummary !== r.runId;
  const inQueue = new Set(q.rows.map((x) => x.id));
  const doneHere = (r.ids ?? []).filter((id) => inQueue.has(id) && r.rows[id]?.status === 'done').length;
  const failedHere = (r.ids ?? []).filter((id) => inQueue.has(id) && r.rows[id]?.status === 'failed').length;

  const summaryEl = (
            <div class="summary">
              <div class="row-wrap nowrap">
                <span class="summary-text">
                  <Icon name={failed ? 'alert' : 'check'} size={14} /> <b>{t('Done {n}/{max}', { n: done, max: total })}</b>
                  {failed > 0 && <span class="bad"> · {t('{n} failed', { n: failed })}</span>}
                  {skipped > 0 && <span class="muted"> · {t('{n} not started', { n: skipped })}</span>}
                </span>
                <span class="grow" />
                <Button small variant="ghost" icon="x" aria-label={t('Close')} onClick={() => setClosedSummary(r.runId)} />
              </div>
              <div class="row-wrap">
                <Button small variant="ghost" icon="folder" onClick={() => openFolder(rows)}>
                  {t('Open folder')}
                </Button>
                <Button small variant="ghost" icon="download" disabled={!pro.value} title={pro.value ? undefined : t('ZIP export is a Pro feature')} onClick={() => call({ type: 'export:zip', runId: r.runId }, t('ZIP saved to Downloads'))}>
                  {t('Download ZIP')}
                </Button>
                {done > 0 && (
                  <Button small variant="ghost" icon="grid" onClick={() => (tab.value = 'history')}>
                    {t('Show results')}
                  </Button>
                )}
                {doneHere > 0 && (
                  <Button small variant="ghost" icon="check" title={t('Results stay in the Results tab')} onClick={() => editQueue((x) => void (x.rows = x.rows.filter((row) => r.rows[row.id]?.status !== 'done')))}>
                    {t('Remove done')}
                  </Button>
                )}
                {failedHere > 0 && (
                  <Button small variant="ghost" icon="refresh" onClick={() => start({ kind: 'failed' })}>
                    {t('Retry {n} failed', { n: failedHere })}
                  </Button>
                )}
              </div>
            </div>
  );

  return (
    <div class="runbar" ref={barRef}>
      {active && mine ? (
        <>
          <div class="progress" aria-label={t('Progress')}>
            <div class="bar ok" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
            <div class="bar bad" style={{ width: `${total ? (failed / total) * 100 : 0}%` }} />
          </div>
          <div class="run-line">
            <span>
              <b>{finished}</b>/{total}
              {failed > 0 && <span class="bad"> · {t('{n} failed', { n: failed })}</span>}
            </span>
            <span class="muted">
              {formatDuration(elapsed)}
              {Number.isFinite(eta) && ` · ${t('~{t} left', { t: formatDuration(eta) })}`}
            </span>
            <span class="muted">
              {r.spent.credits > 0 && t('{n} credits', { n: r.spent.credits })}
              {r.spent.usd > 0 && ` $${r.spent.usd.toFixed(2)}`}
            </span>
          </div>
          {current && (
            <div class="run-current" title={current.prompt}>
              <span class="status-dot" /> {current.prompt}
            </div>
          )}
          {r.message && (
            <div class={`run-msg ${r.status}`}>
              {r.status === 'cooldown' && r.cooldownUntil ? `${te(r.message)} (${formatDuration(r.cooldownUntil - now)})` : te(r.message)}
            </div>
          )}
          <div class="row-wrap">
            {r.status === 'running' && (
              <Button icon="pause" onClick={() => call({ type: 'run:pause' })}>
                {t('Pause')}
              </Button>
            )}
            {(r.status === 'paused' || r.status === 'cooldown') && (
              <Button variant="primary" icon="play" onClick={() => call({ type: 'run:resume' })}>
                {t('Resume')}
              </Button>
            )}
            <Button variant="danger" icon="stop" disabled={r.status === 'stopping'} onClick={() => call({ type: 'run:stop' })}>
              {r.status === 'stopping' ? t('Stopping…') : t('Stop')}
            </Button>
          </div>
          {usesFlow && <p class="hint debug-note">{t('The yellow “Reelbatch started debugging this browser” bar in Flow is normal while a run is active — do not click Cancel there.')}</p>}
        </>
      ) : active ? (
        <div class="run-msg">
          {t('Another queue is running.')}{' '}
          <Button small variant="ghost" onClick={() => r.queueId && switchQueue(r.queueId)}>
            {t('Show it')}
          </Button>
        </div>
      ) : q.rows.length === 0 && showSummary ? (
        // finished rows were taken out of the queue: the summary still says how the run went
        summaryEl
      ) : q.rows.length === 0 ? (
        <div class="run-empty">
          <Icon name="play" size={14} />
          <span>{t('Add prompts, then press Run to generate them one by one.')}</span>
        </div>
      ) : (
        <>
          {showSummary && summaryEl}
          {blocks.slice(0, 2).map((b, i) => (
            <div key={i} class={`preflight ${b.tone ?? ''}`} role="alert">
              <Icon name={b.tone === 'bad' ? 'alert' : 'info'} size={15} />
              <span class="preflight-text">{b.text}</span>
              {b.action && (
                <Button small variant="primary" icon={b.action.icon} onClick={b.action.run}>
                  {b.action.label}
                </Button>
              )}
            </div>
          ))}
          {rangeOn && (
            <div class="row-wrap">
              <span class="muted">{t('Rows')}</span>
              <span class="range" title={t('Row numbers to run, e.g. 5–20')}>
                <input type="number" min={1} max={n} step={1} value={range.from} aria-label={t('From row')} onChange={(e) => setEdge('from', e.currentTarget as HTMLInputElement)} />
                –
                <input type="number" min={1} max={n} step={1} value={range.to} aria-label={t('To row')} onChange={(e) => setEdge('to', e.currentTarget as HTMLInputElement)} />
              </span>
            </div>
          )}
          <div class="row-wrap nowrap run-controls">
            <Button variant="primary" icon="play" class="run-btn" disabled={!est || est.rows === 0} onClick={() => start()}>
              {runLabel}
            </Button>
            <Menu items={moreItems} title={t('More ways to run')} small={false} />
          </div>
          {est && est.rows > 0 && (
            <div class="estimate">
              <span>{t('{rows} prompts → {outputs} files', { rows: est.rows, outputs: est.outputs })}</span>
              {est.freeLeft !== null && <span class="muted">· {t('Free: {n} of {max} left today', { n: est.freeLeft, max: PRO.freePerDay })}</span>}
            </div>
          )}
          {selecting && selected.value.size === 0 && <div class="hint">{t('Tick the rows to run.')}</div>}
        </>
      )}
    </div>
  );
}

/** Show the folder of the first saved file of this run (or the Downloads folder when nothing was saved yet). */
function openFolder(rows: RowRun[]) {
  const id = rows.flatMap((x) => x.results).find((res) => res.downloadId !== undefined)?.downloadId;
  if (id !== undefined) chrome.downloads.show(id);
  else chrome.downloads.showDefaultFolder();
}

export function addPromptsFromHistory(prompts: string[]) {
  editQueue((x) => void x.rows.push(...prompts.map((p) => newRow({ prompt: p }))));
  toast(t('Added {n} prompts', { n: prompts.length }), 'ok');
  tab.value = 'queue';
}
