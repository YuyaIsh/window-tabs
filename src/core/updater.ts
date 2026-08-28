import { check } from "@tauri-apps/plugin-updater";

export const UPDATE_CHECK_COOLDOWN_MS = 60_000;

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export type UpdateState = {
  status: UpdateStatus;
  currentVersion?: string;
  version?: string;
  notes?: string;
  error?: string;
  checkedAt?: number;
};

export type UpdateHandle = {
  currentVersion: string;
  version: string;
  notes?: string;
  download(): Promise<void>;
  install(): Promise<void>;
};

export type UpdateRuntime = {
  check(): Promise<UpdateHandle | null>;
};

const runtime: UpdateRuntime = {
  async check() {
    const update = await check();
    if (!update) return null;
    return {
      currentVersion: update.currentVersion,
      version: update.version,
      notes: update.body,
      download: () => update.download(),
      install: () => update.install(),
    };
  },
};

export function canCheckForUpdate(lastCheckedAt: number | undefined, now: number): boolean {
  return lastCheckedAt === undefined || now - lastCheckedAt >= UPDATE_CHECK_COOLDOWN_MS;
}

export function ownsUpdater(hostGroupId: string | undefined): boolean {
  return hostGroupId === undefined;
}

export class UpdateController {
  private state: UpdateState = { status: "idle" };
  private update: UpdateHandle | null = null;
  private checkPromise: Promise<UpdateState> | null = null;

  constructor(
    private readonly adapter: UpdateRuntime = runtime,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): UpdateState {
    return this.state;
  }

  async check(onChange: (state: UpdateState) => void): Promise<UpdateState> {
    if (this.checkPromise) return this.checkPromise;
    const checkedAt = this.now();
    if (!canCheckForUpdate(this.state.checkedAt, checkedAt)) return this.state;
    this.setState({ status: "checking", checkedAt }, onChange);
    this.checkPromise = this.performCheck(checkedAt, onChange);
    try {
      return await this.checkPromise;
    } finally {
      this.checkPromise = null;
    }
  }

  async download(onChange: (state: UpdateState) => void): Promise<UpdateState> {
    if (!this.update || this.state.status !== "available") return this.state;
    this.setState({ ...this.state, status: "downloading", error: undefined }, onChange);
    try {
      await this.update.download();
      this.setState({ ...this.state, status: "ready" }, onChange);
    } catch (reason) {
      this.fail(reason, onChange);
    }
    return this.state;
  }

  async install(onChange: (state: UpdateState) => void): Promise<UpdateState> {
    if (!this.update || this.state.status !== "ready") return this.state;
    this.setState({ ...this.state, status: "installing", error: undefined }, onChange);
    try {
      await this.update.install();
    } catch (reason) {
      this.fail(reason, onChange);
    }
    return this.state;
  }

  private async performCheck(
    checkedAt: number,
    onChange: (state: UpdateState) => void,
  ): Promise<UpdateState> {
    try {
      this.update = await this.adapter.check();
      if (!this.update) {
        this.setState({ status: "up-to-date", checkedAt }, onChange);
      } else {
        this.setState({
          status: "available",
          currentVersion: this.update.currentVersion,
          version: this.update.version,
          notes: this.update.notes,
          checkedAt,
        }, onChange);
      }
    } catch (reason) {
      this.update = null;
      this.fail(reason, onChange, checkedAt);
    }
    return this.state;
  }

  private fail(
    reason: unknown,
    onChange: (state: UpdateState) => void,
    checkedAt = this.state.checkedAt,
  ): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    this.setState({ ...this.state, status: "error", error: message, checkedAt }, onChange);
  }

  private setState(state: UpdateState, onChange: (state: UpdateState) => void): void {
    this.state = state;
    onChange(state);
  }
}
