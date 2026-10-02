import { useEffect } from 'preact/hooks';
import { PRO } from '../shared/license';
import { t } from './i18n';
import { flowStatus, loadError, openFlow, plan, ready, run, saveSettings, settings, sheet, showPlans, tab, trialLeft, usedToday, type Tab } from './store';
import { Button, Icon, Modal, Toasts, proBadgeClick } from './ui';
import { QueueView } from './views/Queue';
import { CharactersView } from './views/Characters';
import { HistoryView } from './views/History';
import { SettingsView } from './views/Settings';
import { PlanSheet } from './views/Plan';

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: 'queue', icon: 'list', label: 'Queue' },
  { id: 'history', icon: 'grid', label: 'Results' },
  { id: 'settings', icon: 'gear', label: 'Settings' }
];

proBadgeClick.fn = showPlans;

export function App() {
  const s = settings.value;
  useEffect(() => {
    const root = document.documentElement;
    if (s.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = s.theme;
  }, [s.theme]);

  if (loadError.value)
    return (
      <div class="loading">
        {t('Reelbatch could not start: {x}', { x: loadError.value })}
        <br />
        <button class="btn" onClick={() => location.reload()}>{t('Reload')}</button>
      </div>
    );
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
        <span class="grow" />
        {r.status !== 'idle' && tab.value !== 'queue' && (
          <button type="button" class={`run-chip ${r.status}`} onClick={() => (tab.value = 'queue')}>
            {r.status === 'running' ? <span class="dot" /> : null}
            {r.status === 'running' ? t('Running') : r.status === 'paused' ? t('Paused') : r.status === 'cooldown' ? t('Cooling down') : t('Stopping')}
          </button>
        )}
        <FlowPill />
        <PlanBadge />
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
        {tab.value === 'history' && <HistoryView />}
        {tab.value === 'settings' && <SettingsView />}
      </main>
      {sheet.value === 'plan' && <PlanSheet onClose={() => (sheet.value = null)} />}
      {sheet.value === 'characters' && (
        <Modal title={t('Characters')} onClose={() => (sheet.value = null)} sheet wide>
          <CharactersView />
        </Modal>
      )}
      <Toasts />
    </div>
  );
}

function PlanBadge() {
  const p = plan.value;
  const label = p === 'pro' ? 'Pro' : p === 'trial' ? t('Trial · {n}d', { n: trialLeft.value }) : t('Free · {n}/{max}', { n: usedToday.value, max: PRO.freePerDay });
  return (
    <button type="button" class={`plan-badge ${p}`} onClick={showPlans} title={t('Compare Free and Pro')}>
      {label}
    </button>
  );
}

/** Live Flow status: green = a project is open, amber = Flow without a project, red = no Flow tab. Click opens / focuses Flow. */
export function FlowPill({ long }: { long?: boolean }) {
  const f = flowStatus.value;
  const state = f?.state ?? 'none';
  const text = state === 'project' ? t('Flow: project open') : state === 'tab' ? t('Flow tab open, no project') : t('Flow not open');
  const action = state === 'project' ? t('Show the Flow tab') : state === 'tab' ? t('Open a project in the Flow tab') : t('Open Flow');
  return (
    <button type="button" class={`flow-pill ${state} ${long ? 'long' : ''}`} onClick={() => void openFlow()} title={action} aria-label={`${text}. ${action}`}>
      <span class="status-dot" />
      <span class="flow-pill-text">{text}</span>
      {/* the header pill falls back to a two-word label below 380 px (panel.css hides one of the two) */}
      {!long && <span class="flow-pill-text short">{state === 'project' ? t('Flow') : state === 'tab' ? t('No project') : t('Flow off')}</span>}
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

/** One screen: the three steps, with the live Flow status under the first one. */
function Onboarding() {
  const finish = () => saveSettings((x) => void (x.onboarded = true));
  const f = flowStatus.value;
  const flowOk = f?.state === 'project';
  const steps: { icon: string; title: string; body: preact.ComponentChildren }[] = [
    {
      icon: 'external',
      title: t('Open a Flow project'),
      body: (
        <>
          <p>{t('Sign in to Flow with your Google account and open (or create) a project. Reelbatch works inside that tab with your own plan and credits.')}</p>
          <div class="row-wrap ob-flow">
            <FlowPill long />
            {!flowOk && (
              <Button small icon="external" onClick={() => void openFlow()}>
                {f?.state === 'tab' ? t('Show Flow') : t('Open Flow')}
              </Button>
            )}
          </div>
        </>
      )
    },
    {
      icon: 'list',
      title: t('Paste prompts'),
      body: <p>{t('One prompt per line, or import a file, a sheet or a folder of photos. Every Flow model and mode works.')}</p>
    },
    {
      icon: 'play',
      title: t('Run'),
      body: <p>{t('Reelbatch types each prompt into Flow, waits for the result and saves every file with a clear name.')}</p>
    }
  ];
  return (
    <div class="onboarding">
      <div class="brand big">
        <Logo />
        <b>Reelbatch</b>
      </div>
      <h2>{t('Batch-generate in Google Flow')}</h2>
      <p class="muted center">{t('Free: {n} prompts a day with every Flow model. Pro adds unlimited runs, parallel tabs, characters, chaining, API models and more.', { n: PRO.freePerDay })}</p>
      <ol class="ob-steps">
        {steps.map((s, i) => (
          <li key={i} class={i === 0 && flowOk ? 'done' : ''}>
            <span class="ob-n">{i === 0 && flowOk ? <Icon name="check" size={14} /> : i + 1}</span>
            <div class="ob-text">
              <b>
                <Icon name={s.icon} size={14} /> {s.title}
              </b>
              {s.body}
            </div>
          </li>
        ))}
      </ol>
      <Button variant="primary" class="big" onClick={finish}>
        {t('Start')}
      </Button>
      <button type="button" class="link muted" onClick={finish}>
        {t('Skip')}
      </button>
    </div>
  );
}
