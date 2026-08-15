import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnectionClient, toOllamaTool } from "../src/mcp-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const URL = "http://localhost:8000/mcp";

function jsonRpcResponse(
  id: number,
  result: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("toOllamaTool", () => {
  it("maps an MCP tool definition to Ollama's function-calling shape", () => {
    expect(
      toOllamaTool({
        name: "get_position",
        description: "Current vessel position",
        inputSchema: { type: "object", properties: {} },
      }),
    ).toEqual({
      type: "function",
      function: {
        name: "get_position",
        description: "Current vessel position",
        parameters: { type: "object", properties: {} },
      },
    });
  });

  it("defaults parameters to an empty object schema when inputSchema is missing", () => {
    expect(toOllamaTool({ name: "ping" }).function.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });
});

describe("McpConnectionClient", () => {
  it("initializes once, sends notifications/initialized, then lists tools", async () => {
    const calls: { method: string; hadSession: boolean }[] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        method: string;
        id?: number;
      };
      calls.push({ method: body.method, hadSession: false });
      if (body.method === "initialize") {
        return jsonRpcResponse(
          body.id!,
          { protocolVersion: "2025-06-18" },
          {
            "mcp-session-id": "sess-1",
          },
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/list") {
        return jsonRpcResponse(body.id!, {
          tools: [{ name: "get_position", description: "position" }],
        });
      }
      throw new Error(`unexpected method: ${body.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpConnectionClient("signalk-mcp-container", URL);
    const tools = await client.listTools();
    expect(tools).toEqual([{ name: "get_position", description: "position" }]);
    expect(calls.map((c) => c.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);

    // A second call reuses the session — no repeat initialize handshake.
    await client.listTools();
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) =>
          (JSON.parse((init as { body: string }).body) as { method: string })
            .method === "initialize",
      ),
    ).toHaveLength(1);
  });

  it("sends the cached session id on later requests", async () => {
    const sessionIdsSent: (string | null)[] = [];
    const fetchMock = vi.fn(
      async (
        _url: string,
        init: { body: string; headers: Record<string, string> },
      ) => {
        const body = JSON.parse(init.body) as { method: string; id?: number };
        sessionIdsSent.push(init.headers["mcp-session-id"] ?? null);
        if (body.method === "initialize") {
          return jsonRpcResponse(body.id!, {}, { "mcp-session-id": "sess-42" });
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        return jsonRpcResponse(body.id!, { tools: [] });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new McpConnectionClient("mcp", URL);
    await client.listTools();
    expect(sessionIdsSent).toEqual([null, "sess-42", "sess-42"]);
  });

  it("calls a tool and returns the parsed result", async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        method: string;
        id?: number;
        params?: { name?: string; arguments?: unknown };
      };
      if (body.method === "initialize") {
        return jsonRpcResponse(body.id!, {});
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/call") {
        expect(body.params?.name).toBe("get_position");
        expect(body.params?.arguments).toEqual({ foo: "bar" });
        return jsonRpcResponse(body.id!, {
          content: [{ type: "text", text: "44.5,-63.5" }],
        });
      }
      throw new Error(`unexpected method: ${body.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpConnectionClient("mcp", URL);
    const result = await client.callTool("get_position", { foo: "bar" });
    expect(result).toEqual({ content: [{ type: "text", text: "44.5,-63.5" }] });
  });

  it("parses a text/event-stream response's data frame", async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { method: string; id?: number };
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: body.method === "initialize" ? {} : { tools: [] },
      });
      return new Response(`event: message\ndata: ${payload}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpConnectionClient("mcp", URL);
    await expect(client.listTools()).resolves.toEqual([]);
  });

  it("skips leading SSE notification events and picks the frame matching the request id (long-running tool call)", async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        method: string;
        id?: number;
      };
      if (body.method === "initialize") return jsonRpcResponse(body.id!, {});
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      // A long-running tool call (e.g. execute_code) streaming progress
      // notifications (no "id") before the actual response frame.
      const notification = JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info", data: "running..." },
      });
      const response = JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: "Wandering Star" }] },
      });
      return new Response(
        `event: message\ndata: ${notification}\n\n` +
          `event: message\ndata: ${response}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpConnectionClient("mcp", URL);
    const result = await client.callTool("execute_code", { code: "..." });
    expect(result).toEqual({
      content: [{ type: "text", text: "Wandering Star" }],
    });
  });

  it("rejects with a descriptive error when no SSE frame matches the request id", async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { method: string; id?: number };
      if (body.method === "initialize") return jsonRpcResponse(body.id!, {});
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      const notification = JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info", data: "still running..." },
      });
      return new Response(`event: message\ndata: ${notification}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpConnectionClient("mcp", URL);
    await expect(client.listTools()).rejects.toThrow(/none matched request id/);
  });

  it("rejects on a JSON-RPC error response", async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { method: string; id?: number };
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "initialize") return jsonRpcResponse(body.id!, {});
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpConnectionClient("mcp", URL);
    await expect(client.listTools()).rejects.toThrow(/Method not found/);
  });

  it("rejects on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const client = new McpConnectionClient("mcp", URL);
    await expect(client.listTools()).rejects.toThrow(/HTTP 500/);
  });

  it("re-initializes after reset()", async () => {
    let initCount = 0;
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { method: string; id?: number };
      if (body.method === "initialize") {
        initCount += 1;
        return jsonRpcResponse(body.id!, {});
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return jsonRpcResponse(body.id!, { tools: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new McpConnectionClient("mcp", URL);
    await client.listTools();
    client.reset();
    await client.listTools();
    expect(initCount).toBe(2);
  });
});
