/**
 * OllamaService — the plugin's whole runtime: managed container lifecycle
 * (via signalk-container-helper), automatic model pulling once the API
 * answers, and the plugin router endpoints.
 *
 * One instance lives for the whole server process (plugin routers cannot be
 * deregistered); `start()`/`stop()` may run many times against it.
 */

import {
  ManagedContainer,
  errMsg,
  fetchWithTimeout,
  startSafely,
  type FetchLike,
  type ResponseLike,
  type RouterLike,
} from "signalk-container-helper";
import {
  DEFAULT_PORT,
  IMAGE,
  buildContainerConfig,
  isSemverTag,
  isValidModelName,
  applyDefaults,
  resolveTag,
  type OllamaSettings,
} from "./config.js";
import {
  listLocalModels,
  normalizeModelName,
  pullModel,
  type PullEvent,
} from "./ollama-api.js";

export const PLUGIN_ID = "signalk-ollama";

/** Docker Hub tags listing feeding the config panel's version dropdown. */
const TAGS_URL = `https://hub.docker.com/v2/repositories/${IMAGE}/tags/?page_size=25`;

export type ServiceStatus = "starting" | "ready" | "stopped" | "error";
export type ModelStatus = "pending" | "pulling" | "ready" | "error";

export interface ModelState {
  status: ModelStatus;
  percent?: number;
  message?: string;
  error?: string;
}

/** The subset of the Signal K plugin app surface this plugin uses. */
export interface ServiceApp {
  debug(msg: string): void;
  error(msg: string): void;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  savePluginOptions(
    configuration: object,
    callback: (err: unknown) => void,
  ): void;
}

/** How often a still-pulling model may update the plugin status line. */
const STATUS_THROTTLE_MS = 3_000;

export class OllamaService {
  readonly container: ManagedContainer;
  settings: OllamaSettings = applyDefaults(undefined);

  private readonly app: ServiceApp;

  private running = false;
  /** Increments per start() so stale async work from a prior run is inert. */
  private runId = 0;

  private uri: string | null = null;
  private currentStatus: ServiceStatus | null = null;
  private lastError: string | null = null;
  private modelStates = new Map<string, ModelState>();
  private lastStatusLineAt = 0;
  private pullAbort: AbortController | null = null;

  constructor(app: ServiceApp, options: { fetchImpl?: FetchLike } = {}) {
    this.app = app;
    this.container = new ManagedContainer({
      app,
      pluginId: PLUGIN_ID,
      name: "ollama",
      image: IMAGE,
      defaultTag: "auto",
      // Closes over this.settings so the resolved tag follows the live GPU
      // mode without a distinct per-mode "tag" setting.
      resolveTag: (requested) =>
        resolveTag(requested, this.settings.advanced.gpu),
      buildConfig: (tag) => buildContainerConfig(this.settings, tag),
      readiness: {
        port: DEFAULT_PORT,
        path: "/api/version",
        maxMs: 120_000,
      },
      updates: {
        versionSource: { dockerHubTags: IMAGE, filter: isSemverTag },
      },
      fetchImpl: options.fetchImpl,
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Called from the synchronous plugin start(). */
  start(rawConfig: unknown): void {
    this.settings = applyDefaults(rawConfig);
    this.running = true;
    this.runId += 1;
    this.uri = null;
    this.currentStatus = "starting";
    this.lastError = null;
    this.modelStates = new Map(
      this.settings.models.map((m) => [m, { status: "pending" as const }]),
    );
    const runId = this.runId;
    startSafely(this.app, async () => {
      await this.startAsync(runId);
    });
  }

  /** Async server stop() — awaited by Signal K before a restart. */
  async stop(): Promise<void> {
    this.running = false;
    this.runId += 1;
    this.pullAbort?.abort();
    this.pullAbort = null;
    this.currentStatus = "stopped";
    try {
      await this.container.stop();
    } catch (err) {
      this.app.debug(`container stop failed: ${errMsg(err)}`);
    }
    this.app.setPluginStatus("Stopped");
  }

  // ---------------------------------------------------------------------
  // Startup flow
  // ---------------------------------------------------------------------

  private async startAsync(runId: number): Promise<void> {
    let tag: string;
    let address: string | null;
    try {
      ({ tag, address } = await this.container.start(this.settings.imageTag));
    } catch (err) {
      if (this.active(runId)) {
        this.currentStatus = "error";
        this.lastError = errMsg(err);
      }
      throw err;
    }
    if (!this.active(runId)) {
      // stop() ran while container.start() was still pulling/creating; its
      // container.stop() was a no-op then, so the container may now be
      // running with nobody monitoring it. A successor run owns the
      // container when the plugin was merely restarted — only clean up when
      // the plugin is actually stopped.
      if (!this.running) {
        try {
          await this.container.stop();
        } catch (err) {
          this.app.debug(
            `stopping the superseded container failed: ${errMsg(err)}`,
          );
        }
      }
      return;
    }
    if (address === null) {
      // readiness is always configured, so container.start() would have
      // thrown before returning here; this is unreachable in practice.
      this.currentStatus = "error";
      this.lastError = "Ollama started but no address was resolved";
      this.app.setPluginError(this.lastError);
      return;
    }
    this.uri = address;
    this.currentStatus = "ready";
    this.lastError = null;
    this.app.setPluginStatus(`Running ${IMAGE}:${tag} at ${address}`);
    await this.reconcileModels(runId, address);
  }

  /**
   * Pull every configured model that Ollama does not already have, in
   * order, non-fatally — one bad model name must not block the rest. Safe
   * to call again after an update or a config change: already-present
   * models are skipped without a network round trip beyond the initial
   * `/api/tags` check.
   */
  private async reconcileModels(runId: number, address: string): Promise<void> {
    if (this.settings.models.length === 0) return;
    this.pullAbort?.abort();
    const abort = new AbortController();
    this.pullAbort = abort;

    let existing: Set<string>;
    try {
      existing = await listLocalModels(address);
    } catch (err) {
      this.app.debug(
        `listing local models failed (will attempt pulls): ${errMsg(err)}`,
      );
      existing = new Set();
    }
    if (!this.active(runId)) return;

    for (const model of this.settings.models) {
      if (!this.active(runId) || abort.signal.aborted) return;
      if (existing.has(normalizeModelName(model))) {
        this.modelStates.set(model, { status: "ready" });
        continue;
      }
      this.modelStates.set(model, { status: "pulling", percent: 0 });
      try {
        await pullModel(
          address,
          model,
          (event) => this.onPullProgress(runId, model, event),
          abort.signal,
        );
        if (!this.active(runId)) return;
        this.modelStates.set(model, { status: "ready" });
      } catch (err) {
        if (!this.active(runId)) return;
        const message = errMsg(err);
        this.modelStates.set(model, { status: "error", error: message });
        this.app.error(`pulling model ${model} failed: ${message}`);
      }
    }
    if (this.active(runId)) {
      this.app.setPluginStatus(this.summaryStatusLine());
    }
  }

  private onPullProgress(runId: number, model: string, event: PullEvent): void {
    if (!this.active(runId)) return;
    const percent =
      event.total && event.completed
        ? Math.round((event.completed / event.total) * 100)
        : undefined;
    this.modelStates.set(model, {
      status: "pulling",
      percent,
      message: event.status,
    });
    const now = Date.now();
    if (now - this.lastStatusLineAt < STATUS_THROTTLE_MS) return;
    this.lastStatusLineAt = now;
    const pct = percent === undefined ? "" : ` ${percent}%`;
    this.app.setPluginStatus(`Pulling ${model}${pct} — ${event.status}`);
  }

  private summaryStatusLine(): string {
    const total = this.modelStates.size;
    const ready = [...this.modelStates.values()].filter(
      (s) => s.status === "ready",
    ).length;
    const failed = [...this.modelStates.values()].filter(
      (s) => s.status === "error",
    ).length;
    let line = `Running ${IMAGE} at ${this.uri}`;
    if (total > 0) {
      line += ` — ${ready}/${total} model${total === 1 ? "" : "s"} ready`;
      if (failed > 0) line += `, ${failed} failed`;
    }
    return line;
  }

  /**
   * Pull one model on demand (config-panel "Pull" button / POST route).
   * Independent of the startup reconcile loop's runId so it can be called
   * against a model not in the saved config without racing a restart.
   */
  async pullOne(model: string): Promise<void> {
    if (!this.running || this.uri === null) {
      throw new Error("Ollama is not running");
    }
    const runId = this.runId;
    this.modelStates.set(model, { status: "pulling", percent: 0 });
    try {
      await pullModel(this.uri, model, (event) =>
        this.onPullProgress(runId, model, event),
      );
      this.modelStates.set(model, { status: "ready" });
    } catch (err) {
      const message = errMsg(err);
      this.modelStates.set(model, { status: "error", error: message });
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------

  /**
   * The container was just recreated by an update apply: re-resolve the
   * address and re-run the model reconcile against the new instance.
   */
  private resumeAfterUpdate(resolvedTag: string): void {
    if (!this.running) return;
    this.runId += 1;
    const runId = this.runId;
    startSafely(this.app, async () => {
      this.app.setPluginStatus(`Starting ${IMAGE}:${resolvedTag}...`);
      const address = await this.container.resolveAddress(DEFAULT_PORT);
      if (!this.active(runId)) return;
      if (address === null) {
        this.currentStatus = "error";
        this.app.setPluginError(
          `Updated to ${IMAGE}:${resolvedTag} but could not resolve its address`,
        );
        return;
      }
      this.uri = `http://${address}`;
      this.currentStatus = "ready";
      this.app.setPluginStatus(
        `Running ${IMAGE}:${resolvedTag} at ${this.uri}`,
      );
      await this.reconcileModels(runId, this.uri);
    });
  }

  /**
   * Mount plugin routes. Called once per server process (even while the
   * plugin is disabled), so every handler checks the running flag.
   */
  registerRoutes(router: RouterLike, rawOptionsForSave: () => unknown): void {
    const guardRunning = (res: ResponseLike): boolean => {
      if (this.running) return true;
      res.status(503).json({ error: "plugin is not running" });
      return false;
    };

    this.container.registerUpdateRoutes(router, {
      onApplied: (requestedTag, resolvedTag) => {
        const raw = rawOptionsForSave();
        if (isObject(raw)) {
          this.app.savePluginOptions(
            { ...raw, imageTag: requestedTag },
            (err) => {
              if (err) {
                this.app.error(`failed to persist image tag: ${errMsg(err)}`);
              }
            },
          );
        } else {
          this.app.error(
            "not persisting the image tag: the saved plugin options are not " +
              "known in this process",
          );
        }
        this.settings = { ...this.settings, imageTag: requestedTag };
        this.resumeAfterUpdate(resolvedTag);
      },
    });

    const access = (router as { access?: (level: string) => RouterLike })
      .access;
    const statusRouter =
      typeof access === "function" ? access.call(router, "readonly") : router;

    statusRouter.get("/api/status", (_req: unknown, res: ResponseLike) => {
      if (!this.running) {
        res.status(503).json({ error: "plugin is not running" });
        return;
      }
      void this.container.getState().then((containerState) => {
        res.json({
          status: this.currentStatus ?? "starting",
          uri: this.uri,
          tag: this.container.lastStartedTag ?? this.settings.imageTag,
          containerState,
          error: this.lastError,
          models: Object.fromEntries(this.modelStates),
        });
      });
    });

    statusRouter.get("/api/versions", (_req: unknown, res: ResponseLike) => {
      void (async () => {
        try {
          const response = await fetchWithTimeout(TAGS_URL, {
            timeoutMs: 10_000,
          });
          if (!response.ok) {
            res
              .status(502)
              .json({ error: `Docker Hub answered HTTP ${response.status}` });
            return;
          }
          const body = (await response.json()) as {
            results?: { name?: unknown }[];
          };
          const versions = (Array.isArray(body.results) ? body.results : [])
            .map((r) => (typeof r?.name === "string" ? r.name : ""))
            .filter(isSemverTag)
            .sort(compareSemverDesc)
            .map((tag) => ({ tag }));
          res.json({ versions });
        } catch (err) {
          res.status(502).json({ error: errMsg(err) });
        }
      })();
    });

    router.post("/api/models/pull", (req: unknown, res: ResponseLike) => {
      if (!guardRunning(res)) return;
      const body = (req as { body?: { model?: unknown } }).body;
      const model = body?.model;
      if (!isValidModelName(model)) {
        res.status(400).json({ error: "model is required" });
        return;
      }
      void this.pullOne(model)
        .then(() => res.json({ success: true, model }))
        .catch((err: unknown) => {
          res.status(500).json({ error: errMsg(err) });
        });
    });
  }

  // ---------------------------------------------------------------------

  private active(runId: number): boolean {
    return this.running && runId === this.runId;
  }
}

function compareSemverDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
