import type { AppCrashKind, AppCrashOccurrence, AppCrashStatus, AppCrashStatusRecord } from "../repositories/appCrashRepository.js";

export interface CrashGroup {
  signature: string;
  title: string;
  kind: AppCrashKind;
  count: number;
  devices: number;
  versions: string[];
  firstSeen: string;
  lastSeen: string;
  status: AppCrashStatus;
}

type Light = Omit<AppCrashOccurrence, "stack">;

const versionOrder = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });

/** Junta as ocorrencias do mesmo erro. `statuses` vem do banco; erro sem registro e "novo". */
export function groupCrashes(rows: Light[], statuses: Map<string, AppCrashStatusRecord>): CrashGroup[] {
  const groups = new Map<string, { latest: Light; devices: Set<string>; versions: Set<string>; count: number; firstSeen: string }>();
  for (const row of rows) {
    const group = groups.get(row.signature);
    if (!group) {
      groups.set(row.signature, { latest: row, devices: new Set([row.deviceId]), versions: new Set([row.appVersion]), count: 1, firstSeen: row.createdAt });
      continue;
    }
    group.count += 1;
    group.devices.add(row.deviceId);
    group.versions.add(row.appVersion);
    if (row.createdAt > group.latest.createdAt) group.latest = row;
    if (row.createdAt < group.firstSeen) group.firstSeen = row.createdAt;
  }
  return [...groups.entries()]
    .map(([signature, group]) => ({
      signature,
      title: group.latest.title,
      kind: group.latest.kind,
      count: group.count,
      devices: group.devices.size,
      versions: [...group.versions].sort(versionOrder),
      firstSeen: group.firstSeen,
      lastSeen: group.latest.createdAt,
      status: statuses.get(signature)?.status ?? ("novo" as const)
    }))
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
}

export function summarizeCrashes(groups: CrashGroup[]) {
  return {
    errors: groups.length,
    occurrences: groups.reduce((sum, group) => sum + group.count, 0),
    open: groups.filter((group) => group.status === "novo" || group.status === "em_analise").length,
    byStatus: {
      novo: groups.filter((group) => group.status === "novo").length,
      em_analise: groups.filter((group) => group.status === "em_analise").length,
      corrigido: groups.filter((group) => group.status === "corrigido").length,
      ignorado: groups.filter((group) => group.status === "ignorado").length
    }
  };
}
