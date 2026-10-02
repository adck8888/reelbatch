import { useEffect, useState } from 'preact/hooks';
import type { ApiKeys } from '../../shared/types';
import type { HealthReport as Health } from '../../shared/messages';
import { PRO } from '../../shared/license';
import { renderName } from '../../shared/template';
import { t, LANGS } from '../i18n';
import { license, logs, plan, pro, queue, queueIndex, saveSettings, schedule, settings, trialLeft, usedToday } from '../store';
import { Button, Field, Icon, NumberInput, ProBadge, Select, Toggle, call, copyText, toast } from '../ui';

declare const __VERSION__: string;

const ISSUES_URL = 'https://github.com/adck8888/reelbatch/issues/new';

export function SettingsView() {
  return (
    <div class="settings-view">
      <LicenseCard />
      <RunCard />
      <DownloadCard />
      <KeysCard />
      <ScheduleCard />
      <AppCard />
      <DiagnosticsCard />
    </div>
  );
}

function Card({ title, children, badge }: { title: string; children: preact.ComponentChildren; badge?: boolean }) {
  return (
    <section class="card">
      <h3>
        {title} {badge && !pro.value && <ProBadge />}
      </h3>
      {children}
    </section>
  );
}

// ---------- licence ----------

function LicenseCard() {
  const l = license.value;
  const p = plan.value;
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const activate = async () => {
    setBusy(true);
    await call({ type: 'license:activate', key }, t('Pro activated. Thank you!'));
    setBusy(false);
    setKey('');
  };
  return (
    <Card title={t('Plan')}>
      {p === 'pro' && (
        <div class="plan pro">
          <Icon name="check" /> <b>Reelbatch Pro</b> {l.plan && <span class="muted">· {l.plan}</span>}
          <div class="row-wrap">
            <span class="muted">{t('Key')} …{l.key?.slice(-6)}</span>
            <span class="grow" />
            <Button small variant="ghost" onClick={() => call({ type: 'license:refresh' }, t('Licence checked'))}>
              {t('Check now')}
            </Button>
            <Button small variant="ghost" onClick={() => confirm(t('Remove the licence from this browser? You can activate it again later.')) && call({ type: 'license:deactivate' })}>
              {t('Deactivate')}
            </Button>
          </div>
        </div>
      )}
      {p === 'trial' && (
        <div class="plan trial">
          <b>{t('Pro trial')}</b> · {t('{n} days left', { n: trialLeft.value })}
        </div>
      )}
      {p === 'free' && (
        <div class="plan free">
          <b>{t('Free')}</b> {t('{n} of {max} prompts used today', { n: usedToday.value, max: PRO.freePerDay })}
          {l.key && l.error && <div class="err">{t('Licence problem')}: {l.error}</div>}
        </div>
      )}
      {p !== 'pro' && (
        <>
          <ul class="pro-list">
            <li>{t('Unlimited prompts per day')}</li>
            <li>{t('Parallel runs and several Flow tabs')}</li>
            <li>{t('Characters, chaining and image→video')}</li>
            <li>{t('Gemini API and Replicate with your own keys')}</li>
            <li>{t('Upscaled downloads, ZIP export, scheduler, AI prompt helper')}</li>
            <li>{t('Google Sheets, XLSX and JSON import')}</li>
          </ul>
          <div class="row-wrap">
            <Button variant="primary" onClick={() => chrome.tabs.create({ url: PRO.lifetimeUrl })}>
              {t('{price} — lifetime', { price: PRO.lifetimePrice })}
            </Button>
            <Button onClick={() => chrome.tabs.create({ url: PRO.monthlyUrl })}>{PRO.monthlyPrice}</Button>
            {!l.trialStartedAt && (
              <Button variant="ghost" onClick={() => call({ type: 'license:trial' }, t('Trial started: 7 days of Pro'))}>
                {t('Start 7-day trial')}
              </Button>
            )}
          </div>
          <div class="row-wrap">
            <input type="text" class="grow" value={key} placeholder={t('Licence key from your email')} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
            <Button disabled={busy || key.trim().length < 16} onClick={activate}>
              {busy ? t('Checking…') : t('Activate')}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------- run options ----------

function RunCard() {
  const o = settings.value.run;
  const set = (fn: (r: typeof o) => void) => saveSettings((s) => fn(s.run));
  const [tabs, setTabs] = useState<FlowTab[]>([]);
  useEffect(() => {
    void call<FlowTab[]>({ type: 'flow:tabs' }).then((x) => x && setTabs(x));
  }, []);
  return (
    <Card title={t('Running')}>
      <div class="grid2">
        <Field label={t('Pause between prompts, seconds')} hint={t('A random pause in this range makes the run look human')}>
          <span class="range">
            <NumberInput value={o.delayMin} min={0} max={600} width={64} onChange={(v) => set((r) => void ((r.delayMin = v), (r.delayMax = Math.max(v, r.delayMax))))} />
            –
            <NumberInput value={o.delayMax} min={0} max={900} width={64} onChange={(v) => set((r) => void ((r.delayMax = Math.max(v, r.delayMin))))} />
          </span>
        </Field>
        <Field label={t('Reading pause per 100 characters, s')}>
          <NumberInput value={o.readingPause} min={0} max={30} step={0.5} width={64} onChange={(v) => set((r) => void (r.readingPause = v))} />
        </Field>
        <Field label={<>{t('Prompts at the same time')} {!pro.value && <ProBadge />}</>} hint={t('Flow renders several prompts in parallel; 2–3 is a safe maximum per tab')}>
          <NumberInput value={o.concurrency} min={1} max={8} width={64} onChange={(v) => set((r) => void (r.concurrency = v))} />
        </Field>
        <Field label={t('Retries per prompt')}>
          <NumberInput value={o.retries} min={0} max={5} width={64} onChange={(v) => set((r) => void (r.retries = v))} />
        </Field>
        <Field label={t('Pause after failures in a row')} hint={t('0 = never')}>
          <NumberInput value={o.stopAfterFails} min={0} max={50} width={64} onChange={(v) => set((r) => void (r.stopAfterFails = v))} />
        </Field>
        <Field label={t('Credit budget per run')} hint={t('Stops before spending more Flow credits. 0 = no limit')}>
          <NumberInput value={o.budgetCredits} min={0} width={90} onChange={(v) => set((r) => void (r.budgetCredits = v))} />
        </Field>
        <Field label={t('API budget per run, $')} hint={t('0 = no limit')}>
          <NumberInput value={o.budgetUsd} min={0} step={0.5} width={90} onChange={(v) => set((r) => void (r.budgetUsd = v))} />
        </Field>
      </div>
      <Field label={<>{t('Flow tabs to use')} {!pro.value && <ProBadge />}</>} hint={t('Open several Flow projects in tabs to spread a big run over them. None selected = the current Flow tab.')}>
        <div class="stack tight">
          {tabs.length === 0 && <span class="muted">{t('No Flow tabs open')}</span>}
          {tabs.map((tb) => (
            <Toggle
              key={tb.id}
              checked={o.tabs.includes(tb.id)}
              disabled={!pro.value && !o.tabs.includes(tb.id) && o.tabs.length >= 1}
              onChange={(on) => set((r) => void (r.tabs = on ? [...r.tabs, tb.id] : r.tabs.filter((x) => x !== tb.id)))}
              label={tabLabel(tb)}
            />
          ))}
          <div>
            <Button small variant="ghost" icon="external" onClick={() => call({ type: 'flow:open' })}>
              {t('Open Flow')}
            </Button>
          </div>
        </div>
      </Field>
    </Card>
  );
}

// ---------- downloads ----------

function DownloadCard() {
  const d = settings.value.run.download;
  const set = (fn: (x: typeof d) => void) => saveSettings((s) => fn(s.run.download));
  const example = (() => {
    const ctx = { n: 7, total: 120, prompt: 'A red fox jumping over a frozen river at dawn', model: 'Veo 3.1 Fast', queue: queue.value?.name ?? 'Queue 1', variant: 1, kind: 'video' };
    return `${renderName(d.folder, ctx)}/${renderName(d.filename, ctx)}.mp4`;
  })();
  return (
    <Card title={t('Downloads')}>
      <Toggle checked={d.enabled} onChange={(v) => set((x) => void (x.enabled = v))} label={t('Save every result to Downloads automatically')} />
      {d.enabled && (
        <>
          <div class="grid2">
            <Field label={t('Folder')}>
              <input type="text" value={d.folder} onChange={(e) => set((x) => void (x.folder = (e.target as HTMLInputElement).value || 'Reelbatch'))} />
            </Field>
            <Field label={t('File name')}>
              <input type="text" value={d.filename} onChange={(e) => set((x) => void (x.filename = (e.target as HTMLInputElement).value || '{n}'))} />
            </Field>
          </div>
          <p class="hint">
            {t('Tokens')}: {'{n} {prompt} {prompt30} {model} {queue} {variant} {kind} {date} {time}'} + {t('imported column names')}
            <br />
            {t('Example')}: <code>{example}</code>
          </p>
          <div class="grid2">
            <Field label={<>{t('Image quality (Flow)')} {!pro.value && <ProBadge />}</>}>
              <Select
                value={d.imageQuality}
                options={[
                  { value: '1k', label: t('Original (1K)') },
                  { value: '2k', label: '2K' },
                  { value: '4k', label: t('4K (paid Flow plans)') }
                ]}
                onChange={(v) => set((x) => void (x.imageQuality = v))}
              />
            </Field>
            <Field label={<>{t('Video quality (Flow)')} {!pro.value && <ProBadge />}</>}>
              <Select
                value={d.videoQuality}
                options={[
                  { value: '720p', label: t('Original (720p)') },
                  { value: '1080p', label: '1080p' },
                  { value: '4k', label: t('4K (paid Flow plans)') }
                ]}
                onChange={(v) => set((x) => void (x.videoQuality = v))}
              />
            </Field>
          </div>
          <p class="hint">{t('If an upscale is not available on your plan, the original is saved instead.')}</p>
          <Toggle checked={d.sidecar} onChange={(v) => set((x) => void (x.sidecar = v))} label={t('Also save run.csv with prompts, files, links and cost')} />
        </>
      )}
    </Card>
  );
}

// ---------- API keys ----------

function KeysCard() {
  const keys = settings.value.keys;
  return (
    <Card title={t('API keys')} badge>
      <p class="hint">{t('Keys stay in this browser and are sent only to the provider. You pay the provider directly.')}</p>
      <KeyRow provider="gemini" label="Gemini API" link="https://aistudio.google.com/apikey" value={keys.gemini} />
      <KeyRow provider="replicate" label="Replicate" link="https://replicate.com/account/api-tokens" value={keys.replicate} />
    </Card>
  );
}

function KeyRow({ provider, label, link, value }: { provider: keyof ApiKeys; label: string; link: string; value?: string }) {
  const [v, setV] = useState(value ?? '');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (next: string) => saveSettings((s) => void (s.keys[provider] = next.trim() || undefined));
  const test = async () => {
    setBusy(true);
    const r = await call<{ ok: boolean; veo?: string[]; username?: string }>({ type: 'api:test', provider, key: v });
    setBusy(false);
    if (r?.ok) {
      await save(v);
      toast(provider === 'gemini' ? t('Key works. Veo models available: {n}', { n: r.veo?.length ?? 0 }) : t('Key works ({user})', { user: r.username ?? '' }), 'ok');
    }
  };
  return (
    <Field label={label} hint={<a href={link} target="_blank" rel="noreferrer">{t('Get a key')} ↗</a>}>
      <div class="row-wrap">
        {show ? <input type="text" class="grow" value={v} autocomplete="off" spellcheck={false} onInput={(e) => setV((e.target as HTMLInputElement).value)} onBlur={() => save(v)} /> : <input type="password" class="grow" value={v} autocomplete="off" spellcheck={false} onInput={(e) => setV((e.target as HTMLInputElement).value)} onBlur={() => save(v)} />}
        <Button small variant="ghost" onClick={() => setShow(!show)}>
          {show ? t('Hide') : t('Show')}
        </Button>
        <Button small disabled={!v.trim() || busy} onClick={test}>
          {busy ? '…' : t('Test')}
        </Button>
      </div>
    </Field>
  );
}

// ---------- schedule ----------

function ScheduleCard() {
  const s = schedule.value;
  const [when, setWhen] = useState(() => {
    const d = new Date(Date.now() + 3600_000);
    d.setMinutes(0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [qid, setQid] = useState(queue.value?.id ?? '');
  return (
    <Card title={t('Scheduled run')} badge>
      {s?.enabled ? (
        <div class="row-wrap">
          <span>
            {t('“{queue}” starts at {time}', { queue: queueIndex.value.find((x) => x.id === s.queueId)?.name ?? '?', time: new Date(s.at).toLocaleString() })}
          </span>
          <span class="grow" />
          <Button small variant="ghost" onClick={() => call({ type: 'schedule:set', schedule: null }, t('Schedule cancelled'))}>
            {t('Cancel')}
          </Button>
        </div>
      ) : (
        <div class="row-wrap">
          <Select value={qid} options={queueIndex.value.map((x) => ({ value: x.id, label: x.name }))} onChange={setQid} />
          <input type="datetime-local" value={when} onInput={(e) => setWhen((e.target as HTMLInputElement).value)} />
          <Button
            small
            disabled={!pro.value || !qid}
            onClick={() => call({ type: 'schedule:set', schedule: { enabled: true, at: new Date(when).getTime(), queueId: qid, scope: { kind: 'pending' } } }, t('Scheduled'))}
          >
            {t('Schedule')}
          </Button>
        </div>
      )}
      <p class="hint">{t('Chrome must be running and the Flow tab signed in at that time.')}</p>
    </Card>
  );
}

// ---------- app ----------

function AppCard() {
  const s = settings.value;
  return (
    <Card title={t('App')}>
      <div class="grid2">
        <Field label={t('Language')}>
          <Select value={s.lang} options={LANGS.map((l) => ({ value: l.id, label: l.id === 'auto' ? t('Auto') : l.label }))} onChange={(lang) => saveSettings((x) => void (x.lang = lang))} />
        </Field>
        <Field label={t('Theme')}>
          <Select
            value={s.theme}
            options={[
              { value: 'system', label: t('System') },
              { value: 'light', label: t('Light') },
              { value: 'dark', label: t('Dark') }
            ]}
            onChange={(theme) => saveSettings((x) => void (x.theme = theme))}
          />
        </Field>
      </div>
      <Toggle checked={s.notify} onChange={(v) => saveSettings((x) => void (x.notify = v))} label={t('Notify me when a run finishes or pauses')} />
      <Toggle
        checked={s.remoteConfig}
        onChange={(v) => saveSettings((x) => void (x.remoteConfig = v))}
        label={t('Get Flow fixes without waiting for an update (downloads a small selector file from GitHub)')}
      />
    </Card>
  );
}

// ---------- diagnostics ----------

function DiagnosticsCard() {
  const [h, setH] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    setH(await call<Health>({ type: 'flow:health' }));
    setBusy(false);
  };
  const report = () =>
    [
      `Reelbatch ${__VERSION__} · ${navigator.userAgent}`,
      h ? `Health: ${h.items.map((i) => `${i.key}=${i.ok ? 'ok' : 'FAIL'}${i.detail ? ` (${i.detail})` : ''}`).join(', ')} · config ${h.configVersion ?? '?'}` : '',
      ...logs.value.slice(-80).map((l) => `${new Date(l.t).toISOString()} ${l.level.toUpperCase()} ${l.msg}`)
    ].join('\n');

  return (
    <Card title={t('Diagnostics')}>
      <div class="row-wrap">
        <Button small icon="check" disabled={busy} onClick={check}>
          {t('Check Flow tab')}
        </Button>
        <Button small variant="ghost" icon="refresh" onClick={() => call<{ version: string }>({ type: 'config:reload' }).then((r) => r && toast(t('Flow config {v}', { v: r.version }), 'ok'))}>
          {t('Reload Flow config')}
        </Button>
        <Button small variant="ghost" icon="copy" onClick={() => copyText(report())}>
          {t('Copy report')}
        </Button>
        <Button
          small
          variant="ghost"
          icon="external"
          onClick={() => chrome.tabs.create({ url: `${ISSUES_URL}?title=${encodeURIComponent(`Problem in ${__VERSION__}`)}&body=${encodeURIComponent(`${t('What happened:')}\n\n\n---\n\`\`\`\n${report().slice(0, 4000)}\n\`\`\``)}` })}
        >
          {t('Report a problem')}
        </Button>
      </div>
      {h && (
        <ul class="health">
          {h.items.map((i) => (
            <li key={i.key} class={i.ok ? 'ok' : 'bad'}>
              <Icon name={i.ok ? 'check' : 'alert'} size={14} /> <b>{i.key}</b> {i.detail && <span class="muted">{i.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>{t('Log')} ({logs.value.length})</summary>
        <pre class="log">
          {logs.value
            .slice(-200)
            .reverse()
            .map((l) => `${new Date(l.t).toLocaleTimeString()} ${l.level === 'info' ? '' : l.level.toUpperCase() + ' '}${l.msg}`)
            .join('\n')}
        </pre>
      </details>
      <p class="hint">Reelbatch {__VERSION__}</p>
    </Card>
  );
}

interface FlowTab {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

/** Flow gives every tab the same long title, so name tabs by their project instead. */
function tabLabel(tb: FlowTab) {
  const project = tb.url.match(/\/project\/([\w-]{4})/)?.[1];
  return `${project ? `${t('Project')} ${project}…` : t('Flow home')}${tb.active ? ` · ${t('active')}` : ''}`;
}
