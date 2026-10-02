import type { HistoryItem } from './types';
import { uid } from './util';

/** IndexedDB: image assets (references, frames, thumbnails) and the generation history. */

export interface Asset {
  id: string;
  name: string;
  type: string;
  blob: Blob;
  createdAt: number;
}

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('reelbatch', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('history')) {
          const h = d.createObjectStore('history', { keyPath: 'id' });
          h.createIndex('createdAt', 'createdAt');
          h.createIndex('runId', 'runId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => (dbp = null));
  }
  return dbp;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req ? req.result : (undefined as T));
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export async function putAsset(blob: Blob, name = 'image', id = uid()): Promise<string> {
  await tx('assets', 'readwrite', (s) => s.put({ id, name, type: blob.type, blob, createdAt: Date.now() } satisfies Asset));
  return id;
}

export const getAsset = (id: string) => tx<Asset | undefined>('assets', 'readonly', (s) => s.get(id));

export const deleteAsset = (id: string) => tx('assets', 'readwrite', (s) => s.delete(id));

export const listAssetIds = () => tx<IDBValidKey[]>('assets', 'readonly', (s) => s.getAllKeys()) as Promise<string[]>;

/** A ref can be an asset id or a URL (from imported sheets). Returns the image blob. */
export async function resolveRef(ref: string): Promise<Blob> {
  if (/^(https?:|data:)/.test(ref)) {
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`Could not load reference image (${res.status}): ${ref.slice(0, 80)}`);
    return res.blob();
  }
  const a = await getAsset(ref);
  if (!a) throw new Error('A reference image is missing (it was deleted). Re-attach it to the row.');
  return a.blob;
}

export async function addHistory(item: Omit<HistoryItem, 'id' | 'createdAt'> & Partial<Pick<HistoryItem, 'id' | 'createdAt'>>) {
  const full: HistoryItem = { id: uid(), createdAt: Date.now(), ...item };
  await tx('history', 'readwrite', (s) => s.put(full));
  return full;
}

/** Newest first. */
export async function listHistory(limit = 500, query = ''): Promise<HistoryItem[]> {
  const d = await db();
  const q = query.trim().toLowerCase();
  return new Promise((resolve, reject) => {
    const out: HistoryItem[] = [];
    const req = d.transaction('history').objectStore('history').index('createdAt').openCursor(null, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c || out.length >= limit) return resolve(out);
      const v = c.value as HistoryItem;
      if (!q || v.prompt.toLowerCase().includes(q) || v.queueName.toLowerCase().includes(q) || v.model.toLowerCase().includes(q)) out.push(v);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteHistory(ids: string[]) {
  const items = await Promise.all(ids.map((id) => tx<HistoryItem | undefined>('history', 'readonly', (s) => s.get(id))));
  await tx('history', 'readwrite', (s) => {
    for (const id of ids) s.delete(id);
  });
  for (const it of items) {
    if (it?.thumbId) await deleteAsset(it.thumbId).catch(() => {});
    if (it?.assetId) await deleteAsset(it.assetId).catch(() => {});
  }
}

export async function clearHistory() {
  const all = await listHistory(100_000);
  await deleteHistory(all.map((h) => h.id));
}

/** Small JPEG thumbnail for the gallery (images only; videos keep the poster from Flow if available). */
export async function makeThumb(blob: Blob, size = 256): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  } catch {
    return null;
  }
}
