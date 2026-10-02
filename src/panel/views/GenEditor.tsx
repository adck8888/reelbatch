import type { EngineId, GenSettings, MediaKind, VideoMode } from '../../shared/types';
import { MODELS, effectiveSettings, estimateCost, modelById, modelsFor } from '../../shared/models';
import { t } from '../i18n';
import { pro } from '../store';
import { Field, NumberInput, Select } from '../ui';

const ENGINES: { value: EngineId; label: string }[] = [
  { value: 'flow', label: 'Google Flow' },
  { value: 'gemini', label: 'Gemini API' },
  { value: 'replicate', label: 'Replicate' }
];

/** Built on each call so the labels follow the UI language. */
const modeLabel = (v: VideoMode): string => ({ text: t('Text → video'), frames: t('Frames (start / end)'), ingredients: t('Ingredients (references)') })[v];

/** Seeds are 32-bit signed integers on every provider. */
const MAX_SEED = 2147483647;

export function costLabel(s: GenSettings) {
  const c = estimateCost(s);
  if (s.engine === 'flow') return c ? t('{n} credits', { n: Math.round(c) }) : t('0 credits on most plans');
  return `≈ $${c.toFixed(c < 1 ? 3 : 2)}`;
}

/** Edits generation settings; every change is coerced to what the chosen model supports. */
export function GenEditor({ value, onChange, compact }: { value: GenSettings; onChange: (s: GenSettings) => void; compact?: boolean }) {
  const s = value;
  const m = modelById(s.model);
  const set = (patch: Partial<GenSettings>) => onChange(effectiveSettings({ ...s, ...patch }, {}));
  const isPro = pro.value;
  const models = modelsFor(s.engine, s.kind);
  const videoModels = modelsFor(s.engine, 'video');

  return (
    <div class={`gen-editor ${compact ? 'compact' : ''}`}>
      <Field label={t('Engine')}>
        <Select
          value={s.engine}
          options={ENGINES.map((e) => ({ ...e, label: e.value !== 'flow' && !isPro ? `${e.label} · PRO` : e.label }))}
          onChange={(engine) => {
            const first = modelsFor(engine, s.kind)[0] ?? MODELS.find((x) => x.engine === engine)!;
            set({ engine, kind: first.kind, model: first.id });
          }}
        />
      </Field>
      <Field label={t('Type')}>
        <Select<MediaKind>
          value={s.kind}
          options={[
            { value: 'image', label: t('Image') },
            { value: 'video', label: t('Video') }
          ]}
          onChange={(kind) => set({ kind, model: modelsFor(s.engine, kind)[0]?.id ?? s.model })}
        />
      </Field>
      <Field label={t('Model')}>
        <Select
          value={s.model}
          options={models.map((x) => ({ value: x.id, label: x.pro && !isPro && x.engine === 'flow' ? `${x.label} · PRO` : x.label }))}
          onChange={(model) => set({ model })}
        />
      </Field>
      <Field label={t('Aspect')}>
        <Select value={s.aspect} options={(m?.aspects ?? []).map((a) => ({ value: a, label: a }))} onChange={(aspect) => set({ aspect })} />
      </Field>
      {m && m.counts.length > 1 && (
        <Field label={t('Outputs')}>
          <Select value={s.count} options={m.counts.map((c) => ({ value: c, label: `×${c}` }))} onChange={(count) => set({ count })} />
        </Field>
      )}
      {s.kind === 'video' && m?.videoModes && m.videoModes.length > 1 && (
        <Field label={t('Video mode')}>
          <Select<VideoMode> value={s.videoMode} options={m.videoModes.map((v) => ({ value: v, label: modeLabel(v) }))} onChange={(videoMode) => set({ videoMode })} />
        </Field>
      )}
      {m?.durations && (
        <Field label={t('Duration')}>
          <Select value={s.duration ?? m.durations[0]} options={m.durations.map((d) => ({ value: d, label: `${d}s` }))} onChange={(duration) => set({ duration })} />
        </Field>
      )}
      {m?.resolutions && m.resolutions.length > 1 && (
        <Field label={t('Resolution')}>
          <Select value={s.resolution ?? m.resolutions[0]} options={m.resolutions.map((r) => ({ value: r, label: r }))} onChange={(resolution) => set({ resolution })} />
        </Field>
      )}
      {s.kind === 'image' && videoModels.length > 0 && !compact && (
        <Field label={t('Animate with')} hint={t('Used by rows that have a motion prompt')}>
          <Select
            value={s.motionModel && modelById(s.motionModel)?.engine === s.engine ? s.motionModel : videoModels[0].id}
            options={videoModels.map((x) => ({ value: x.id, label: x.label }))}
            onChange={(motionModel) => set({ motionModel })}
          />
        </Field>
      )}
      {s.engine !== 'flow' && !compact && (
        <>
          <Field label={t('Negative prompt')}>
            <input type="text" value={s.negative ?? ''} placeholder={t('What to avoid (optional)')} onChange={(e) => set({ negative: (e.target as HTMLInputElement).value })} />
          </Field>
          <Field label={t('Seed')}>
            <NumberInput value={s.seed ?? 0} min={0} max={MAX_SEED} integer onChange={(v) => set({ seed: v || undefined })} width={110} />
          </Field>
        </>
      )}
      <div class="cost-line">
        {t('Per prompt')}: <b>{costLabel(s)}</b>
        {m?.note && <span class="muted"> · {t(m.note)}</span>}
      </div>
    </div>
  );
}

/** The fields of `next` that differ from `base` (row overrides). */
export function diffSettings(base: GenSettings, next: GenSettings): Partial<GenSettings> {
  const out: Partial<GenSettings> = {};
  for (const k of Object.keys(next) as (keyof GenSettings)[]) {
    if (JSON.stringify(next[k]) !== JSON.stringify(base[k])) (out as Record<string, unknown>)[k] = next[k];
  }
  return out;
}
