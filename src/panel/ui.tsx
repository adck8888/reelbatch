import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { getAsset, putAsset } from '../shared/idb';
import { send, type PanelRequest } from '../shared/messages';
import { errText } from '../shared/util';
import { t } from './i18n';

// ---------- toasts ----------

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'ok';
  text: string;
}
export const toasts = signal<Toast[]>([]);
let toastId = 0;

export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4500) {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, kind, text }];
  setTimeout(() => (toasts.value = toasts.value.filter((x) => x.id !== id)), kind === 'error' ? ms * 2 : ms);
}

/** Send a request to the worker; errors become a toast and resolve to null. */
export async function call<T>(msg: PanelRequest, okText?: string): Promise<T | null> {
  try {
    const r = await send<T>(msg);
    if (okText) toast(okText, 'ok');
    return r;
  } catch (e) {
    toast(errText(e), 'error');
    return null;
  }
}

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((x) => (
        <div key={x.id} class={`toast ${x.kind}`} onClick={() => (toasts.value = toasts.value.filter((y) => y.id !== x.id))}>
          {x.text}
        </div>
      ))}
    </div>
  );
}

// ---------- icons (inline, stroke) ----------

const PATHS: Record<string, string> = {
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7zM13 4h4v16h-4z',
  stop: 'M6 6h12v12H6z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  image: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M15 9h.01',
  video: 'M3 6h12v12H3zM15 10l6-4v12l-6-4',
  link: 'M10 14l4-4M8 12l-3 3a3 3 0 004 4l3-3M16 12l3-3a3 3 0 00-4-4l-3 3',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  clock: 'M12 7v5l3 2M12 21a9 9 0 110-18 9 9 0 010 18z',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-1-3-2 .3-1.5-1.5L17 5l-3-1-1 2h-2L10 4 7 5l.5 2.3L6 8.8 4 8.5 3 11.5l2 1-.1 1.5L3 15l1 3 2-.3 1.5 1.5L7 21.5l3 1 1-2h2l1 2 3-1-.5-2.2 1.5-1.5 2 .2 1-3-2-1z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',
  key: 'M15 7a4 4 0 11-4 4M11 11l-8 8M6 16l2 2M8 14l2 2',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z',
  info: 'M12 21a9 9 0 110-18 9 9 0 010 18zM12 11v5M12 8h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  chevron: 'M9 6l6 6-6 6',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 018 0v3',
  rocket: 'M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 15l-3-3c1-4 4-8 11-9-1 7-5 10-9 11zM14 10h.01',
  toggle: 'M8 7h8a5 5 0 010 10H8A5 5 0 018 7zM8 15a3 3 0 100-6 3 3 0 000 6z'
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg class="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

// ---------- controls ----------

type BtnProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'icon'> & { icon?: string; variant?: 'primary' | 'ghost' | 'danger' | 'default'; small?: boolean; disabled?: boolean };

export function Button({ icon, variant = 'default', small, children, class: cls, ...rest }: BtnProps) {
  return (
    <button type="button" class={`btn ${variant} ${small ? 'sm' : ''} ${!children ? 'icon-only' : ''} ${cls ?? ''}`} {...rest}>
      {icon && <Icon name={icon} size={small ? 14 : 16} />}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Field({ label, hint, children, inline, tip }: { label: ComponentChildren; hint?: ComponentChildren; children: ComponentChildren; inline?: boolean; tip?: string }) {
  return (
    <label class={`field ${inline ? 'inline' : ''}`}>
      <span class="label">
        {label}
        {tip && <Tip text={tip} />}
      </span>
      {children}
      {hint && <span class="hint">{hint}</span>}
    </label>
  );
}

export function Select<T extends string | number>({ value, options, onChange, disabled, title }: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <select
      value={String(value)}
      disabled={disabled}
      title={title}
      onChange={(e) => {
        const raw = (e.target as HTMLSelectElement).value;
        const opt = options.find((o) => String(o.value) === raw);
        if (opt) onChange(opt.value);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function NumberInput({ value, min, max, step = 1, onChange, width, integer }: { value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void; width?: number; integer?: boolean }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      style={width ? { width: `${width}px` } : undefined}
      onChange={(e) => {
        const input = e.currentTarget as HTMLInputElement;
        let v = parseFloat(input.value);
        if (!Number.isFinite(v)) v = min ?? 0;
        if (integer) v = Math.trunc(v);
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
        // show the clamped number even when it equals the old value and nothing re-renders
        input.value = String(v);
        onChange(v);
      }}
    />
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ComponentChildren; disabled?: boolean }) {
  return (
    <label class={`toggle ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span class="track" />
      <span>{label}</span>
    </label>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ComponentChildren; footer?: ComponentChildren; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div class="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <Button icon="x" variant="ghost" small onClick={onClose} aria-label={t('Close')} />
        </header>
        <div class="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

/** A small ⓘ with a tooltip; for controls whose effect is not obvious from the label. */
export function Tip({ text }: { text: string }) {
  return (
    <span class="tip" title={text} aria-label={text} role="img" tabIndex={0}>
      <Icon name="info" size={13} />
    </span>
  );
}

export function ProBadge() {
  return <span class="pro-badge">PRO</span>;
}

// ---------- images from IndexedDB ----------

const urlCache = new Map<string, string>();

export function useAssetUrl(id?: string) {
  const [url, setUrl] = useState<string | undefined>(id ? urlCache.get(id) : undefined);
  useEffect(() => {
    if (!id) return setUrl(undefined);
    if (/^(https?:|data:)/.test(id)) return setUrl(id);
    const cached = urlCache.get(id);
    if (cached) return setUrl(cached);
    let alive = true;
    getAsset(id).then((a) => {
      if (!a || !alive) return;
      const u = URL.createObjectURL(a.blob);
      urlCache.set(id, u);
      setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [id]);
  return url;
}

export function Thumb({ id, size = 40, onRemove, title }: { id?: string; size?: number; onRemove?: () => void; title?: string }) {
  const url = useAssetUrl(id);
  return (
    <span class="thumb" style={{ width: `${size}px`, height: `${size}px` }} title={title}>
      {url ? <img src={url} alt="" /> : <Icon name="image" size={Math.round(size / 2.5)} />}
      {onRemove && (
        <button type="button" class="thumb-x" onClick={(e) => (e.stopPropagation(), onRemove())} aria-label={t('Remove')}>
          ×
        </button>
      )}
    </span>
  );
}

/** Pick image files and store them as assets; returns the new asset ids. */
export function pickImages(multiple = true): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.multiple = multiple;
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      resolve(await Promise.all(files.map((f) => putAsset(f, f.name))));
    };
    input.click();
  });
}

export async function imagesFromDrop(e: DragEvent): Promise<string[]> {
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  return Promise.all(files.map((f) => putAsset(f, f.name)));
}

export function copyText(text: string) {
  void navigator.clipboard.writeText(text).then(() => toast(t('Copied'), 'ok'));
}
