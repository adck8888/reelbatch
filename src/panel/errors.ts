import { t } from './i18n';

/**
 * Messages written by the background (run errors, health checks, pauses) are English. The panel
 * recognises the common ones here and shows them in the UI language; the variable part (a model
 * name, a count, Flow's own alert text) is kept as is. Unknown messages pass through untouched.
 */
const PATTERNS: [RegExp, string][] = [
  [/^Flow is not ready: (.*)\. Fix that in the Flow tab and run again\.$/s, 'Flow is not ready: {x}. Fix that in the Flow tab and run again.'],
  [/^Flow did not accept the typed prompt \((.*)\)$/s, 'Flow did not accept the typed prompt ({x})'],
  [/^Flow has no "(.*)" option here$/, 'Flow has no "{x}" option here'],
  [/^"(.*)" is not available for this model in Flow$/, '"{x}" is not available for this model in Flow'],
  [/^Flow did not switch to model (.*)$/, 'Flow did not switch to model {x}'],
  [/^Model (.*) is locked on this Flow plan$/, 'Model {x} is locked on this Flow plan'],
  [/^Unknown (?:Flow )?model (.*)$/, 'Unknown model {x}'],
  [/^Credit budget reached: (\d+) of (\d+) credits used, next prompt costs (\d+)$/, 'Credit budget reached: {x} of {y} credits used, next prompt costs {z}'],
  [/^API budget reached: \$(.*) of \$(.*) used, next prompt costs about \$(.*)$/, 'API budget reached: ${x} of ${y} used, next prompt costs about ${z}'],
  [/^Free plan limit reached \((\d+) prompts today\)\. Upgrade to Pro to keep going\.$/, 'Free plan limit reached ({x} prompts today). Upgrade to Pro to keep going.'],
  [/^The free plan runs (\d+) prompts a day\. Upgrade to Pro for unlimited runs\.$/, 'The free plan runs {x} prompts a day. Upgrade to Pro for unlimited runs.'],
  [/^Needs Reelbatch Pro: (.*)$/s, 'Needs Reelbatch Pro: {x}'],
  [/^(.*) is a Reelbatch Pro feature\. Start the free 7-day trial or upgrade in Settings\.$/, '{x} is a Reelbatch Pro feature. Start the free 7-day trial or upgrade in Settings.'],
  [/^(.*) cannot use reference images in Flow: remove them or pick a model with Ingredients$/, '{x} cannot use reference images in Flow: remove them or pick a model with Ingredients'],
  [/^Flow returned (\d+) of (\d+)$/, 'Flow returned {x} of {y}'],
  [/^Flow rejected the request \(code (.*)\)$/, 'Flow rejected the request (code {x})'],
  [/^Flow returned HTTP (\d+)$/, 'Flow returned HTTP {x}'],
  [/^Lost contact with the Flow tab while waiting for the result \((.*)\)$/s, 'Lost contact with the Flow tab while waiting for the result ({x})'],
  [/^Chrome refused input control for the Flow tab: (.*)$/s, 'Chrome refused input control for the Flow tab: {x}'],
  [/^Could not fetch the result \(HTTP (\d+)\)$/, 'Could not fetch the result (HTTP {x})'],
  [/^This key could not be activated: (.*)$/s, 'This key could not be activated: {x}'],
  [/^Partial result: (.*)$/s, 'Partial result: {x}'],
  [/^Download failed: (.*)$/s, 'Download failed: {x}'],
  [/^Upscaled download unavailable \((.*)\); saving the original$/s, 'Upscaled download unavailable ({x}); saving the original']
];

/** Translate a message that came from the background. */
export function te(msg: string | undefined | null): string {
  if (!msg) return '';
  for (const [re, key] of PATTERNS) {
    const m = msg.match(re);
    if (m) {
      const [x = '', y = '', z = ''] = m.slice(1).map(te);
      return t(key, { x, y, z });
    }
  }
  return t(msg);
}
