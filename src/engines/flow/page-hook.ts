// Runs in Flow's own page (MAIN world) at document_start. It only observes responses from
// Flow's batchexecute endpoint and forwards rpc ids plus response text to our content script.
// Request bodies (they carry reCAPTCHA tokens) are never read or forwarded.

(() => {
  const w = window as unknown as { __reelbatchHook?: boolean };
  if (w.__reelbatchHook) return;
  w.__reelbatchHook = true;
  // Visible to the content script (shared DOM): tells the health check the observer is installed.
  document.documentElement.dataset.rbHook = '1';

  const MAX = 4_000_000;
  const interesting = (url: string) => url.includes('/batchexecute');

  const rpcOf = (url: string) => {
    try {
      return new URL(url, location.href).searchParams.get('rpcids') ?? '';
    } catch {
      return '';
    }
  };

  // Each request gets a sequence number: a 'start' message is posted when it is sent and an 'end'
  // message with the response, so the content script can tie a response to the submit that caused it.
  let seq = 0;
  const post = (id: number, phase: 'start' | 'end', url: string, status: number, body: string) => {
    window.postMessage(
      { source: 'reelbatch-hook', id, phase, rpcids: rpcOf(url), status, body: body.length > MAX ? body.slice(0, MAX) : body, t: Date.now() },
      location.origin
    );
  };

  const XHR = XMLHttpRequest.prototype;
  const open = XHR.open;
  const sendX = XHR.send;
  XHR.open = function (this: XMLHttpRequest & { __rbUrl?: string }, method: string, url: string | URL, ...rest: unknown[]) {
    this.__rbUrl = String(url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (open as any).call(this, method, url, ...rest);
  } as typeof XHR.open;
  XHR.send = function (this: XMLHttpRequest & { __rbUrl?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = this.__rbUrl ?? '';
    if (interesting(url)) {
      const id = ++seq;
      post(id, 'start', url, 0, '');
      this.addEventListener('loadend', () => {
        try {
          const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
          post(id, 'end', url, this.status, text);
        } catch {
          /* ignore */
        }
      });
    }
    return sendX.call(this, body);
  };

  const origFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    let url = '';
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    } catch {
      /* ignore */
    }
    const id = interesting(url) ? ++seq : 0;
    if (id) post(id, 'start', url, 0, '');
    let res: Response;
    try {
      res = await origFetch.call(this, input, init);
    } catch (e) {
      if (id) post(id, 'end', url, 0, '');
      throw e;
    }
    if (id) res.clone().text().then((t) => post(id, 'end', url, res.status, t), () => post(id, 'end', url, res.status, ''));
    return res;
  };
  // Flow uploads through a file input it creates and clicks. While the content script attaches
  // reference images it sets data-rb-picker="capture": the native file dialog is skipped and the
  // input is tagged so the content script can hand it the files instead.
  const root = document.documentElement;
  const capture = (input: HTMLInputElement) => {
    if (input.type !== 'file' || root.dataset.rbPicker !== 'capture') return false;
    if (!input.isConnected) {
      input.style.display = 'none';
      document.body.append(input);
    }
    input.dataset.rbPicker = '1';
    return true;
  };
  const IP = HTMLInputElement.prototype;
  const click = IP.click;
  IP.click = function (this: HTMLInputElement) {
    if (!capture(this)) click.call(this);
  };
  const showPicker = IP.showPicker;
  if (showPicker) {
    IP.showPicker = function (this: HTMLInputElement) {
      if (!capture(this)) showPicker.call(this);
    };
  }
})();
