import bundled from '../../../config/flow.json';

export type FlowConfig = typeof bundled & {
  selectors: typeof bundled.selectors & Partial<Record<'frameStart' | 'frameEnd' | 'uploadItem', string>>;
};

export const BUNDLED_CONFIG = bundled as FlowConfig;

export const REMOTE_CONFIG_URL = 'https://raw.githubusercontent.com/adck8888/reelbatch/main/config/flow.json';

/** Accept a remote config only if it has the same shape; otherwise keep the bundled one. */
export function validConfig(c: unknown): c is FlowConfig {
  if (!c || typeof c !== 'object') return false;
  const x = c as Partial<FlowConfig>;
  return (
    typeof x.version === 'string' &&
    !!x.selectors && typeof x.selectors.editor === 'string' && typeof x.selectors.generate === 'string' &&
    !!x.text && typeof x.text.cost === 'string' &&
    !!x.icons && !!x.rpc && typeof x.mediaUrl === 'string'
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

const semver = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);

export function versionAtLeast(have: string, need: string) {
  const a = semver(have);
  const b = semver(need);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}
