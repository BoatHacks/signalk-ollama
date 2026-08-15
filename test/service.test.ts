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

  it("registerRoutes: POST /api/chat with a sessionId records a downloadable backend log", async () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    service.start({});
    await until(() => app.statuses.some((s) => s.startsWith("Running")));

    const chatHandler = router.routes.get("POST /api/chat")!;
    const chatRes = new FakeStreamResponse();
    chatHandler(
      {
        body: {
          model: "llama3.2:3b",
          messages: [{ role: "user", content: "hi" }],
          sessionId: "sess-1",
        },
      },
      chatRes,
    );
    await chatRes.done;

    const logHandler = router.routes.get("GET /api/session-log/:sessionId")!;
    const logRes = new FakeStreamResponse();
    logHandler({ params: { sessionId: "sess-1" } }, logRes);
    await logRes.done;

    expect(logRes.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
    expect(logRes.headers["Content-Disposition"]).toBe(
      'attachment; filename="signalk-ollama-session-sess-1.log"',
    );
    const log = logRes.chunks.join("");
    expect(log).toContain("chat request: model=llama3.2:3b");
    expect(log).toContain("chat request completed");
  });

  it("registerRoutes: GET /api/session-log/:sessionId 404s for an unknown session", async () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    service.start({});
    await until(() => app.statuses.some((s) => s.startsWith("Running")));

    const logHandler = router.routes.get("GET /api/session-log/:sessionId")!;
    const logRes = new FakeStreamResponse();
    logHandler({ params: { sessionId: "never-happened" } }, logRes);
    await logRes.done;
    expect(logRes.statusCode).toBe(404);
  });

  it("registerRoutes: GET /api/session-log/:sessionId answers 503 while stopped", () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    const logHandler = router.routes.get("GET /api/session-log/:sessionId")!;
    const logRes = new FakeStreamResponse();
    logHandler({ params: { sessionId: "sess-1" } }, logRes);
    expect(logRes.statusCode).toBe(503);
  });

  it("registerRoutes: POST /api/chat offers MCP tools and runs a tool-call round-trip", async () => {
    let chatCallCount = 0;
    fetchImpl.mockImplementation(
      async (url: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/version")) {
          return new Response(JSON.stringify({ version: "0.32.10" }), {
            status: 200,
          });
        }
        if (url === "http://mcp.local/mcp" && method === "POST") {
          const body = JSON.parse(init!.body!) as {
            method: string;
            id?: number;
            params?: { name?: string };
          };
          if (body.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          if (body.method === "initialize") {
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (body.method === "tools/list") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  tools: [{ name: "get_position", description: "position" }],
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (body.method === "tools/call") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: { content: [{ type: "text", text: "44.5,-63.5" }] },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          throw new Error(`unexpected MCP method: ${body.method}`);
        }
        if (url.endsWith("/api/chat") && method === "POST") {
          chatCallCount += 1;
          const body = JSON.parse(init!.body!) as { tools?: unknown[] };
          if (chatCallCount === 1) {
            expect(body.tools).toEqual([
              {
                type: "function",
                function: {
                  name: "get_position",
                  description: "position",
                  parameters: { type: "object", properties: {} },
                },
              },
            ]);
            return ndjsonResponse([
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    { function: { name: "get_position", arguments: {} } },
                  ],
                },
                done: true,
              },
            ]);
          }
          return ndjsonResponse([
            {
              message: {
                role: "assistant",
                content: "You are at 44.5,-63.5.",
              },
              done: true,
            },
          ]);
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      },
    );

    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    service.start({
      mcp: {
        enabled: true,
        connections: [
          { name: "mcp", url: "http://mcp.local/mcp", enabled: true },
        ],
      },
    });
    await until(() => app.statuses.some((s) => s.startsWith("Running")));

    const handler = router.routes.get("POST /api/chat")!;
    const res = new FakeStreamResponse();
    handler(
      {
        body: {
          model: "llama3.2:3b",
          messages: [{ role: "user", content: "where am I?" }],
        },
      },
      res,
    );
    await res.done;
    expect(chatCallCount).toBe(2);
    const chunks = res.parsedChunks<{ message?: { content: string } }>();
    expect(chunks.at(-1)?.message?.content).toBe("You are at 44.5,-63.5.");
    expect(chunks.some((c) => c.message?.content === "44.5,-63.5")).toBe(true);
  });

  it("registerRoutes: GET /api/mcp/status reports per-connection tool counts and errors", async () => {
    fetchImpl.mockImplementation(
      async (url: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/version")) {
          return new Response(JSON.stringify({ version: "0.32.10" }), {
            status: 200,
          });
        }
        if (url === "http://good.local/mcp" && method === "POST") {
          const body = JSON.parse(init!.body!) as {
            method: string;
            id?: number;
          };
          if (body.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          if (body.method === "tools/list") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: { tools: [{ name: "a" }, { name: "b" }] },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "http://bad.local/mcp") {
          return new Response("nope", { status: 500 });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      },
    );

    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    service.start({
      mcp: {
        enabled: true,
        connections: [
          { name: "good", url: "http://good.local/mcp", enabled: true },
          { name: "bad", url: "http://bad.local/mcp", enabled: true },
        ],
      },
    });
    await until(() => app.statuses.some((s) => s.startsWith("Running")));

    const handler = router.routes.get("GET /api/mcp/status")!;
    const res = new FakeResponse();
    handler({}, res);
    const body = (await res.done) as {
      connections: {
        name: string;
        toolCount: number;
        error: string | null;
      }[];
    };
    expect(body.connections).toContainEqual(
      expect.objectContaining({ name: "good", toolCount: 2, error: null }),
    );
    expect(body.connections.find((c) => c.name === "bad")?.error).toMatch(
      /HTTP 500/,
    );
  });

  it("registerRoutes: GET /api/mcp/status answers 503 while stopped", () => {
    const service = new OllamaService(app, { fetchImpl: fetchImpl as never });
    const router = new FakeRouter();
    service.registerRoutes(router as unknown as RouterLike, () => ({}));
    const handler = router.routes.get("GET /api/mcp/status")!;
    const res = new FakeResponse();
    handler({}, res);
    expect(res.statusCode).toBe(503);
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
