import type { PanelRequest } from '../shared/messages';
import type { Schedule } from '../shared/types';
import { get, log, set } from '../shared/storage';
import { isPro } from '../shared/license';
import { errText } from '../shared/util';
import { flowConfig } from './config';
import { FLOW_URL, flowTabs, health, openFlowTab } from './flow';
import { detachAll } from './debugger';
import * as runner from './runner';
import * as license from './license';
import { runHelper } from './helper';
import { testGeminiKey } from '../engines/api/gemini';
import { testReplicateKey } from '../engines/api/replicate';
import './downloads';

const ALARM_LICENSE = 'rb-license';
const ALARM_SCHEDULE = 'rb-schedule';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(async (d) => {
  chrome.alarms.create(ALARM_LICENSE, { periodInMinutes: 12 * 60 });
  if (d.reason === 'install') {
    // Open Flow so the first run has somewhere to work; the side panel explains the rest.
    await chrome.tabs.create({ url: FLOW_URL });
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_LICENSE, { periodInMinutes: 12 * 60 });
});

// The worker may have been killed mid-run; mark that run as interrupted and drop stale debugger sessions.
void runner.restore();
void detachAll();
void license.refresh();

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === ALARM_LICENSE) await license.refresh();
  if (a.name === ALARM_SCHEDULE) await fireSchedule();
});

async function fireSchedule() {
  const s = await get('schedule');
  if (!s?.enabled) return;
  await set('schedule', { ...s, enabled: false });
  try {
    await runner.start(s.queueId, s.scope);
    await log('info', 'Scheduled run started');
  } catch (e) {
    await log('error', `Scheduled run could not start: ${errText(e)}`);
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/128.png', title: 'Reelbatch — scheduled run', message: errText(e).slice(0, 250) });
  }
}

async function setSchedule(s: Schedule | null) {
  await chrome.alarms.clear(ALARM_SCHEDULE);
  await set('schedule', s);
  if (s?.enabled) {
    if (s.at <= Date.now()) throw new Error('Pick a time in the future');
    chrome.alarms.create(ALARM_SCHEDULE, { when: s.at });
  }
  return { ok: true };
}

async function needPro(feature: string) {
  if (!isPro(await get('license'))) throw new Error(`${feature} is a Reelbatch Pro feature. Start the free 7-day trial or upgrade in Settings.`);
}

async function handle(m: PanelRequest | { type: 'flow:config' }): Promise<unknown> {
  switch (m.type) {
    case 'flow:config':
      return flowConfig();
    case 'config:reload':
      return { version: (await flowConfig(true)).version };

    case 'run:start':
      await runner.start(m.queueId, m.scope);
      return { ok: true };
    case 'run:pause':
      await runner.pause();
      return { ok: true };
    case 'run:resume':
      await runner.resume();
      return { ok: true };
    case 'run:stop':
      await runner.stop();
      return { ok: true };
    case 'run:estimate':
      return runner.estimate(m.queueId, m.scope);

    case 'flow:tabs':
      return (await flowTabs()).map((t) => ({ id: t.id, title: t.title ?? 'Flow', url: t.url ?? '', active: t.active }));
    case 'flow:open': {
      const [existing] = await flowTabs();
      if (existing?.id) {
        await chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
        return { tabId: existing.id };
      }
      return { tabId: await openFlowTab(true) };
    }
    case 'flow:health':
      return health(m.tabId);

    case 'license:activate':
      await license.activate(m.key);
      return { ok: true };
    case 'license:deactivate':
      await license.deactivate();
      return { ok: true };
    case 'license:refresh':
      await license.refresh(true);
      return { ok: true };
    case 'license:trial':
      await license.startTrial();
      return { ok: true };

    case 'api:test':
      if (m.provider === 'gemini') return testGeminiKey(m.key.trim());
      return testReplicateKey(m.key.trim());

    case 'helper':
      await needPro('The AI prompt helper');
      return { prompts: await runHelper(m.mode, m.input, m.n, m.lang) };

    case 'export:zip':
      await needPro('ZIP export');
      return runner.exportZip(m.runId);
    case 'export:sidecar':
      return runner.exportSidecar(m.queueId);

    case 'schedule:set':
      if (m.schedule?.enabled) await needPro('Scheduled runs');
      return setSchedule(m.schedule);
  }
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
  if ((m as { target?: string }).target === 'offscreen') return;
  // Only our own pages and our content script on Flow may talk to the worker.
  if (sender.id !== chrome.runtime.id) return;
  handle(m).then(
    (r) => reply(r ?? { ok: true }),
    (e) => reply({ error: errText(e) })
  );
  return true;
});
