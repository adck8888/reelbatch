// Trusted input for Flow. Flow ignores script-made clicks on Generate, so the prompt is typed
// and Generate is clicked through the Chrome DevTools Protocol (Input.* only). We attach to the
// Flow tab for the duration of a run and detach as soon as it ends.

const attached = new Set<number>();

let userCancel: ((tabId: number) => void) | undefined;
/** Called when the user closes Chrome's "started debugging this browser" bar (Cancel). */
export const onUserCancel = (fn: (tabId: number) => void) => (userCancel = fn);

chrome.debugger.onDetach.addListener((src, reason) => {
  if (src.tabId === undefined) return;
  attached.delete(src.tabId);
  if (reason === 'canceled_by_user') userCancel?.(src.tabId);
});

const cmd = <T = unknown>(tabId: number, method: string, params?: Record<string, unknown>) =>
  chrome.debugger.sendCommand({ tabId }, method, params) as unknown as Promise<T>;

export async function attach(tabId: number) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/already attached/i.test(m)) {
      attached.add(tabId);
      return;
    }
    if (/another debugger|devtools/i.test(m)) throw new Error('Close DevTools on the Flow tab — Chrome allows only one debugger per tab.');
    throw new Error(`Chrome refused input control for the Flow tab: ${m}`);
  }
  attached.add(tabId);
  // A Flow tab in the background is throttled until its timers nearly stop; keep it running as
  // if it were focused for as long as the run lasts.
  await cmd(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await cmd(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
}

export async function detach(tabId: number) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

/** Drop every session of ours, including ones a previous service worker left behind. */
export async function detachAll() {
  const targets = await chrome.debugger.getTargets().catch(() => [] as chrome.debugger.TargetInfo[]);
  const tabs = new Set([...attached, ...targets.filter((t) => t.attached && t.tabId !== undefined).map((t) => t.tabId!)]);
  attached.clear();
  await Promise.all([...tabs].map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})));
}

export const isAttached = (tabId: number) => attached.has(tabId);

/** Centre of the element matching `selector`, in the viewport coordinates CDP expects (zoom-aware). */
async function centerOf(tabId: number, selector: string) {
  const { root } = await cmd<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument', { depth: 0 });
  const { nodeId } = await cmd<{ nodeId: number }>(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`Element ${selector} not found`);
  await cmd(tabId, 'DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
  const { quads } = await cmd<{ quads: number[][] }>(tabId, 'DOM.getContentQuads', { nodeId });
  const q = quads?.[0];
  if (!q) throw new Error(`Element ${selector} is not visible`);
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const jitter = () => (Math.random() - 0.5) * 4;
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2 + jitter(), y: (Math.min(...ys) + Math.max(...ys)) / 2 + jitter() };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function click(tabId: number, selector: string) {
  const { x, y } = await centerOf(tabId, selector);
  await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await pause(40 + Math.random() * 60);
  await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await pause(50 + Math.random() * 70);
  await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  a: { key: 'a', code: 'KeyA', keyCode: 65 }
};

/** modifiers: 2 = Ctrl, 4 = Meta. */
export async function key(tabId: number, name: keyof typeof KEYS, modifiers = 0) {
  const k = KEYS[name];
  await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
  await pause(30 + Math.random() * 40);
  await cmd(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
}

export async function selectAllAndDelete(tabId: number) {
  const mac = (await chrome.runtime.getPlatformInfo()).os === 'mac';
  await key(tabId, 'a', mac ? 4 : 2);
  await key(tabId, 'Backspace');
}

/** Type text as real input. Long text goes in chunks so Flow's editor keeps up. */
export async function insertText(tabId: number, text: string) {
  // split by code points so an emoji or other surrogate pair is never cut in half
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += 400) chunks.push(chars.slice(i, i + 400).join(''));
  for (const c of chunks) {
    await cmd(tabId, 'Input.insertText', { text: c });
    await pause(20);
  }
}
