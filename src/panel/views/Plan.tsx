import { useState } from 'preact/hooks';
import { PRO } from '../../shared/license';
import { te } from '../errors';
import { t } from '../i18n';
import { license, plan, trialLeft, usedToday } from '../store';
import { Button, Field, Icon, Modal, call, toast } from '../ui';

/** Free vs Pro, the trial and purchase buttons, and licence-key activation. Opened from the plan pill and any PRO badge. */
export function PlanSheet({ onClose }: { onClose: () => void }) {
  const l = license.value;
  const p = plan.value;
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const activate = async () => {
    setBusy(true);
    const ok = await call({ type: 'license:activate', key }, t('Pro activated. Thank you!'));
    setBusy(false);
    // keep the key in the field after a failure so a typo can be fixed instead of pasted again
    if (ok !== null) setKey('');
  };
  return (
    <Modal title={t('Plan')} onClose={onClose} sheet>
      {p === 'pro' && (
        <div class="plan pro">
          <Icon name="check" /> <b>Reelbatch Pro</b> {l.plan && <span class="muted">· {l.plan}</span>}
          <div class="row-wrap">
            <span class="muted">{t('Key')} …{l.key?.slice(-6)}</span>
            <span class="grow" />
            <Button small variant="ghost" onClick={async () => { const r = await call<{ result: string }>({ type: 'license:refresh' }); if (r) toast(r.result === 'invalid' ? t('This licence is no longer valid') : t('Licence checked'), r.result === 'invalid' ? 'error' : 'ok'); }}>
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
          <b>{t('Pro trial')}</b> {t('{n} days left', { n: trialLeft.value })}
        </div>
      )}
      {p === 'free' && l.key && l.error && (
        <div class="plan free">
          <div class="err">{t('Licence problem')}: {te(l.error)}</div>
        </div>
      )}
      {p !== 'pro' && (
        <>
          <PlanCompare />
          <div class="buy">
            {!l.trialStartedAt && (
              <Button variant="primary" class="big trial-btn" onClick={async () => { const r = await call<{ plan: string }>({ type: 'license:trial' }); if (r) toast(r.plan === 'trial' ? t('Trial started: 7 days of Pro') : t('The trial already ran on this Google account'), r.plan === 'trial' ? 'ok' : 'error'); }}>
                {t('Start 7-day trial')}
              </Button>
            )}
            <div class="buy-prices">
              <Button variant={l.trialStartedAt ? 'primary' : 'default'} onClick={() => chrome.tabs.create({ url: PRO.lifetimeUrl })}>
                {t('{price} — lifetime', { price: PRO.lifetimePrice })}
              </Button>
              <Button onClick={() => chrome.tabs.create({ url: PRO.monthlyUrl })}>{t('{price}/month', { price: PRO.monthlyPrice.replace(/\s*\/\s*month$/i, '') })}</Button>
            </div>
            <p class="hint center">{t('{n}-day free trial, no card needed. Cancel the monthly plan any time.', { n: PRO.trialDays })}</p>
          </div>
          <Field label={t('Already bought Pro?')}>
            <div class="row-wrap nowrap">
              <input type="text" class="grow" value={key} placeholder={t('Licence key from your email')} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
              <Button disabled={busy || key.trim().length < 16} onClick={activate}>
                {busy ? t('Checking…') : t('Activate')}
              </Button>
            </div>
          </Field>
        </>
      )}
    </Modal>
  );
}

/** Free vs Pro, framed as what each plan lets you get done. */
function PlanCompare() {
  const free = [
    t('Google Flow with every model'),
    t('{n} prompts a day', { n: PRO.freePerDay }),
    t('One prompt at a time'),
    t('Auto-download with clear file names'),
    t('Import TXT, CSV and DOCX')
  ];
  const pro: [string, string][] = [
    [t('No daily limit'), t('run hundreds of prompts in one go')],
    [t('Parallel tabs'), t('finish big batches several times faster')],
    [t('Your own Gemini and Replicate keys'), t('Kling, Seedance, Veo and more')],
    [t('Animate photos in bulk'), t('a folder of images becomes a set of videos')],
    [t('Characters with @mentions'), t('the same face or product in every shot')],
    [t('Chained clips'), t('each video continues from the last frame')],
    [t('Image → video pipeline'), t('make a still, then animate it, in one run')],
    [t('Upscaled 2K / 4K downloads'), t('ready to publish')],
    [t('Scheduler'), t('start a run while you are away')],
    [t('AI prompt helper'), t('writes and varies prompts for you')],
    [t('Sheets, Excel and JSON import, ZIP export'), t('bring whole content plans in and out')]
  ];
  return (
    <div class="compare">
      <div class="compare-col free">
        <div class="compare-head">
          <b>{t('Free')}</b>
          <span class="muted">{t('Try it on real work')}</span>
          {plan.value === 'free' && <span class="used">{t('{n} of {max} prompts used today', { n: usedToday.value, max: PRO.freePerDay })}</span>}
        </div>
        <ul>
          {free.map((x) => (
            <li key={x}>
              <Icon name="check" size={13} />
              <span>{x}</span>
            </li>
          ))}
        </ul>
      </div>
      <div class="compare-col pro">
        <div class="compare-head">
          <b>Pro</b>
          <span class="price">{t('{monthly}/month or {lifetime} once', { monthly: PRO.monthlyPrice.replace(/\s*\/\s*month$/i, ''), lifetime: PRO.lifetimePrice.replace(/\s*once$/i, '') })}</span>
        </div>
        <span class="compare-sub">{t('Everything in Free, plus:')}</span>
        <ul>
          {pro.map(([a, b]) => (
            <li key={a}>
              <Icon name="check" size={13} />
              <span>
                <b>{a}</b> — {b}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
