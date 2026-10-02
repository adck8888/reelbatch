import { PRO, REVALIDATE_MS } from '../shared/license';
import { get, log, set, update } from '../shared/storage';

const API = 'https://api.lemonsqueezy.com/v1/licenses';

interface LicenseResponse {
  activated?: boolean;
  valid?: boolean;
  deactivated?: boolean;
  error?: string | null;
  license_key?: { status?: string };
  instance?: { id?: string } | null;
  meta?: { store_id?: number; product_id?: number; product_name?: string; variant_name?: string };
}

async function call(action: 'activate' | 'validate' | 'deactivate', body: Record<string, string>): Promise<LicenseResponse> {
  const res = await fetch(`${API}/${action}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  });
  // Lemon Squeezy answers 400/404 with a JSON body that explains the problem; anything else
  // (5xx, an HTML error page, a captive portal) is treated as "offline".
  if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as LicenseResponse;
  if (!json || typeof json !== 'object') throw new Error('bad response');
  return json;
}

// Until the product is configured no key is ours: fail closed, never open.
const ours = (r: LicenseResponse) => r.meta?.store_id === PRO.storeId && PRO.productIds.includes(r.meta?.product_id ?? -1);

export async function activate(rawKey: string) {
  const key = rawKey.trim();
  if (!/^[\w-]{16,}$/.test(key)) throw new Error('That does not look like a licence key.');
  // activating again (new key or the same one) frees this browser's previous activation slot
  const old = await get('license');
  if (old.key && old.instanceId) await call('deactivate', { license_key: old.key, instance_id: old.instanceId }).catch(() => {});
  let r: LicenseResponse;
  try {
    r = await call('activate', { license_key: key, instance_name: `Chrome ${navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? ''}`.trim() });
  } catch {
    throw new Error('Could not reach Lemon Squeezy. Check the connection and try again.');
  }
  if (!r.activated || !r.instance?.id) throw new Error(`This key could not be activated: ${(r.error ?? 'unknown error').replace(/\.+$/, '')}.`);
  if (!ours(r)) {
    await call('deactivate', { license_key: key, instance_id: r.instance.id }).catch(() => {});
    throw new Error('This licence key is for a different product.');
  }
  const now = Date.now();
  await update('license', (l) => ({
    ...l,
    key,
    instanceId: r.instance!.id,
    keyStatus: r.license_key?.status ?? 'active',
    plan: r.meta?.variant_name ?? r.meta?.product_name,
    validatedAt: now,
    lastOkAt: now,
    error: undefined
  }));
  await log('info', `Pro activated (${r.meta?.variant_name ?? 'licence'})`);
}

export async function deactivate() {
  const l = await get('license');
  if (l.key && l.instanceId) await call('deactivate', { license_key: l.key, instance_id: l.instanceId }).catch(() => {});
  await set('license', { trialStartedAt: l.trialStartedAt });
}

/** Revalidate every few days; offline keeps Pro for the grace period. */
export async function refresh(force = false) {
  const l = await get('license');
  if (!l.key || !l.instanceId) return;
  if (!force && l.validatedAt && Date.now() - l.validatedAt < REVALIDATE_MS) return;
  let r: LicenseResponse;
  try {
    r = await call('validate', { license_key: l.key, instance_id: l.instanceId });
  } catch {
    return;
  }
  const ok = !!r.valid && ours(r);
  const now = Date.now();
  await update('license', (cur) => ({
    ...cur,
    keyStatus: ok ? r.license_key?.status ?? 'active' : r.license_key?.status ?? 'invalid',
    validatedAt: now,
    lastOkAt: ok ? now : cur.lastOkAt,
    error: ok ? undefined : r.error ?? `licence ${r.license_key?.status ?? 'invalid'}`
  }));
  if (!ok) await log('warn', `Licence check failed: ${r.error ?? r.license_key?.status}`);
}

export async function startTrial() {
  await update('license', (l) => (l.trialStartedAt ? l : { ...l, trialStartedAt: Date.now() }));
}
