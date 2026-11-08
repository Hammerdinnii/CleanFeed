import { api } from '../shared/api';
import { normalizeHostname } from '../shared/domain';
import { syncSessionRules } from './dnr';
import { ready, setTempAllow } from './state';

/** Temporary "pause on this site" exceptions, backed by DNR session rules + an alarm. */
export const ALARM_PAUSES = 'cf:pauses';

function scheduleNext(map: Record<string, number>): void {
  const next = Math.min(...Object.values(map).filter((t) => t > Date.now()));
  if (Number.isFinite(next)) api.alarms.create(ALARM_PAUSES, { when: next + 1000 });
}

export async function pauseSite(hostname: string, minutes: number | null): Promise<void> {
  const s = await ready();
  const map = { ...s.tempAllow };
  const host = normalizeHostname(hostname);
  if (minutes === null || minutes <= 0) delete map[host];
  else map[host] = Date.now() + minutes * 60_000;
  await setTempAllow(map);
  await syncSessionRules();
  scheduleNext(map);
}

export async function expirePauses(): Promise<void> {
  const s = await ready();
  const now = Date.now();
  const map = Object.fromEntries(Object.entries(s.tempAllow).filter(([, t]) => t > now));
  await setTempAllow(map);
  await syncSessionRules();
  scheduleNext(map);
}

export function pauseFromMenu(host: string): Promise<void> {
  return pauseSite(host, 30);
}
