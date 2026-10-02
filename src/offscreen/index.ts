import { zipSync } from 'fflate';
import { getAsset } from '../shared/idb';

/** `idb:<assetId>` reads a blob the service worker stored in IndexedDB (same origin). */
async function loadBlob(url: string): Promise<Blob> {
  if (url.startsWith('idb:')) {
    const a = await getAsset(url.slice(4));
    if (!a) throw new Error('File is no longer stored');
    return a.blob;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.blob();
}

type Msg =
  | { target: 'offscreen'; task: 'blobUrl'; dataUrl: string }
  | { target: 'offscreen'; task: 'blobUrlFromUrl'; url: string }
  | { target: 'offscreen'; task: 'zip'; files: { name: string; url: string }[]; extra: { name: string; text: string }[] }
  | { target: 'offscreen'; task: 'frame'; url: string; which: 'first' | 'last' }
  | { target: 'offscreen'; task: 'revoke'; url: string };

const urls = new Set<string>();

function keep(blob: Blob) {
  const u = URL.createObjectURL(blob);
  urls.add(u);
  // downloads copy the data quickly; free memory after a while
  setTimeout(() => {
    URL.revokeObjectURL(u);
    urls.delete(u);
  }, 10 * 60_000);
  return u;
}

async function frame(url: string, which: 'first' | 'last') {
  const blob = await loadBlob(url);
  const src = URL.createObjectURL(blob);
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = src;
    await new Promise<void>((res, rej) => {
      v.onloadedmetadata = () => res();
      v.onerror = () => rej(new Error('Could not decode the video'));
    });
    const t = which === 'last' ? Math.max(0, v.duration - 0.05) : 0;
    await new Promise<void>((res) => {
      v.onseeked = () => res();
      v.currentTime = t;
    });
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    return c.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(src);
  }
}

async function zip(files: { name: string; url: string }[], extra: { name: string; text: string }[]) {
  const out: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  const uniq = (n: string) => {
    let name = n;
    for (let i = 2; used.has(name); i++) name = n.replace(/(\.\w+)?$/, `_${i}$1`);
    used.add(name);
    return name;
  };
  for (const f of files) {
    try {
      out[uniq(f.name)] = new Uint8Array(await (await loadBlob(f.url)).arrayBuffer());
    } catch {
      /* expired URL: skip the file, the run log still lists it */
    }
  }
  const enc = new TextEncoder();
  for (const e of extra) out[uniq(e.name)] = enc.encode(e.text);
  return keep(new Blob([zipSync(out, { level: 0 })], { type: 'application/zip' }));
}

chrome.runtime.onMessage.addListener((m: Msg, _s, reply) => {
  if (m?.target !== 'offscreen') return;
  (async () => {
    switch (m.task) {
      case 'blobUrl':
        return { url: keep(await loadBlob(m.dataUrl)) };
      case 'blobUrlFromUrl':
        return { url: keep(await loadBlob(m.url)) };
      case 'zip':
        return { url: await zip(m.files, m.extra) };
      case 'frame':
        return { dataUrl: await frame(m.url, m.which) };
      case 'revoke':
        URL.revokeObjectURL(m.url);
        return { ok: true };
    }
  })().then(reply, (e) => reply({ error: e instanceof Error ? e.message : String(e) }));
  return true;
});
