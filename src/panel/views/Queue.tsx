import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { GenSettings, Row, RowRun, RunScope } from '../../shared/types';
import { send, type Estimate } from '../../shared/messages';
import { effectiveSettings, modelById } from '../../shared/models';
import { newRow } from '../../shared/parse';
import { deleteQueue, newQueue } from '../../shared/storage';
import { unknownMentions } from '../../shared/characters';
import { formatDuration } from '../../shared/util';
import { PRO } from '../../shared/license';
import { t } from '../i18n';
import { characters, createQueue, editQueue, license, pro, queue, queueIndex, run, running, selected, showPlans, switchQueue, tab, usedToday } from '../store';
import { Button, Field, Icon, Modal, ProBadge, Select, Thumb, Toggle, call, imagesFromDrop, pickImages, toast } from '../ui';
import { GenEditor, costLabel, diffSettings } from './GenEditor';
import { ImportDialog } from './Import';

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

export function QueueView() {
  const q = queue.value;
  const [importing, setImporting] = useState<false | 'paste' | 'helper'>(false);
  const [editing, setEditing] = useState<{ row: Row; isNew?: boolean } | null>(null);
  const [showDefaults, setShowDefaults] = useState(false);
  /** Bumped to remount the queue picker when "+ New queue" is cancelled, so it shows the active queue again. */
  const [pickerKey, setPickerKey] = useState(0);
  if (!q) return null;
  const sel = selected.value;
  const r = run.value;
  const thisRun = r.queueId === q.id ? r.rows : {};

  const toggleSel = (id: string, on: boolean) => {
    const s = new Set(sel);
    if (on) s.add(id);
    else s.delete(id);
    selected.value = s;
  };

  const move = (i: number, d: number) =>
    editQueue((x) => {
      const j = i + d;
      if (j < 0 || j >= x.rows.length) return;
      [x.rows[i], x.rows[j]] = [x.rows[j], x.rows[i]];
    });

  return (
    <div class="queue-view">
      <div class="toolbar">
        <Select
          key={pickerKey}
          value={q.id}
          options={[...queueIndex.value.map((x) => ({ value: x.id, label: x.name })), { value: '__new', label: `+ ${t('New queue')}` }]}
          onChange={async (id) => {
            if (id === '__new') {
              const name = prompt(t('Name of the new queue'), `${t('Queue')} ${queueIndex.value.length + 1}`);
              if (name) await createQueue({ ...newQueue(name.trim() || t('Queue')), defaults: { ...q.defaults } });
              else setPickerKey((k) => k + 1);
            } else await switchQueue(id);
          }}
        />
        <Button small variant="ghost" icon="edit" title={t('Rename queue')} onClick={() => {
          const name = prompt(t('Rename queue'), q.name);
          if (name?.trim()) editQueue((x) => void (x.name = name.trim()));
        }} />
        <Button small variant="ghost" icon="trash" title={t('Delete queue')} disabled={running.value && r.queueId === q.id} onClick={async () => {
          if (!confirm(t('Delete the queue “{name}” and its {n} rows?', { name: q.name, n: q.rows.length }))) return;
          await deleteQueue(q.id);
          const next = queueIndex.value.find((x) => x.id !== q.id);
          if (next) await switchQueue(next.id);
          else await createQueue(newQueue(`${t('Queue')} 1`));
        }} />
        <span class="grow" />
        {q.rows.length > 0 && (
          <>
            <Button small variant="ghost" icon="spark" title={t('Write or vary prompts with the AI helper')} onClick={() => setImporting('helper')}>
              {t('AI')}
            </Button>
            <Button small icon="plus" class="add-prompts" onClick={() => setImporting('paste')}>
              {t('Add prompts')}
            </Button>
          </>
        )}
      </div>

      <GettingStarted />

      <section class={`defaults ${showDefaults ? 'open' : ''}`}>
        <button type="button" class="defaults-head" aria-expanded={showDefaults} title={t('Model, aspect and other settings every row uses unless it has its own')} onClick={() => setShowDefaults(!showDefaults)}>
          <span class="defaults-icon">
            <Icon name={q.defaults.kind === 'video' ? 'video' : 'image'} />
          </span>
          <span class="defaults-text">
            <span class="eyebrow">{t('Default for all rows')}</span>
            <span class="defaults-value">
              <b>{modelById(q.defaults.model)?.label}</b> · {q.defaults.aspect}
              {q.defaults.count > 1 ? ` · ×${q.defaults.count}` : ''}
              {q.defaults.duration && q.defaults.kind === 'video' ? ` · ${q.defaults.duration}s` : ''}
            </span>
            <span class="defaults-cost">{costLabel(q.defaults)}</span>
          </span>
          <span class="change">{showDefaults ? t('Done') : t('Change')}</span>
        </button>
        {showDefaults && <GenEditor value={q.defaults} onChange={(d) => editQueue((x) => void (x.defaults = d))} />}
      </section>

      {q.rows.length === 0 ? (
        <Empty onAdd={() => setImporting('paste')} onAi={() => setImporting('helper')} />
      ) : (
        <>
          <div class="list-head">
            <input
              type="checkbox"
              aria-label={t('Select all')}
              checked={sel.size > 0 && sel.size === q.rows.length}
              onChange={(e) => (selected.value = (e.target as HTMLInputElement).checked ? new Set(q.rows.map((x) => x.id)) : new Set())}
            />
            <span class="muted">{sel.size ? t('{n} selected', { n: sel.size }) : t('{n} prompts', { n: q.rows.length })}</span>
            <span class="grow" />
            {sel.size > 0 && (
              <>
                <Button small variant="ghost" onClick={() => editQueue((x) => x.rows.forEach((row) => sel.has(row.id) && (row.enabled = !row.enabled)))}>
                  {t('On/off')}
                </Button>
                <Button small variant="ghost" icon="trash" onClick={() => {
                  editQueue((x) => void (x.rows = x.rows.filter((row) => !sel.has(row.id))));
                  selected.value = new Set();
                }}>
                  {t('Delete')}
                </Button>
              </>
            )}
            {sel.size === 0 && Object.values(thisRun).some((x) => x.status === 'done') && (
              <Button small variant="ghost" onClick={() => editQueue((x) => void (x.rows = x.rows.filter((row) => thisRun[row.id]?.status !== 'done')))}>
                {t('Remove done')}
              </Button>
            )}
          </div>
          <ol class="rows">
            {q.rows.map((row, i) => (
              <RowItem
                key={row.id}
                row={row}
                n={i + 1}
                rr={thisRun[row.id]}
                defaults={q.defaults}
                checked={sel.has(row.id)}
                onCheck={(on) => toggleSel(row.id, on)}
                onEdit={() => setEditing({ row })}
                onMove={(d) => move(i, d)}
                onDuplicate={() => editQueue((x) => x.rows.splice(i + 1, 0, { ...structuredClone(row), id: crypto.randomUUID() }))}
                onDelete={() => editQueue((x) => void x.rows.splice(i, 1))}
                onToggle={() => editQueue((x) => void (x.rows[i].enabled = !x.rows[i].enabled))}
                onPrompt={(p) => editQueue((x) => void (x.rows[i].prompt = p))}
              />
            ))}
          </ol>
          <Button small variant="ghost" icon="plus" class="add-row" onClick={() => {
            const row = newRow({ prompt: '' });
            editQueue((x) => void x.rows.push(row));
            setEditing({ row, isNew: true });
          }}>
            {t('Add a row')}
          </Button>
        </>
      )}

      <RunBar />
      {importing && <ImportDialog initial={importing} onClose={() => setImporting(false)} />}
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

function Empty({ onAdd, onAi }: { onAdd: () => void; onAi: () => void }) {
  return (
    <div class="empty queue-empty">
      <span class="empty-icon">
        <Icon name="list" size={26} />
      </span>
      <h3>{t('Your queue is empty')}</h3>
      <p class="muted">{t('Paste a list of prompts, import a CSV or spreadsheet, or let the AI helper write them.')}</p>
      <Button variant="primary" icon="plus" class="big add-prompts" onClick={onAdd}>
        {t('Add prompts')}
      </Button>
      <p class="formats">{t('One prompt per line · TXT, CSV, DOCX · Sheets, Excel, JSON with Pro')}</p>
      <Button small variant="ghost" icon="spark" onClick={onAi}>
        {t('Write with AI')}
      </Button>
    </div>
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

interface FlowTabInfo {
  id: number;
  url: string;
}

/**
 * First-run checklist: Flow project open → prompts added → Run pressed. Hidden for good once all
 * three are done or the user dismisses it. The Flow step polls the open Flow tabs while it is pending.
 */
function GettingStarted() {
  const [state, setState] = useState(readGs);
  /** null = not checked yet; otherwise whether a Flow tab / a Flow project is open. */
  const [flow, setFlow] = useState<{ tab: boolean; project: boolean } | null>(null);
  const q = queue.value;
  const r = run.value;
  const hasRows = !!q && q.rows.length > 0;
  const ran = !!r.runId || r.status !== 'idle' || usedToday.value > 0;
  const flowOk = !!flow?.project || ran;
  const hidden = state === 'done' || state === 'dismissed';

  useEffect(() => {
    if (hidden || flowOk) return;
    let alive = true;
    const check = async () => {
      const tabs = await send<FlowTabInfo[]>({ type: 'flow:tabs' }).catch(() => null);
      if (!alive || !tabs) return;
      setFlow({ tab: tabs.length > 0, project: tabs.some((x) => /\/project\//.test(x.url)) });
    };
    void check();
    const id = setInterval(check, 3000);
    window.addEventListener('focus', check);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener('focus', check);
    };
  }, [hidden, flowOk]);

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
  const steps: { done: boolean; title: string; hint: string; action?: preact.ComponentChildren }[] = [
    {
      done: flowOk,
      title: t('Open a Flow project'),
      hint: flowOk ? t('Flow project found') : flow?.tab ? t('Flow is open: open or create a project in it') : t('Sign in to Flow and open a project'),
      action: !flowOk && (
        <Button small icon="external" onClick={() => call({ type: 'flow:open' })}>
          {flow?.tab ? t('Show Flow') : t('Open Flow')}
        </Button>
      )
    },
    {
      done: hasRows,
      title: t('Add prompts'),
      hint: hasRows ? t('{n} prompts', { n: q?.rows.length ?? 0 }) : t('Paste a list or import a file')
    },
    {
      done: ran,
      title: t('Press Run'),
      hint: ran ? t('Your first run has started') : t('Reelbatch types each prompt into Flow and saves the results')
    }
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
            <span class="gs-mark">{s.done ? <Icon name="check" size={13} /> : i + 1}</span>
            <span class="gs-text">
              <span class="gs-title">{s.title}</span>
              <span class="gs-hint">{s.hint}</span>
            </span>
            {s.action || null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function RowItem(p: {
  row: Row;
  n: number;
  rr?: RowRun;
  defaults: GenSettings;
  checked: boolean;
  onCheck: (on: boolean) => void;
  onEdit: () => void;
  onMove: (d: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onPrompt: (s: string) => void;
}) {
  const { row, rr } = p;
  const eff = effectiveSettings(p.defaults, row.overrides);
  const overridden = Object.keys(row.overrides).length > 0;
  const unknown = unknownMentions(row.prompt, characters.value);
  const status = rr?.status;
  const [errOpen, setErrOpen] = useState(false);
  return (
    <li class={`row ${row.enabled ? '' : 'off'} ${status ?? ''}`}>
      <input type="checkbox" checked={p.checked} onChange={(e) => p.onCheck((e.target as HTMLInputElement).checked)} aria-label={t('Select row {n}', { n: p.n })} />
      <span class="n">{p.n}</span>
      <div class="row-main">
        <textarea
          class="prompt"
          rows={2}
          value={row.prompt}
          placeholder={t('Prompt…')}
          onChange={(e) => p.onPrompt((e.target as HTMLTextAreaElement).value)}
        />
        <div class="row-meta">
          {status && <span class={`pill ${status}`}>{statusLabel(status)}</span>}
          {overridden && (
            <span class="tag" title={t('This row has its own settings')}>
              <Icon name={eff.kind === 'video' ? 'video' : 'image'} size={12} /> {modelById(eff.model)?.label} · {eff.aspect}
            </span>
          )}
          {row.chain && <span class="tag" title={t('Continues from the previous row')}><Icon name="link" size={12} /> {t('chain')}</span>}
          {row.motionPrompt && <span class="tag" title={row.motionPrompt}><Icon name="video" size={12} /> {t('animate')}</span>}
          {(row.startFrame || row.endFrame) && <span class="tag">{t('frames')}</span>}
          {row.refs.slice(0, 4).map((id) => <Thumb key={id} id={id} size={20} />)}
          {row.refs.length > 4 && <span class="muted">+{row.refs.length - 4}</span>}
          {unknown.length > 0 && <span class="tag warn" title={t('Add these characters in the Characters tab')}>@{unknown.join(', @')}?</span>}
          {rr?.error && (
            <span
              class={`err ${status === 'done' ? 'soft' : ''} ${errOpen ? 'open' : ''}`}
              title={errOpen ? t('Click to collapse') : rr.error}
              role="button"
              tabIndex={0}
              aria-expanded={errOpen}
              onClick={() => setErrOpen(!errOpen)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setErrOpen(!errOpen))}
            >
              {rr.error}
            </span>
          )}
          {rr?.results.map((res, i) => (
            <a key={i} class="result" href={res.url || undefined} target="_blank" rel="noreferrer" title={res.file ?? res.url}>
              <Icon name={res.kind === 'video' ? 'video' : 'image'} size={12} />
            </a>
          ))}
          {!row.enabled && <span class="tag">{t('Off')}</span>}
        </div>
      </div>
      <div class="row-actions">
        <Button small variant="ghost" icon="edit" class="row-edit" title={t('Edit row')} onClick={p.onEdit} />
        <RowMenu
          items={[
            { label: row.enabled ? t('Disable') : t('Enable'), icon: 'toggle', run: p.onToggle },
            { label: t('Move up'), icon: 'up', run: () => p.onMove(-1) },
            { label: t('Move down'), icon: 'down', run: () => p.onMove(1) },
            { label: t('Duplicate'), icon: 'copy', run: p.onDuplicate },
            { label: t('Delete'), icon: 'trash', run: p.onDelete, danger: true }
          ]}
        />
      </div>
    </li>
  );
}

/** The row's "⋯" menu: closes after any item, on Esc and on a click outside it. */
function RowMenu({ items }: { items: { label: string; icon: string; run: () => void; danger?: boolean }[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => ref.current && (ref.current.open = false);
    const onDown = (e: Event) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <details class="menu" ref={ref} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary class="btn ghost sm icon-only" aria-label={t('More')} title={t('More actions')}>
        <Icon name="more" size={16} />
      </summary>
      <div class="menu-pop">
        {items.map((it) => (
          <button
            type="button"
            key={it.label}
            class={it.danger ? 'danger' : undefined}
            onClick={() => {
              if (ref.current) ref.current.open = false;
              it.run();
            }}
          >
            <Icon name={it.icon} size={14} />
            <span>{it.label}</span>
          </button>
        ))}
      </div>
    </details>
  );
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

function RunBar() {
  const q = queue.value!;
  const r = run.value;
  const mine = r.queueId === q.id;
  const active = running.value;
  const [scopeKind, setScopeKind] = useState<RunScope['kind']>('all');
  const n = Math.max(1, q.rows.length);
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

  const scope: RunScope = useMemo(() => {
    if (scopeKind === 'selected') return { kind: 'selected', ids: [...selected.value] };
    if (scopeKind === 'range') return { kind: 'range', from: range.from, to: range.to };
    return { kind: scopeKind } as RunScope;
  }, [scopeKind, selected.value, range]);

  useEffect(() => {
    const id = setTimeout(async () => setEst(await call<Estimate>({ type: 'run:estimate', queueId: q.id, scope })), 300);
    return () => clearTimeout(id);
  }, [q, scope, pro.value]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  const rows = Object.values(mine ? r.rows : {});
  const total = rows.length;
  const finished = rows.filter((x) => ['done', 'failed', 'skipped'].includes(x.status)).length;
  const done = rows.filter((x) => x.status === 'done').length;
  const failed = rows.filter((x) => x.status === 'failed').length;
  const elapsed = r.startedAt ? now - r.startedAt : 0;
  const eta = finished > 0 && total > finished ? (elapsed / finished) * (total - finished) : NaN;

  const start = () => call({ type: 'run:start', queueId: q.id, scope });
  const startTrial = async () => {
    if (!confirm(t('Start the {n}-day Pro trial now?', { n: PRO.trialDays }))) return;
    await call({ type: 'license:trial' }, t('Trial started: 7 days of Pro'));
  };

  return (
    <div class="runbar">
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
          {r.message && (
            <div class={`run-msg ${r.status}`}>
              {r.status === 'cooldown' && r.cooldownUntil ? `${r.message} (${formatDuration(r.cooldownUntil - now)})` : r.message}
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
        </>
      ) : active ? (
        <div class="run-msg">
          {t('Another queue is running.')}{' '}
          <Button small variant="ghost" onClick={() => r.queueId && switchQueue(r.queueId)}>
            {t('Show it')}
          </Button>
        </div>
      ) : q.rows.length === 0 ? (
        <div class="run-empty">
          <Icon name="play" size={14} />
          <span>{t('Add prompts, then press Run to generate them one by one.')}</span>
        </div>
      ) : (
        <>
          {r.message && mine && r.status === 'idle' && <div class="run-msg idle">{r.message}</div>}
          <div class="row-wrap run-controls">
            <Select<RunScope['kind']>
              title={t('Which rows to run: all, the ticked ones, failed ones, unfinished ones or a range of row numbers')}
              value={scopeKind}
              options={[
                { value: 'all', label: t('All rows') },
                { value: 'selected', label: t('Selected ({n})', { n: selected.value.size }) },
                { value: 'failed', label: t('Failed only') },
                { value: 'pending', label: t('Not finished') },
                { value: 'range', label: t('Range…') }
              ]}
              onChange={setScopeKind}
            />
            {scopeKind === 'range' && (
              <span class="range" title={t('Row numbers to run, e.g. 5–20')}>
                <input type="number" min={1} max={n} step={1} value={range.from} aria-label={t('From row')} onChange={(e) => setEdge('from', e.currentTarget as HTMLInputElement)} />
                –
                <input type="number" min={1} max={n} step={1} value={range.to} aria-label={t('To row')} onChange={(e) => setEdge('to', e.currentTarget as HTMLInputElement)} />
              </span>
            )}
            <span class="grow" />
            <Button variant="primary" icon="play" class="run-btn" disabled={!est?.rows || (est?.proNeeded.length ?? 0) > 0} onClick={start}>
              {t('Run')}
            </Button>
          </div>
          {scopeKind === 'selected' && selected.value.size === 0 && <div class="hint">{t('Select rows first: tick the boxes next to the prompts.')}</div>}
          {est && (
            <div class="estimate">
              <span>{t('{rows} prompts → {outputs} files', { rows: est.rows, outputs: est.outputs })}</span>
              {est.credits > 0 && <span>· {t('{n} credits', { n: est.credits })}</span>}
              {est.usd > 0 && <span>· ≈ ${est.usd.toFixed(2)}</span>}
              {est.freeLeft !== null && (
                <span class={est.freeLeft < est.rows ? 'warn' : 'muted'}>
                  · {t('Free: {n} of {max} left today', { n: est.freeLeft, max: PRO.freePerDay })}
                </span>
              )}
            </div>
          )}
          {est && est.proNeeded.length > 0 && (
            <div class="pro-needed">
              <div class="pro-needed-text">
                <ProBadge /> <span>{t('Needs Pro')}: {est.proNeeded.map((x) => t(x)).join(', ')}.</span>
              </div>
              <div class="row-wrap">
                {license.value.trialStartedAt ? (
                  <Button small variant="primary" onClick={showPlans}>
                    {t('Upgrade')}
                  </Button>
                ) : (
                  <Button small variant="primary" onClick={startTrial}>
                    {t('Start free trial')}
                  </Button>
                )}
                <Button small variant="ghost" onClick={showPlans}>
                  {t('Compare Free and Pro')}
                </Button>
              </div>
            </div>
          )}
          {!pro.value && usedToday.value >= PRO.freePerDay && (
            <div class="pro-needed">
              <div class="pro-needed-text">{t('Daily free limit used. Upgrade for unlimited prompts.')}</div>
              <div class="row-wrap">
                <Button small variant="ghost" onClick={showPlans}>
                  {t('Compare Free and Pro')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function addPromptsFromHistory(prompts: string[]) {
  editQueue((x) => void x.rows.push(...prompts.map((p) => newRow({ prompt: p }))));
  toast(t('Added {n} prompts', { n: prompts.length }), 'ok');
  tab.value = 'queue';
}
