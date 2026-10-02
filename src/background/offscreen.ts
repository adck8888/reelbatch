// The service worker has no DOM: video frame grabs, ZIP files and blob URLs go through an offscreen document.

export type OffscreenTask =
  | { task: 'blobUrl'; dataUrl: string }
  | { task: 'blobUrlFromUrl'; url: string }
  | { task: 'zip'; files: { name: string; url: string }[]; extra: { name: string; text: string }[] }
  | { task: 'frame'; url: string; which: 'first' | 'last' }
  | { task: 'revoke'; url: string };

let creating: Promise<void> | null = null;

async function ensure() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.DOM_PARSER],
        justification: 'Create downloadable files (ZIP, run logs) and read the last frame of generated videos for chaining.'
      })
      .finally(() => (creating = null));
  }
  await creating;
}

export async function offscreen<T>(t: OffscreenTask): Promise<T> {
  await ensure();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...t });
  if (res?.error) throw new Error(res.error);
  return res as T;
}
