import { useEffect, useState } from 'preact/hooks';
import { PRO } from '../shared/license';
import { t } from './i18n';
import { plan, ready, run, saveSettings, settings, tab, trialLeft, usedToday, type Tab } from './store';
import { Button, Icon, Toasts, call } from './ui';
import { QueueView } from './views/Queue';
import { CharactersView } from './views/Characters';
import { HistoryView } from './views/History';
import { SettingsView } from './views/Settings';

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: 'queue', icon: 'list', label: 'Queue' },
  { id: 'characters', icon: 'user', label: 'Characters' },
  { id: 'history', icon: 'grid', label: 'History' },
  { id: 'settings', icon: 'gear', label: 'Settings' }
];

export function App() {
  const s = settings.value;
  useEffect(() => {
    const root = document.documentElement;
    if (s.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = s.theme;
  }, [s.theme]);

  if (!ready.value) return <div class="loading">Reelbatch…</div>;
  if (!s.onboarded) return <Onboarding />;

  const r = run.value;
  return (
    <div class="app">
      <header class="top">
        <div class="brand">
          <Logo />
          <b>Reelbatch</b>
        </div>
        <PlanBadge />
        {r.status !== 'idle' && tab.value !== 'queue' && (
          <button type="button" class={`run-chip ${r.status}`} onClick={() => (tab.value = 'queue')}>
            {r.status === 'running' ? <span class="dot" /> : null}
            {r.status === 'running' ? t('Running') : r.status === 'paused' ? t('Paused') : r.status === 'cooldown' ? t('Cooling down') : t('Stopping')}
          </button>
        )}
      </header>
      <nav class="tabs" role="tablist">
        {TABS.map((x) => (
          <button type="button" role="tab" aria-selected={tab.value === x.id} key={x.id} class={tab.value === x.id ? 'on' : ''} onClick={() => (tab.value = x.id)}>
            <Icon name={x.icon} size={15} />
            <span>{t(x.label)}</span>
          </button>
        ))}
      </nav>
      <main>
        {tab.value === 'queue' && <QueueView />}
        {tab.value === 'characters' && <CharactersView />}
        {tab.value === 'history' && <HistoryView />}
        {tab.value === 'settings' && <SettingsView />}
      </main>
      <Toasts />
    </div>
  );
}

function PlanBadge() {
  const p = plan.value;
  const label = p === 'pro' ? 'Pro' : p === 'trial' ? t('Trial · {n}d', { n: trialLeft.value }) : t('Free · {n}/{max}', { n: usedToday.value, max: PRO.freePerDay });
  return (
    <button type="button" class={`plan-badge ${p}`} onClick={() => (tab.value = 'settings')} title={t('Plan')}>
      {label}
    </button>
  );
}

function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="5" width="15" height="14" rx="3" fill="var(--accent)" />
      <rect x="6" y="3" width="15" height="14" rx="3" fill="none" stroke="var(--accent)" stroke-width="1.6" opacity=".55" />
      <path d="M8 9.5v5l4.5-2.5z" fill="var(--on-accent)" />
    </svg>
  );
}

function Onboarding() {
  const [step, setStep] = useState(0);
  const finish = () => saveSettings((x) => void (x.onboarded = true));
  const steps = [
    {
      title: t('Batch-generate in Google Flow'),
      body: (
        <>
          <p>{t('Paste a list of prompts, press Run, and Reelbatch generates them one by one in your Flow tab — images and videos, every model and mode — and saves each file with a clear name.')}</p>
          <p class="muted">{t('Free: {n} prompts a day with every Flow model. Pro adds unlimited runs, parallel tabs, characters, chaining, API models and more.', { n: PRO.freePerDay })}</p>
        </>
      )
    },
    {
      title: t('Open a Flow project'),
      body: (
        <>
          <p>{t('Sign in to Flow with your Google account and open (or create) a project. Reelbatch works inside that tab with your own plan and credits.')}</p>
          <Button icon="external" onClick={() => call({ type: 'flow:open' })}>
            {t('Open Flow')}
          </Button>
        </>
      )
    },
    {
      title: t('About the “started debugging” bar'),
      body: (
        <>
          <p>{t('Flow only accepts real clicks. While a run is going, Reelbatch uses Chrome’s built-in input automation, so Chrome shows a bar: “Reelbatch started debugging this browser”.')}</p>
          <p>{t('That is expected. Reelbatch only types the prompt and presses Generate in Flow tabs, and lets go when the run ends. Clicking “Cancel” on the bar stops the run.')}</p>
          <p class="muted">{t('Keep DevTools closed on the Flow tab during a run.')}</p>
        </>
      )
    }
  ];
  const cur = steps[step];
  return (
    <div class="onboarding">
      <div class="brand big">
        <Logo />
        <b>Reelbatch</b>
      </div>
      <div class="steps">
        {steps.map((_, i) => (
          <span key={i} class={i <= step ? 'on' : ''} />
        ))}
      </div>
      <h2>{cur.title}</h2>
      <div class="ob-body">{cur.body}</div>
      <div class="row-wrap">
        {step > 0 && <Button onClick={() => setStep(step - 1)}>{t('Back')}</Button>}
        <span class="grow" />
        {step < steps.length - 1 ? (
          <Button variant="primary" onClick={() => setStep(step + 1)}>
            {t('Next')}
          </Button>
        ) : (
          <Button variant="primary" onClick={finish}>
            {t('Start')}
          </Button>
        )}
      </div>
      <button type="button" class="link muted" onClick={finish}>
        {t('Skip')}
      </button>
    </div>
  );
}
