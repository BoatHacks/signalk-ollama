import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatStream,
  deleteModel,
  listLocalModels,
  normalizeModelName,
  pullModel,
} from "../src/ollama-api.js";
import { ndjsonResponse } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeModelName", () => {
  it("appends :latest when no tag is given", () => {
    expect(normalizeModelName("llama3.2")).toBe("llama3.2:latest");
    expect(normalizeModelName("llama3.2:3b")).toBe("llama3.2:3b");
  });
});

describe("listLocalModels", () => {
  it("returns the set of pulled model names", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: [{ name: "llama3.2:3b" }, { name: "qwen2.5:latest" }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const models = await listLocalModels("http://127.0.0.1:11434");
    expect(models).toEqual(new Set(["llama3.2:3b", "qwen2.5:latest"]));
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(listLocalModels("http://127.0.0.1:11434")).rejects.toThrow(
      /HTTP 500/,
    );
  });
});

describe("pullModel", () => {
  it("resolves once the stream reports success, forwarding progress events", async () => {
    const events = [
      { status: "pulling manifest" },
      {
        status: "downloading",
        digest: "sha256:abc",
        total: 100,
        completed: 50,
      },
      {
        status: "downloading",
        digest: "sha256:abc",
        total: 100,
        completed: 100,
      },
      { status: "success" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjsonResponse(events)),
    );
    const progress: unknown[] = [];
    await pullModel("http://127.0.0.1:11434", "llama3.2:3b", (e) =>
      progress.push(e),
    );
    expect(progress).toEqual(events);
  });

  it("rejects on an {error} line even inside a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ndjsonResponse([
          { status: "pulling manifest" },
          { error: "model not found" },
        ]),
      ),
    );
    await expect(
      pullModel("http://127.0.0.1:11434", "nonexistent:tag", () => undefined),
    ).rejects.toThrow(/model not found/);
  });

  it("rejects when the stream ends without a success status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjsonResponse([{ status: "pulling manifest" }])),
    );
    await expect(
      pullModel("http://127.0.0.1:11434", "llama3.2:3b", () => undefined),
    ).rejects.toThrow(/ended without a success/);
  });

  it("rejects on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    await expect(
      pullModel("http://127.0.0.1:11434", "llama3.2:3b", () => undefined),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe("deleteModel", () => {
  it("resolves on a 2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await expect(
      deleteModel("http://127.0.0.1:11434", "llama3.2:3b"),
    ).resolves.toBeUndefined();
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(
      deleteModel("http://127.0.0.1:11434", "llama3.2:3b"),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe("chatStream", () => {
  const messages = [{ role: "user" as const, content: "hi" }];

  it("forwards each NDJSON chunk and resolves when the stream ends", async () => {
    const events = [
      { message: { role: "assistant", content: "Hel" }, done: false },
      { message: { role: "assistant", content: "lo" }, done: false },
      { message: { role: "assistant", content: "" }, done: true },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjsonResponse(events)),
    );
    const chunks: unknown[] = [];
    await chatStream("http://127.0.0.1:11434", "llama3.2:3b", messages, (c) =>
      chunks.push(c),
    );
    expect(chunks).toEqual(events);
  });

  it("rejects on an {error} line even inside a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjsonResponse([{ error: "model not found" }])),
    );
    await expect(
      chatStream(
        "http://127.0.0.1:11434",
        "nonexistent:tag",
        messages,
        () => undefined,
      ),
    ).rejects.toThrow(/model not found/);
  });

  it("rejects on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    await expect(
      chatStream(
        "http://127.0.0.1:11434",
        "llama3.2:3b",
        messages,
        () => undefined,
      ),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects when the underlying fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(
      chatStream(
        "http://127.0.0.1:11434",
        "llama3.2:3b",
        messages,
        () => undefined,
      ),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
