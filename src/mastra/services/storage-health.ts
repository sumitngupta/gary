import { readFile } from 'node:fs/promises';
import { garyConfig } from '../config/gary-config';

export type StorageHealth = {
  status: 'ok' | 'warning' | 'critical' | 'unavailable';
  usedPercent: number | null;
  available: string | null;
  warningAtPercent: number;
  criticalAtPercent: number;
};

export async function readConfiguredStorageHealth() {
  const { healthFile, warningPercent, criticalPercent } = garyConfig().storage;
  return healthFile ? readStorageHealth(healthFile, warningPercent, criticalPercent) : undefined;
}

export async function readStorageHealth(path: string, warningAtPercent: number, criticalAtPercent: number): Promise<StorageHealth> {
  try {
    const payload = JSON.parse(await readFile(path, 'utf8')) as { pct?: unknown; avail?: unknown };
    const usedPercent = typeof payload.pct === 'number' && Number.isFinite(payload.pct) ? payload.pct : null;
    const available = typeof payload.avail === 'string' ? payload.avail : null;
    const status = usedPercent === null
      ? 'unavailable'
      : usedPercent >= criticalAtPercent
        ? 'critical'
        : usedPercent >= warningAtPercent
          ? 'warning'
          : 'ok';
    return { status, usedPercent, available, warningAtPercent, criticalAtPercent };
  } catch {
    return { status: 'unavailable', usedPercent: null, available: null, warningAtPercent, criticalAtPercent };
  }
}
