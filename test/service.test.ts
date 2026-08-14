import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterLike } from "signalk-container-helper";
import { OllamaService } from "../src/service.js";
import {
  FakeManager,
  FakeRouter,
  FakeResponse,
  FakeStreamResponse,
  makeApp,
  ndjsonResponse,
  until,
  type MockApp,
} from "./helpers.js";

function mockFetch() {
  return vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/version")) {
      return new Response(JSON.stringify({ version: "0.32.10" }), {
        status: 200,
      });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    if (url.endsWith("/api/pull") && method === "POST") {
      return ndjsonResponse([
        { status: "pulling manifest" },
        { status: "success" },
      ]);
    }
    if (url.endsWith("/api/chat") && method === "POST") {
      return ndjsonResponse([
        { message: { role: "assistant", content: "Hi" }, done: false },
        { message: { role: "assistant", content: "!" }, done: true },
      ]);
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

describe("OllamaService", () => {
  let app: MockApp;
  let manager: FakeManager;
  let fetchImpl: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    app = makeApp();
    manager = new FakeManager();
    manager.address = "127.0.0.1:39434";
    manager.install();
    fetchImpl = mockFetch();
    vi.stubGlobal("fetch", fetchImpl);
  });

  afterEach(() => {
    FakeManager.uninstall();
    vi.unstubAllGlobals();
  });

  it("starts the container, waits for readiness, and reports running", async () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    service.start({});
    await until(() => app.statuses.some((s) => s.startsWith("Running")));
    expect(manager.callsTo("ensureRunning")).toHaveLength(1);
    const [, config] = manager.callsTo("ensureRunning")[0]!.args as [
      string,
      { image: string; tag: string },
    ];
    expect(config.image).toBe("ollama/ollama");
    expect(app.pluginErrors).toEqual([]);
  });

  it("pulls configured models not already present, then reports a summary", async () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    service.start({ models: ["llama3.2:3b"] });
    await until(() => app.statuses.some((s) => s.includes("1/1 model")));
    expect(
      fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/api/pull")),
    ).toBe(true);
  });

  it("skips already-pulled models without calling /api/pull", async () => {
    fetchImpl.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/version")) {
        return new Response(JSON.stringify({ version: "0.32.10" }), {
          status: 200,
        });
      }
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "llama3.2:3b" }] }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    service.start({ models: ["llama3.2:3b"] });
    await until(() => app.statuses.some((s) => s.includes("1/1 model")));
    expect(
      fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/api/pull")),
    ).toBe(false);
  });

  it("stop() stops the container and aborts an in-flight pull", async () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    service.start({});
    await until(() => app.statuses.some((s) => s.startsWith("Running")));
    await service.stop();
    expect(manager.callsTo("stop")).toHaveLength(1);
    expect(app.statuses.at(-1)).toBe("Stopped");
    expect(service.isRunning).toBe(false);
  });

  it("registerRoutes: /api/status reflects running state and model states", async () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    service.start({ models: ["llama3.2:3b"] });
    await until(() => app.statuses.some((s) => s.includes("1/1 model")));

    const handler = router.routes.get("GET /api/status")!;
    const res = new FakeResponse();
    handler({}, res);
    const body = (await res.done) as {
      status: string;
      models: Record<string, { status: string }>;
    };
    expect(body.status).toBe("ready");
    expect(body.models["llama3.2:3b"]?.status).toBe("ready");
  });

  it("registerRoutes: /api/status answers 503 while stopped", () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    const handler = router.routes.get("GET /api/status")!;
    const res = new FakeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(503);
  });

  it("registerRoutes: POST /api/models/pull pulls a model on demand", async () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    service.start({});
    await until(() => app.statuses.some((s) => s.startsWith("Running")));

    const handler = router.routes.get("POST /api/models/pull")!;
    const res = new FakeResponse();
    handler({ body: { model: "llama3.2:3b" } }, res);
    const body = (await res.done) as { success: boolean; model: string };
    expect(body.success).toBe(true);
    expect(body.model).toBe("llama3.2:3b");
  });

  it("registerRoutes: POST /api/models/pull rejects an invalid model name", () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    service.start({});
    const handler = router.routes.get("POST /api/models/pull")!;
    const res = new FakeResponse();
    handler({ body: { model: "has space" } }, res);
    expect(res.statusCode).toBe(400);
  });

  it("registerRoutes: POST /api/models/pull logs a failed pull via app.error", async () => {
    fetchImpl.mockImplementation(
      async (url: string, init?: { method?: string }) => {
        if (url.endsWith("/api/version")) {
          return new Response(JSON.stringify({ version: "0.32.10" }), {
            status: 200,
          });
        }
        if (url.endsWith("/api/pull") && init?.method === "POST") {
          return ndjsonResponse([{ error: "model not found" }]);
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    );
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    service.start({});
    await until(() => app.statuses.some((s) => s.startsWith("Running")));

    const handler = router.routes.get("POST /api/models/pull")!;
    const res = new FakeResponse();
    handler({ body: { model: "nonexistent:tag" } }, res);
    const body = (await res.done) as { error: string };
    expect(res.statusCode).toBe(500);
    expect(body.error).toMatch(/model not found/);
    expect(app.errors.some((e) => e.includes("nonexistent:tag"))).toBe(true);
  });

  it("registerRoutes: POST /api/chat streams NDJSON chunks and logs an interaction", async () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    service.start({});
    await until(() => app.statuses.some((s) => s.startsWith("Running")));

    const handler = router.routes.get("POST /api/chat")!;
    const res = new FakeStreamResponse();
    handler(
      {
        body: {
          model: "llama3.2:3b",
          messages: [{ role: "user", content: "hi" }],
        },
      },
      res,
    );
    await res.done;
    expect(res.ended).toBe(true);
    expect(res.headers["Content-Type"]).toBe("application/x-ndjson");
    const chunks = res.parsedChunks<{ message?: { content: string } }>();
    expect(chunks.map((c) => c.message?.content)).toEqual(["Hi", "!"]);

    const statusHandler = router.routes.get("GET /api/interactions")!;
    const statusRes = new FakeResponse();
    statusHandler({}, statusRes);
    const body = (await statusRes.done) as {
      interactions: {
        model: string;
        prompt: string;
        response: string;
        error: string | null;
      }[];
    };
    expect(body.interactions).toHaveLength(1);
    expect(body.interactions[0]).toMatchObject({
      model: "llama3.2:3b",
      prompt: "hi",
      response: "Hi!",
      error: null,
    });
  });

  it("registerRoutes: POST /api/chat rejects a missing messages array before streaming", async () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    service.start({});
    await until(() => app.statuses.some((s) => s.startsWith("Running")));

    const handler = router.routes.get("POST /api/chat")!;
    const res = new FakeStreamResponse();
    handler({ body: { model: "llama3.2:3b" } }, res);
    expect(res.statusCode).toBe(400);
  });

  it("registerRoutes: POST /api/chat answers 503 while stopped", () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    const handler = router.routes.get("POST /api/chat")!;
    const res = new FakeStreamResponse();
    handler(
      {
        body: {
          model: "llama3.2:3b",
          messages: [{ role: "user", content: "hi" }],
        },
      },
      res,
    );
    expect(res.statusCode).toBe(503);
  });

  it("registerRoutes: GET /api/interactions answers 503 while stopped", () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    const handler = router.routes.get("GET /api/interactions")!;
    const res = new FakeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(503);
  });
});
