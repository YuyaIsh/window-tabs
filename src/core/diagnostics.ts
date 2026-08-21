export type DiagnosticEntry = { at: string; level: "info" | "error"; message: string };

const maxEntries = 100;
const entries: DiagnosticEntry[] = [];

export function recordDiagnostic(level: DiagnosticEntry["level"], message: string): void {
  entries.push({ at: new Date().toISOString(), level, message });
  if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
}

export function diagnostics(): readonly DiagnosticEntry[] { return entries; }
