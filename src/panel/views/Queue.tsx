import { useEffect, useMemo, useState } from 'preact/hooks';
import type { GenSettings, Row, RowRun, RunScope } from '../../shared/types';
import type { Estimate } from '../../shared/messages';
import { effectiveSettings, modelById } from '../../shared/models';
import { newRow } from '../../shared/parse';
import { deleteQueue, newQueue } from '../../shared/storage';
import { unknownMentions } from '../../shared/characters';
import { formatDuration } from '../../shared/util';
import { PRO } from '../../shared/license';
import { t } from '../i18n';
import { characters, createQueue, editQueue, pro, queue, queueIndex, run, running, selected, switchQueue, tab, usedToday } from '../store';
import { Button, Field, Icon, Modal, ProBadge, Select, Thumb, Toggle, call, imagesFromDrop, pickImages, toast } from '../ui';
import { GenEditor, costLabel, diffSettings } from './GenEditor';
import { ImportDialog } from './Import';

const STATUS_LABEL: Record<RowRun['status'], string> = {
  queued: 'Queued',
  waiting: 'Waiting',
  sending: 'Sending',
  rendering: 'Rendering',
  downloading: 'Saving',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped'
};

export function QueueView() {
  const q = queue.value;
  const [importing, setImporting] = useState<false | 'paste' | 'helper'>(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [showDefaults, setShowDefaults] = useState(false);
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
          value={q.id}
          options={[...queueIndex.value.map((x) => ({ value: x.id, label: x.name })), { value: '__new', label: `+ ${t('New queue')}` }]}
          onChange={async (id) => {
            if (id === '__new') {
              const name = prompt(t('Name of the new queue'), `${t('Queue')} ${queueIndex.value.length + 1}`);
              if (name) await createQueue({ ...newQueue(name.trim() || 'Queue'), defaults: { ...q.defaults } });
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
          else await createQueue(newQueue('Queue 1'));
        }} />
        <span class="grow" />
        <Button small icon="spark" onClick={() => setImporting('helper')}>
          {t('AI')}
        </Button>
        <Button small variant="primary" icon="plus" onClick={() => setImporting('paste')}>
          {t('Add prompts')}
        </Button>
      </div>

      <section class={`defaults ${showDefaults ? 'open' : ''}`}>
        <button type="button" class="defaults-head" onClick={() => setShowDefaults(!showDefaults)}>
          <Icon name={q.defaults.kind === 'video' ? 'video' : 'image'} />
          <span>
            {modelById(q.defaults.model)?.label} · {q.defaults.aspect}
            {q.defaults.count > 1 ? ` · ×${q.defaults.count}` : ''}
            {q.defaults.duration && q.defaults.kind === 'video' ? ` · ${q.defaults.duration}s` : ''}
          </span>
          <span class="muted">{costLabel(q.defaults)}</span>
          <span class="grow" />
          <span class="muted">{showDefaults ? t('Hide') : t('Settings')}</span>
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
                onEdit={() => setEditing(row)}
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
            setEditing(row);
          }}>
            {t('Add a row')}
          </Button>
        </>
      )}

      <RunBar />
      {importing && <ImportDialog initial={importing} onClose={() => setImporting(false)} />}
      {editing && <RowEditor row={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Empty({ onAdd, onAi }: { onAdd: () => void; onAi: () => void }) {
  return (
    <div class="empty">
      <Icon name="list" size={36} />
      <h3>{t('Your queue is empty')}</h3>
      <p class="muted">{t('Paste a list of prompts, import a CSV or spreadsheet, or let the AI helper write them.')}</p>
      <div class="row-wrap center">
        <Button variant="primary" icon="plus" onClick={onAdd}>
          {t('Add prompts')}
        </Button>
        <Button icon="spark" onClick={onAi}>
          {t('Write with AI')}
        </Button>
      </div>
    </div>
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
          {status && <span class={`pill ${status}`}>{t(STATUS_LABEL[status])}</span>}
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
          {rr?.error && <span class={`err ${status === 'done' ? 'soft' : ''}`} title={rr.error}>{rr.error}</span>}
          {rr?.results.map((res, i) => (
            <a key={i} class="result" href={res.url || undefined} target="_blank" rel="noreferrer" title={res.file ?? res.url}>
              <Icon name={res.kind === 'video' ? 'video' : 'image'} size={12} />
            </a>
          ))}
        </div>
      </div>
      <div class="row-actions">
        <Button small variant="ghost" icon="edit" title={t('Edit row')} onClick={p.onEdit} />
        <details class="menu">
          <summary class="btn ghost sm icon-only" aria-label={t('More')}>⋯</summary>
          <div class="menu-pop">
            <button type="button" onClick={p.onToggle}>{row.enabled ? t('Disable') : t('Enable')}</button>
            <button type="button" onClick={() => p.onMove(-1)}>{t('Move up')}</button>
            <button type="button" onClick={() => p.onMove(1)}>{t('Move down')}</button>
            <button type="button" onClick={p.onDuplicate}>{t('Duplicate')}</button>
            <button type="button" class="danger" onClick={p.onDelete}>{t('Delete')}</button>
          </div>
        </details>
      </div>
    </li>
  );
}

// ---------- row editor ----------

function RowEditor({ row: initial, onClose }: { row: Row; onClose: () => void }) {
  const q = queue.value!;
  const [row, setRow] = useState<Row>(structuredClone(q.rows.find((r) => r.id === initial.id) ?? initial));
  const eff = effectiveSettings(q.defaults, row.overrides);
  const model = modelById(eff.model);
  const isPro = pro.value;
  const save = () => {
    editQueue((x) => {
      const i = x.rows.findIndex((r) => r.id === row.id);
      if (i >= 0) x.rows[i] = row;
    });
    onClose();
  };
  const addRefs = async (ids: string[]) => setRow({ ...row, refs: [...row.refs, ...ids].slice(0, model?.maxRefs ?? 14) });

  return (
    <Modal
      title={t('Edit row')}
      onClose={onClose}
      wide
      footer={
        <>
          <span class="grow" />
          <Button onClick={onClose}>{t('Cancel')}</Button>
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
            <FrameSlot label={t('End frame (optional)')} id={row.endFrame} onChange={(id) => setRow({ ...row, endFrame: id })} />
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

      <div class="sub row-wrap">
        <Field label={t('File name')} hint={t('Template, e.g. {n}_{prompt30}. Empty = queue default')}>
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
  const [range, setRange] = useState({ from: 1, to: q.rows.length || 1 });
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
      ) : (
        <>
          {r.message && mine && r.status === 'idle' && <div class="run-msg idle">{r.message}</div>}
          <div class="row-wrap">
            <Select<RunScope['kind']>
              value={scopeKind}
              options={[
                { value: 'all', label: t('All rows') },
                { value: 'selected', label: t('Selected ({n})', { n: selected.value.size }), disabled: !selected.value.size },
                { value: 'failed', label: t('Failed only') },
                { value: 'pending', label: t('Not finished') },
                { value: 'range', label: t('Range…') }
              ]}
              onChange={setScopeKind}
            />
            {scopeKind === 'range' && (
              <span class="range">
                <input type="number" min={1} value={range.from} onChange={(e) => setRange({ ...range, from: +(e.target as HTMLInputElement).value || 1 })} />
                –
                <input type="number" min={1} value={range.to} onChange={(e) => setRange({ ...range, to: +(e.target as HTMLInputElement).value || 1 })} />
              </span>
            )}
            <span class="grow" />
            <Button variant="primary" icon="play" disabled={!est?.rows || (est?.proNeeded.length ?? 0) > 0} onClick={start}>
              {t('Run')}
            </Button>
          </div>
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
              <ProBadge /> {t('Needs Pro')}: {est.proNeeded.map((x) => t(x)).join(', ')}.{' '}
              <Button small variant="ghost" onClick={() => (tab.value = 'settings')}>
                {t('Start free trial')}
              </Button>
            </div>
          )}
          {!pro.value && usedToday.value >= PRO.freePerDay && (
            <div class="pro-needed">{t('Daily free limit used. Upgrade for unlimited prompts.')}</div>
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
