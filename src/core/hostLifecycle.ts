import type { Workspace } from "./workspace";

export type HostLifecycle = { open: string[]; close: string[] };

/** Controller-owned host reconciliation; the controller itself is never a host. */
export function reconcileGroupHosts(previous: Iterable<string>, workspace: Workspace): HostLifecycle {
  const before = new Set(previous);
  const after = new Set(workspace.groups.map((group) => group.id));
  return { open: [...after].filter((id) => !before.has(id)), close: [...before].filter((id) => !after.has(id)) };
}
