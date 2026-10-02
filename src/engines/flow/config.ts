import bundled from '../../../config/flow.json';

export type FlowConfig = typeof bundled;

export const BUNDLED_CONFIG = bundled as FlowConfig;

export const REMOTE_CONFIG_URL = 'https://raw.githubusercontent.com/adck8888/reelbatch/main/config/flow.json';

/** Accept a remote config only if it has the same shape; otherwise keep the bundled one. */
export function validConfig(c: unknown): c is FlowConfig {
  if (!c || typeof c !== 'object') return false;
  const x = c as Partial<FlowConfig>;
  const strings = (o: unknown) => !!o && typeof o === 'object' && Object.values(o).every((v) => typeof v === 'string');
  const lists = (o: unknown) => !!o && typeof o === 'object' && Object.values(o).every((v) => Array.isArray(v) && v.every((s) => typeof s === 'string'));
  const regexps = (o: unknown) => {
    try {
      for (const v of Object.values(o as Record<string, string>)) new RegExp(v, 'i');
      return true;
    } catch {
      return false;
    }
  };
  const numbers = (o: unknown) => !o || (typeof o === 'object' && Object.values(o).every((v) => typeof v === 'number' && v > 0));
  return (
    typeof x.version === 'string' &&
    /^\d+([.-]\d+)*$/.test(x.version) &&
    strings(x.selectors) && typeof x.selectors!.editor === 'string' && typeof x.selectors!.generate === 'string' &&
    strings(x.text) && typeof x.text!.cost === 'string' && regexps(x.text) &&
    !!x.icons && typeof x.icons === 'object' &&
    lists(x.rpc) &&
    numbers(x.timing) &&
    typeof x.mediaUrl === 'string' && regexps({ m: x.mediaUrl })
  );
}

export function mergeConfig(remote: FlowConfig): FlowConfig {
  return {
    ...BUNDLED_CONFIG,
    ...remote,
    selectors: { ...BUNDLED_CONFIG.selectors, ...remote.selectors },
    icons: { ...BUNDLED_CONFIG.icons, ...remote.icons, aspects: { ...BUNDLED_CONFIG.icons.aspects, ...remote.icons?.aspects } },
    text: { ...BUNDLED_CONFIG.text, ...remote.text },
    rpc: { ...BUNDLED_CONFIG.rpc, ...remote.rpc },
    timing: { ...BUNDLED_CONFIG.timing, ...remote.timing }
  };
}

// "1.2.3" for the extension, "2026.10.02-2" for configs: every number counts
const semver = (v: string) => v.split(/[.-]/).map((n) => parseInt(n, 10) || 0);

export function versionAtLeast(have: string, need: string) {
  const a = semver(have);
  const b = semver(need);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}
