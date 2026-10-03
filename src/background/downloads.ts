import { putAsset, deleteAsset } from '../shared/idb';
import { extFromType } from '../shared/util';
import { offscreen } from './offscreen';

/** Paths we want for downloads we start ourselves, keyed by URL (extension added from the real MIME type). */
const byUrl = new Map<string, string>();
/** Downloads Flow starts from its own menu (upscaled files): first matching download gets the next path. */
interface FlowExpect {
  base: string;
  resolve: (id: number) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const flowQueue: FlowExpect[] = [];

const isFlowDownload = (item: chrome.downloads.DownloadItem) =>
  /^https:\/\/flow-content\.google\//.test(item.url) ||
  /^blob:https:\/\/flow\.google\.com\//.test(item.url) ||
  (/^data:/.test(item.url) && /flow\.google\.com/.test(item.referrer ?? '')) ||
  /flow\.google\.com/.test(item.referrer ?? '');

function extOf(item: chrome.downloads.DownloadItem) {
  const fromName = item.filename.match(/\.(\w{2,5})$/)?.[1];
  return extFromType(item.mime ?? '', fromName ?? 'bin');
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const base = byUrl.get(item.url) ?? byUrl.get(item.finalUrl ?? '');
  if (base) {
    byUrl.delete(item.url);
    suggest({ filename: `${base}.${extOf(item)}`, conflictAction: 'uniquify' });
    return;
  }
  if (flowQueue.length && isFlowDownload(item)) {
    const next = flowQueue.shift()!;
    clearTimeout(next.timer);
    claimed.add(item.id);
    suggest({ filename: `${next.base}.${extOf(item)}`, conflictAction: 'uniquify' });
    next.resolve(item.id);
  }
});

/** Downloads already matched to a slot by onDeterminingFilename. */
const claimed = new Set<number>();

// onDeterminingFilename does not fire when something else decides the path (a download-manager
// extension, a browser under automation): the file then keeps Flow's name, but the run still gets it.
chrome.downloads.onCreated.addListener((item) => {
  if (!isFlowDownload(item)) return;
  setTimeout(() => {
    if (claimed.delete(item.id) || !flowQueue.length) return;
    const next = flowQueue.shift()!;
    clearTimeout(next.timer);
    next.resolve(item.id);
  }, 3000);
});

export interface Saved {
  id: number;
  file: string;
  bytes: number;
}

export function waitComplete(id: number, timeoutMs = 10 * 60_000): Promise<Saved> {
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => {
      chrome.downloads.onChanged.removeListener(listener);
      clearTimeout(timer);
      fn();
    };
    const check = async () => {
      const [it] = await chrome.downloads.search({ id });
      if (!it) return done(() => reject(new Error('Download disappeared')));
      if (it.state === 'complete') {
        if (!it.fileSize && !it.bytesReceived) return done(() => reject(new Error('Downloaded file is empty')));
        done(() => resolve({ id, file: it.filename, bytes: it.fileSize || it.bytesReceived }));
      } else if (it.state === 'interrupted') done(() => reject(new Error(`Download failed: ${it.error ?? 'interrupted'}`)));
    };
    const listener = (d: chrome.downloads.DownloadDelta) => {
      if (d.id === id && (d.state || d.error)) void check();
    };
    const timer = setTimeout(() => done(() => reject(new Error('Download timed out'))), timeoutMs);
    chrome.downloads.onChanged.addListener(listener);
    void check();
  });
}

/** `base` is the relative path without extension, e.g. "Reelbatch/My queue/001_cat". */
export async function downloadUrl(url: string, base: string): Promise<Saved> {
  byUrl.set(url, base);
  try {
    const id = await chrome.downloads.download({ url, conflictAction: 'uniquify', saveAs: false });
    return await waitComplete(id);
  } finally {
    byUrl.delete(url);
  }
}

export async function downloadBlob(blob: Blob, base: string): Promise<Saved> {
  const assetId = await putAsset(blob, base);
  try {
    const { url } = await offscreen<{ url: string }>({ task: 'blobUrlFromUrl', url: `idb:${assetId}` });
    return await downloadUrl(url, base);
  } finally {
    await deleteAsset(assetId).catch(() => {});
  }
}

export async function downloadText(text: string, base: string, mime = 'text/plain') {
  // through a blob: a data: URL is capped at 2 MB, which a long run log can exceed
  return downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), base);
}

/**
 * Register the path for the next download Flow starts itself. `done` resolves with its download id;
 * call `cancel` if the menu click failed so the slot does not catch an unrelated download.
 */
export function expectFlowDownload(base: string, timeoutMs = 180_000) {
  let entry!: FlowExpect;
  const done = new Promise<number>((resolve, reject) => {
    entry = {
      base,
      resolve,
      reject,
      timer: setTimeout(() => {
        drop(entry);
        reject(new Error('Flow did not start the download'));
      }, timeoutMs)
    };
    flowQueue.push(entry);
  });
  done.catch(() => {});
  return {
    done,
    cancel: () => {
      drop(entry);
      clearTimeout(entry.timer);
      entry.reject(new Error('cancelled'));
    }
  };
}

function drop(e: FlowExpect) {
  const i = flowQueue.indexOf(e);
  if (i >= 0) flowQueue.splice(i, 1);
}

export function cancelFlowExpectations() {
  for (const e of flowQueue.splice(0)) {
    clearTimeout(e.timer);
    e.reject(new Error('cancelled'));
  }
}
