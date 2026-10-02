import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Row } from '../../shared/types';
import { putAsset } from '../../shared/idb';
import { modelById, modelsFor } from '../../shared/models';
import {
  IMAGE_IMPORT_MAX, IMAGE_MAX_BYTES, IMAGE_TYPES, type ImagePromptMode, type ImageRole,
  fileStem, fitWithin, promptsForImages, rowsFromImages
} from '../../shared/images';
import { errText } from '../../shared/util';
import { t } from '../i18n';
import { editQueue, pro, queue, showPlans } from '../store';
import { Button, Field, Icon, Select, Toggle, toast } from '../ui';

/** Long side the panel scales big photos down to before storing them (video models take ~720p–1080p). */
const MAX_SIDE = 2048;
/** Files above this are re-encoded even when small in pixels: they travel to Flow as data URLs. */
const REENCODE_BYTES = 4 * 1024 * 1024;

interface Picked {
  key: string;
  file: File;
  url: string;
}

/** Scale a photo down (long side ≤ MAX_SIDE) or re-encode a heavy one; small files pass through. */
async function prepare(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const fit = fitWithin(bmp.width, bmp.height, MAX_SIDE);
    if (!fit && file.size <= REENCODE_BYTES) {
      bmp.close();
      return file;
    }
    const size = fit ?? { w: bmp.width, h: bmp.height };
    const c = new OffscreenCanvas(size.w, size.h);
    c.getContext('2d')!.drawImage(bmp, 0, 0, size.w, size.h);
    bmp.close();
    return await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  } catch {
    return file; // not decodable here: let the engine try the original
  }
}

/** "Animate photos in bulk": many images → one image→video row each. Pro. */
export function ImagesPane({ onDone }: { onDone: () => void }) {
  const q = queue.value;
  const isPro = pro.value;
  const engine = q?.defaults.engine ?? 'flow';
  const [items, setItems] = useState<Picked[]>([]);
  const [role, setRole] = useState<ImageRole>('start');
  const [mode, setMode] = useState<ImagePromptMode>('same');
  const [text, setText] = useState('');
  const [variations, setVariations] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const videoModes = role === 'start' ? 'frames' : 'ingredients';
  const models = modelsFor(engine, 'video').filter((m) => m.videoModes?.includes(videoModes) && (role === 'start' || (m.maxRefs ?? 0) > 0));
  const preferred = q && q.defaults.kind === 'video' ? q.defaults.model : undefined;
  const [model, setModel] = useState<string>(() => preferred ?? modelsFor(engine, 'video')[0]?.id ?? 'flow:omni-flash');
  const modelOk = models.some((m) => m.id === model);
  const chosen = modelOk ? model : models[0]?.id;

  // object URLs live as long as the dialog
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const addFiles = (list: File[]) => {
    const skipped: string[] = [];
    const next = [...items];
    for (const f of list) {
      if (!IMAGE_TYPES.includes(f.type)) skipped.push(t('{name}: not a JPG, PNG or WebP image', { name: f.name }));
      else if (f.size > IMAGE_MAX_BYTES) skipped.push(t('{name}: larger than 20 MB', { name: f.name }));
      else if (next.length >= IMAGE_IMPORT_MAX) {
        skipped.push(t('Only the first {n} images are kept', { n: IMAGE_IMPORT_MAX }));
        break;
      } else if (!next.some((x) => x.file.name === f.name && x.file.size === f.size && x.file.lastModified === f.lastModified)) {
        const url = URL.createObjectURL(f);
        urls.current.push(url);
        next.push({ key: `${f.name}:${f.size}:${f.lastModified}:${next.length}`, file: f, url });
      }
    }
    setItems(next);
    if (skipped.length) toast(skipped.slice(0, 3).join(' · ') + (skipped.length > 3 ? ` · ${t('and {n} more', { n: skipped.length - 3 })}` : ''), 'error');
  };

  const names = items.map((x) => x.file.name);
  const prompts = useMemo(() => promptsForImages(names, text, mode, variations), [names.join('\n'), text, mode, variations]);
  const missing = prompts.filter((p) => !p.prompt).length;
  const extraLines = mode === 'lines' ? Math.max(0, text.split(/\r?\n/).filter((l) => l.trim()).length - items.length) : 0;
  const canAdd = isPro && !!chosen && items.length > 0 && missing < items.length && !busy;

  const add = async (replace: boolean) => {
    if (!canAdd || !chosen) return;
    const existing = queue.value?.rows.length ?? 0;
    if (replace && existing > 0 && !confirm(t('Replace the {n} rows in this queue with the imported ones?', { n: existing }))) return;
    try {
      // images without a prompt would only be skipped by the run: leave them out
      const use = items.map((it, i) => ({ it, p: prompts[i] })).filter(({ p }) => p?.prompt);
      const stored: { asset: string; name: string }[] = [];
      for (const [i, { it }] of use.entries()) {
        setBusy(t('Saving images… {i}/{n}', { i: i + 1, n: use.length }));
        stored.push({ asset: await putAsset(await prepare(it.file), it.file.name), name: it.file.name });
      }
      const rows: Row[] = rowsFromImages(stored, use.map(({ p }) => p), { role, model: chosen, engine }).map(({ warnings: _w, ...r }) => r);
      editQueue((x) => {
        x.rows = replace ? rows : [...x.rows, ...rows];
      });
      toast(t('Added {n} prompts', { n: rows.length }), 'ok');
      onDone();
    } catch (e) {
      toast(`${t('Could not save the images')}: ${errText(e)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!isPro)
    return (
      <div class="stack img-import img-upsell">
        <span class="empty-icon">
          <Icon name="image" size={22} />
        </span>
        <h3>{t('Animate photos in bulk')}</h3>
        <p class="muted">
          {t('Drop up to {n} photos and get one video per photo: each image becomes the start frame (or a reference) of its own row, with one motion prompt for all of them or one per line.', { n: IMAGE_IMPORT_MAX })}
        </p>
        <span class="hint">{t('Animating photos in bulk is a Pro feature')}</span>
        <div class="row-wrap img-upsell-actions">
          <Button variant="primary" icon="rocket" onClick={() => (onDone(), showPlans())}>
            {t('Upgrade')}
          </Button>
          <Button variant="ghost" onClick={() => (onDone(), showPlans())}>
            {t('Compare Free and Pro')}
          </Button>
        </div>
      </div>
    );

  return (
    <div class="stack img-import">
      <div
        class="drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles([...(e.dataTransfer?.files ?? [])]);
        }}
      >
        <Icon name="image" size={22} />
        <p>{t('Drop photos here or choose them')}</p>
        <p class="muted">{t('JPG, PNG, WebP · up to {n} images, 20 MB each', { n: IMAGE_IMPORT_MAX })}</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={IMAGE_TYPES.join(',')}
          disabled={!!busy}
          onChange={(e) => {
            const el = e.target as HTMLInputElement;
            addFiles([...(el.files ?? [])]);
            el.value = '';
          }}
        />
      </div>

      <div class="row-wrap">
        <Field label={t('Use each image as')}>
          <Select<ImageRole>
            value={role}
            options={[
              { value: 'start', label: t('Start frame') },
              { value: 'ref', label: t('Reference image') }
            ]}
            onChange={setRole}
          />
        </Field>
        <Field label={t('Video model')}>
          {models.length ? (
            <Select value={chosen!} options={models.map((m) => ({ value: m.id, label: m.label }))} onChange={setModel} />
          ) : (
            <span class="warn">{t('No video model of this engine takes reference images')}</span>
          )}
        </Field>
      </div>

      <div class="seg small">
        <button type="button" class={mode === 'same' ? 'on' : ''} onClick={() => setMode('same')}>
          {t('One prompt for all')}
        </button>
        <button type="button" class={mode === 'lines' ? 'on' : ''} onClick={() => setMode('lines')}>
          {t('One prompt per line')}
        </button>
      </div>
      <textarea
        class="mid"
        value={text}
        placeholder={
          mode === 'same'
            ? t('Motion prompt for every image, e.g. “Slow camera push-in, {gentle wind|soft light}”. {filename} = the image name.')
            : t('One motion prompt per line: line 1 goes to image 1, line 2 to image 2, … {filename} = the image name.')
        }
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      {mode === 'same' && <Toggle checked={variations} onChange={setVariations} label={t('Expand {a|b} variations (dealt out across the images)')} />}
      {mode === 'lines' && items.length > 0 && missing > 0 && <span class="warn">{t('{n} images have no prompt line and will be skipped', { n: missing })}</span>}
      {extraLines > 0 && <span class="muted">{t('{n} extra lines are not used', { n: extraLines })}</span>}

      {items.length > 0 && (
        <>
          <div class="row-wrap">
            <b>{t('{n} images', { n: items.length })}</b>
            <span class="grow" />
            <Button small variant="ghost" disabled={!!busy} onClick={() => setItems([])}>
              {t('Clear')}
            </Button>
          </div>
          <ol class="img-list">
            {items.map((it, i) => (
              <li key={it.key}>
                <img src={it.url} alt="" loading="lazy" />
                <span class="img-info">
                  <span class="img-name" title={it.file.name}>
                    {fileStem(it.file.name)}
                  </span>
                  <span class={prompts[i]?.prompt ? 'img-prompt' : 'img-prompt warn'}>{prompts[i]?.prompt || t(prompts[i]?.warnings?.[0] ?? 'No prompt')}</span>
                </span>
                <button type="button" class="thumb-x" disabled={!!busy} aria-label={t('Remove')} onClick={() => setItems(items.filter((x) => x.key !== it.key))}>
                  ×
                </button>
              </li>
            ))}
          </ol>
        </>
      )}

      <div class="row-wrap">
        {busy ? <span class="muted">{busy}</span> : chosen && <span class="muted">{modelById(chosen)?.label} · {role === 'start' ? t('Frames (start / end)') : t('Ingredients (references)')}</span>}
        <span class="grow" />
        <Button disabled={!canAdd} onClick={() => add(true)}>
          {t('Replace queue')}
        </Button>
        <Button variant="primary" disabled={!canAdd} onClick={() => add(false)}>
          {t('Add {n} to queue', { n: items.length - missing })}
        </Button>
      </div>
    </div>
  );
}
