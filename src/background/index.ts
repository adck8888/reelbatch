import type { PanelRequest } from '../shared/messages';
import type { Schedule } from '../shared/types';
import { get, getQueue, log, set } from '../shared/storage';
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
  await rearmSchedule();
  if (d.reason === 'install') {
    // Open Flow so the first run has somewhere to work; the side panel explains the rest.
    await chrome.tabs.create({ url: FLOW_URL });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create(ALARM_LICENSE, { periodInMinutes: 12 * 60 });
  await rearmSchedule();
});

/** An update clears alarms, and Chrome may have been closed at the scheduled time. */
async function rearmSchedule() {
  const s = await get('schedule');
  if (!s?.enabled || (await chrome.alarms.get(ALARM_SCHEDULE))) return;
  chrome.alarms.create(ALARM_SCHEDULE, { when: Math.max(s.at, Date.now() + 60_000) });
}

// The worker may have been killed mid-run; mark that run as interrupted and drop stale debugger sessions.
const ready = Promise.all([runner.restore(), detachAll()]).catch(() => {});
void license.refresh();

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === ALARM_LICENSE) await license.refresh();
  if (a.name === ALARM_SCHEDULE) await fireSchedule();
});

/** A run that was due while Chrome was closed starts only if it is at most this late. */
const MAX_LATE = 2 * 60 * 60_000;

async function fireSchedule() {
  const s = await get('schedule');
  if (!s?.enabled) return;
  if ((await get('run')).status !== 'idle') {
    // another run is busy: keep the schedule and look again in a few minutes
    chrome.alarms.create(ALARM_SCHEDULE, { delayInMinutes: 5 });
    await log('info', 'Scheduled run is waiting for the current run to finish');
    return;
  }
  await set('schedule', { ...s, enabled: false });
  try {
    if (Date.now() - s.at > MAX_LATE) throw new Error('Chrome was closed at the scheduled time, so the run was skipped. Schedule it again.');
    // "what is left" of a queue that already finished means the whole queue again
    const scope = s.scope.kind === 'pending' && !(await runner.estimate(s.queueId, s.scope)).rows ? { kind: 'all' as const } : s.scope;
    await runner.start(s.queueId, scope);
    await log('info', 'Scheduled run started');
  } catch (e) {
    await log('error', `Scheduled run could not start: ${errText(e)}`);
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/128.png', title: 'Reelbatch — scheduled run', message: errText(e).slice(0, 250) });
  }
}

async function setSchedule(s: Schedule | null) {
  if (s?.enabled) {
    if (!Number.isFinite(s.at) || s.at <= Date.now()) throw new Error('Pick a time in the future');
    if (!(await getQueue(s.queueId))) throw new Error('Pick a queue to run');
  }
  await chrome.alarms.clear(ALARM_SCHEDULE);
  await set('schedule', s);
  if (s?.enabled) chrome.alarms.create(ALARM_SCHEDULE, { when: s.at });
  return { ok: true };
}

async function needPro(feature: string) {
  if (!isPro(await get('license'))) throw new Error(`${feature} is a Reelbatch Pro feature. Start the free 7-day trial or upgrade in Settings.`);
}

async function handle(m: PanelRequest | { type: 'flow:config' }): Promise<unknown> {
  await ready;
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
    case 'license:refresh': {
      const r = await license.refresh(true);
      if (r === 'offline') throw new Error('Could not reach the licence server. Pro stays active offline for a while; try again later.');
      return { result: r };
    }
    case 'license:trial':
      return { plan: await license.startTrial() };

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
