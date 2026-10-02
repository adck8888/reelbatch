import type { LicenseState, LicenseStatus } from './types';

/**
 * Pro is sold through Lemon Squeezy (store 471716). One product carries a monthly and a lifetime
 * variant. Keys are checked against Lemon Squeezy's public licence API; no secret ships with us.
 */
export const PRO = {
  storeId: 471716,
  /** "Reelbatch Pro" product (variants: Monthly 2195723, Lifetime 2195724). Keys from other products are rejected. */
  productIds: [1406565] as number[],
  monthlyUrl: 'https://adcktools.lemonsqueezy.com/checkout/buy/52a55fe3-c97c-47d6-937d-e57a9755bdc4?enabled=2195723',
  lifetimeUrl: 'https://adcktools.lemonsqueezy.com/checkout/buy/632428be-3613-4f8c-b79b-14187472707f?enabled=2195724',
  monthlyPrice: '$9/month',
  lifetimePrice: '$69 once',
  freePerDay: 30,
  trialDays: 7
};

export const REVALIDATE_MS = 3 * 24 * 3600 * 1000;
export const GRACE_MS = 14 * 24 * 3600 * 1000;

export function licenseStatus(l: LicenseState, now = Date.now()): LicenseStatus {
  if (l.key && l.keyStatus === 'active' && l.lastOkAt && now - l.lastOkAt < GRACE_MS) return 'pro';
  if (l.trialStartedAt && now - l.trialStartedAt < PRO.trialDays * 24 * 3600 * 1000) return 'trial';
  return 'free';
}

export const isPro = (l: LicenseState, now = Date.now()) => licenseStatus(l, now) !== 'free';

export function trialDaysLeft(l: LicenseState, now = Date.now()) {
  if (!l.trialStartedAt) return PRO.trialDays;
  return Math.max(0, Math.ceil((l.trialStartedAt + PRO.trialDays * 24 * 3600 * 1000 - now) / (24 * 3600 * 1000)));
}
