import { BUNDLED_CONFIG, mergeConfig, REMOTE_CONFIG_URL, validConfig, versionAtLeast, type FlowConfig } from '../engines/flow/config';
import { get, log, set } from '../shared/storage';

declare const __VERSION__: string;

const TTL = 60 * 60 * 1000;
let current: FlowConfig | null = null;

/** Remote selector config (data only) with the bundled copy as fallback. Refreshed hourly. */
export async function flowConfig(force = false): Promise<FlowConfig> {
  const settings = await get('settings');
  if (!settings.remoteConfig) return (current = BUNDLED_CONFIG);
  const cached = await get('flowConfig');
  if (!force && current && cached && Date.now() - cached.fetchedAt < TTL) return current;
  if (!force && cached && Date.now() - cached.fetchedAt < TTL && validConfig(cached.config)) return (current = pick(cached.config));
  try {
    const res = await fetch(`${REMOTE_CONFIG_URL}?t=${Math.floor(Date.now() / TTL)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: unknown = await res.json();
    if (!validConfig(json)) throw new Error('invalid shape');
    await set('flowConfig', { fetchedAt: Date.now(), config: json });
    current = pick(json);
    if (current !== BUNDLED_CONFIG) await log('info', `Flow config ${current.version} loaded`);
    return current;
  } catch (e) {
    if (cached && validConfig(cached.config)) return (current = pick(cached.config));
    if (force) await log('warn', `Remote Flow config unavailable (${e instanceof Error ? e.message : e}); using the built-in one`);
    return (current = BUNDLED_CONFIG);
  }
}

/** Newer remote configs win; a remote config that needs a newer extension is ignored. */
function pick(remote: FlowConfig): FlowConfig {
  if (!versionAtLeast(__VERSION__, remote.minExtension ?? '0.0.0')) return BUNDLED_CONFIG;
  return versionAtLeast(remote.version, BUNDLED_CONFIG.version) ? mergeConfig(remote) : BUNDLED_CONFIG;
}
