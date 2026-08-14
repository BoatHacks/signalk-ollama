/**
 * Shared test fixtures: a capturing mock Signal K app, a fake
 * signalk-container manager installed on the global, and small async
 * helpers.
 */

import type { ContainerManagerApi } from "signalk-container-helper";
import type { ServiceApp } from "../src/service.js";

export interface MockApp extends ServiceApp {
  statuses: string[];
  pluginErrors: string[];
  errors: string[];
  debugs: string[];
  saved: Record<string, unknown>[];
}

export function makeApp(): MockApp {
  const app: MockApp = {
    statuses: [],
    pluginErrors: [],
    errors: [],
    debugs: [],
    saved: [],
    debug(msg: string) {
      app.debugs.push(msg);
    },
    error(msg: string) {
      app.errors.push(msg);
    },
    setPluginStatus(msg: string) {
      app.statuses.push(msg);
    },
    setPluginError(msg: string) {
      app.pluginErrors.push(msg);
    },
    savePluginOptions(configuration: object, callback: (err: unknown) => void) {
      app.saved.push(configuration as Record<string, unknown>);
      callback(null);
    },
  };
  return app;
}

export interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * Minimal fake of the signalk-container manager global — just enough surface
 * for ManagedContainer: ensureRunning / recreate / resolveContainerAddress /
 * stop / listContainers / getState / updates.{register,unregister,sources}.
 */
export class FakeManager {
  calls: RecordedCall[] = [];
  /** What resolveContainerAddress returns (null = unresolvable). */
  address: string | null = null;

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  getRuntime() {
    return { name: "docker", socketPath: "/var/run/docker.sock" };
  }

  async whenReady() {
    return this.getRuntime();
  }

  async ensureRunning(name: string, config: unknown, options?: unknown) {
    this.calls.push({ method: "ensureRunning", args: [name, config, options] });
  }

  async recreate(name: string, config: unknown, options?: unknown) {
    this.calls.push({ method: "recreate", args: [name, config, options] });
  }

  async resolveContainerAddress(name: string, port: number) {
    this.calls.push({ method: "resolveContainerAddress", args: [name, port] });
    return this.address;
  }

  async stop(name: string) {
    this.calls.push({ method: "stop", args: [name] });
  }

  async listContainers() {
    return [];
  }

  async getState(name: string) {
    this.calls.push({ method: "getState", args: [name] });
    return "running";
  }

  updates = {
    register: (registration: unknown) => {
      this.calls.push({ method: "updates.register", args: [registration] });
    },
    unregister: (pluginId: string) => {
      this.calls.push({ method: "updates.unregister", args: [pluginId] });
    },
    checkOne: async (pluginId: string) => {
      this.calls.push({ method: "updates.checkOne", args: [pluginId] });
      return null;
    },
    sources: {
      dockerHubTags: (image: string, options?: unknown) => {
        this.calls.push({
          method: "updates.sources.dockerHubTags",
          args: [image, options],
        });
        return { latest: async () => null };
      },
      githubReleases: () => ({ latest: async () => null }),
    },
  };

  install(): void {
    globalThis.__signalk_containerManager =
      this as unknown as ContainerManagerApi;
  }

  static uninstall(): void {
    globalThis.__signalk_containerManager = undefined;
  }
}

/** Poll `cond` until true or `timeoutMs` elapses (throws on timeout). */
export async function until(
  cond: () => boolean,
  timeoutMs = 2_000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`until(): ${label} timed out after ${timeoutMs}ms`);
    }
    await sleep(5);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A capturing Express-router stand-in with the access() registrar. */
export type RouteHandler = (req: unknown, res: unknown) => unknown;

export class FakeRouter {
  routes = new Map<string, RouteHandler>();
  accessLevels = new Map<string, string>();

  get(path: string, handler: RouteHandler) {
    this.routes.set(`GET ${path}`, handler);
  }

  post(path: string, handler: RouteHandler) {
    this.routes.set(`POST ${path}`, handler);
  }

  access(level: string) {
    return {
      get: (path: string, handler: RouteHandler) => {
        this.accessLevels.set(`GET ${path}`, level);
        this.get(path, handler);
      },
      post: (path: string, handler: RouteHandler) => {
        this.accessLevels.set(`POST ${path}`, level);
        this.post(path, handler);
      },
    };
  }
}

/** Minimal Express-response stand-in for invoking captured handlers. */
export class FakeResponse {
  statusCode = 200;
  body: unknown;
  private resolveDone!: (value: unknown) => void;
  done = new Promise((resolve) => {
    this.resolveDone = resolve;
  });

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(body: unknown) {
    this.body = body;
    this.resolveDone(body);
    return this;
  }
}

/**
 * Express-response stand-in that also supports the streaming surface
 * (setHeader/write/end) the /api/chat route uses. `chunks` collects every
 * write() call; `done` resolves on json() (the early-error path) or end()
 * (the normal streamed-to-completion path) — whichever comes first.
 */
export class FakeStreamResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  body: unknown;
  ended = false;
  private resolveDone!: () => void;
  done = new Promise<void>((resolve) => {
    this.resolveDone = resolve;
  });

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(body: unknown) {
    this.body = body;
    this.resolveDone();
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }

  end() {
    this.ended = true;
    this.resolveDone();
  }

  /** Parsed NDJSON from every write() call, in order. */
  parsedChunks<T = unknown>(): T[] {
    return this.chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as T);
  }
}

/** Build a fetch Response whose body streams the given NDJSON objects. */
export function ndjsonResponse(
  events: unknown[],
  ok = true,
  status = 200,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: ok ? status : 500 });
}
