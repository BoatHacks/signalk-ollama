import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import createPlugin from "../src/index.js";
import {
  FakeManager,
  FakeRouter,
  makeApp,
  until,
  type MockApp,
} from "./helpers.js";

let manager: FakeManager;
let app: MockApp;

beforeEach(() => {
  manager = new FakeManager();
  manager.address = "127.0.0.1:39434";
  manager.install();
  app = makeApp();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/version")) {
        return new Response(JSON.stringify({ version: "0.32.10" }), {
          status: 200,
        });
      }
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  FakeManager.uninstall();
  vi.unstubAllGlobals();
});

describe("plugin factory", () => {
  it("exports a default (app) => plugin constructor with the required shape", () => {
    const plugin = createPlugin(app as unknown as ServerAPI);
    expect(plugin.id).toBe("signalk-ollama");
    expect(plugin.name).toBe("Ollama");
    expect(typeof plugin.start).toBe("function");
    expect(typeof plugin.stop).toBe("function");
    const schema = (plugin.schema as () => unknown)() as {
      type: string;
      properties: { imageTag: { default: string } };
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.imageTag.default).toBe("auto");
  });

  it("runs a full start → ready → stop lifecycle", async () => {
    const plugin = createPlugin(app as unknown as ServerAPI);
    const router = new FakeRouter();
    plugin.registerWithRouter!(router as never);
    expect(router.routes.has("GET /api/status")).toBe(true);
    expect(router.routes.has("POST /api/models/pull")).toBe(true);

    plugin.start({}, () => {});
    await until(() => app.statuses.some((s) => s.startsWith("Running")));

    await plugin.stop();
    expect(app.statuses.at(-1)).toBe("Stopped");
    expect(manager.callsTo("stop")).toHaveLength(1);
  });
});
