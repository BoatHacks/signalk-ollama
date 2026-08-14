import { describe, expect, it } from "vitest";
import {
  CONFIG_SCHEMA,
  DEFAULT_MCP_CONNECTION_NAME,
  DEFAULT_MCP_URL,
  IMAGE,
  PINNED_TAG,
  applyDefaults,
  buildContainerConfig,
  defaultSettings,
  isSemverTag,
  isValidMcpUrl,
  isValidModelName,
  resolveTag,
} from "../src/config.js";

describe("applyDefaults", () => {
  it("returns the documented defaults for empty/missing config", () => {
    expect(applyDefaults(undefined)).toEqual(defaultSettings());
    expect(applyDefaults({})).toEqual(defaultSettings());
    const d = defaultSettings();
    expect(d.imageTag).toBe("auto");
    expect(d.models).toEqual(["llama3.2:3b"]);
    expect(d.port).toBe(11434);
    expect(d.advanced.bind).toBe("0.0.0.0");
    expect(d.advanced.memoryLimit).toBe("4g");
    expect(d.advanced.restartPolicy).toBe("unless-stopped");
    expect(d.advanced.gpu).toBe("none");
  });

  it("merges partial user config over defaults (deep for advanced)", () => {
    const settings = applyDefaults({
      models: ["llama3.2:3b"],
      advanced: { gpu: "amd" },
    });
    expect(settings.models).toEqual(["llama3.2:3b"]);
    expect(settings.advanced.gpu).toBe("amd");
    expect(settings.advanced.memoryLimit).toBe("4g");
    expect(settings.advanced.bind).toBe("0.0.0.0");
  });

  it("accepts an explicit 127.0.0.1 (not just the 0.0.0.0 default)", () => {
    const settings = applyDefaults({ advanced: { bind: "127.0.0.1" } });
    expect(settings.advanced.bind).toBe("127.0.0.1");
  });

  it("falls back to defaults on wrong-typed values", () => {
    const settings = applyDefaults({
      port: "not-a-number",
      models: "not-an-array",
      advanced: { bind: "10.0.0.1", restartPolicy: "on-failure", gpu: "intel" },
    });
    expect(settings.port).toBe(11434);
    expect(settings.models).toEqual(["llama3.2:3b"]);
    expect(settings.advanced.bind).toBe("0.0.0.0");
    expect(settings.advanced.restartPolicy).toBe("unless-stopped");
    expect(settings.advanced.gpu).toBe("none");
  });

  it("respects an explicit empty models list (not just the default)", () => {
    const settings = applyDefaults({ models: [] });
    expect(settings.models).toEqual([]);
  });

  it("sanitizes the models list: trims, dedupes, drops invalid entries", () => {
    const settings = applyDefaults({
      models: [" llama3.2:3b ", "llama3.2:3b", "", "  ", 42, "has space here"],
    });
    expect(settings.models).toEqual(["llama3.2:3b"]);
  });

  it("defaults mcp to enabled with signalk-mcp-container as the one connection", () => {
    const d = defaultSettings();
    expect(d.mcp.enabled).toBe(true);
    expect(d.mcp.connections).toEqual([
      {
        name: DEFAULT_MCP_CONNECTION_NAME,
        url: DEFAULT_MCP_URL,
        enabled: true,
      },
    ]);
  });

  it("respects an explicit empty mcp connections list (not just the default)", () => {
    const settings = applyDefaults({ mcp: { connections: [] } });
    expect(settings.mcp.connections).toEqual([]);
  });

  it("respects mcp.enabled: false", () => {
    const settings = applyDefaults({ mcp: { enabled: false } });
    expect(settings.mcp.enabled).toBe(false);
    // connections are left alone — enabled is a separate on/off switch
    expect(settings.mcp.connections).toEqual(defaultSettings().mcp.connections);
  });

  it("sanitizes mcp connections: drops invalid URLs, dedupes by URL, defaults name/enabled", () => {
    const settings = applyDefaults({
      mcp: {
        connections: [
          { name: "boat mcp", url: "http://localhost:8000/mcp" },
          { name: "dup", url: "http://localhost:8000/mcp" },
          { url: "not-a-url" },
          { url: 42 },
          { name: "no url field" },
          { url: "https://example.com/mcp", enabled: false },
          { url: "  http://spacey:8000/mcp  " },
        ],
      },
    });
    expect(settings.mcp.connections).toEqual([
      { name: "boat mcp", url: "http://localhost:8000/mcp", enabled: true },
      {
        name: "https://example.com/mcp",
        url: "https://example.com/mcp",
        enabled: false,
      },
      {
        name: "http://spacey:8000/mcp",
        url: "http://spacey:8000/mcp",
        enabled: true,
      },
    ]);
  });
});

describe("isValidMcpUrl", () => {
  it("accepts http(s) URLs and rejects everything else", () => {
    expect(isValidMcpUrl("http://localhost:8000/mcp")).toBe(true);
    expect(isValidMcpUrl("https://example.com/mcp")).toBe(true);
    expect(isValidMcpUrl("ftp://example.com/mcp")).toBe(false);
    expect(isValidMcpUrl("not a url")).toBe(false);
    expect(isValidMcpUrl("")).toBe(false);
    expect(isValidMcpUrl(undefined)).toBe(false);
    expect(isValidMcpUrl(42)).toBe(false);
  });
});

describe("isValidModelName", () => {
  it("accepts non-empty, whitespace-free strings", () => {
    expect(isValidModelName("llama3.2:3b")).toBe(true);
    expect(isValidModelName("qwen2.5")).toBe(true);
    expect(isValidModelName("")).toBe(false);
    expect(isValidModelName("  ")).toBe(false);
    expect(isValidModelName("bad name")).toBe(false);
    expect(isValidModelName(42)).toBe(false);
    expect(isValidModelName(undefined)).toBe(false);
  });
});

describe("resolveTag", () => {
  it("maps auto to the pinned release and passes explicit tags through", () => {
    expect(resolveTag("auto", "none")).toBe(PINNED_TAG);
    expect(resolveTag("0.32.0", "none")).toBe("0.32.0");
    expect(resolveTag("latest", "none")).toBe("latest");
  });

  it("appends -rocm exactly once for amd GPU mode", () => {
    expect(resolveTag("auto", "amd")).toBe(`${PINNED_TAG}-rocm`);
    expect(resolveTag("0.32.0", "amd")).toBe("0.32.0-rocm");
    expect(resolveTag("0.32.0-rocm", "amd")).toBe("0.32.0-rocm");
  });

  it("does not suffix for nvidia (device passthrough only, no tag variant)", () => {
    expect(resolveTag("auto", "nvidia")).toBe(PINNED_TAG);
  });
});

describe("isSemverTag (update filter)", () => {
  it("accepts only plain numeric semver tags", () => {
    expect(isSemverTag("0.32.10")).toBe(true);
    expect(isSemverTag("10.0.0")).toBe(true);
    expect(isSemverTag("latest")).toBe(false);
    expect(isSemverTag("0.32")).toBe(false);
    expect(isSemverTag("v0.32.10")).toBe(false);
    expect(isSemverTag("0.32.10-rocm")).toBe(false);
  });
});

describe("buildContainerConfig", () => {
  it("is pure: identical calls produce deep-equal fresh objects", () => {
    const a = buildContainerConfig(defaultSettings(), PINNED_TAG);
    const b = buildContainerConfig(defaultSettings(), PINNED_TAG);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("publishes on all interfaces, and sets the data mount and memory caps, by default", () => {
    const config = buildContainerConfig(defaultSettings(), PINNED_TAG);
    expect(config.image).toBe(IMAGE);
    expect(config.tag).toBe(PINNED_TAG);
    expect(config.ports).toEqual({ "11434": "0.0.0.0:11434" });
    expect(config.signalkAccessiblePorts).toBeUndefined();
    expect(config.signalkDataMount).toBe("/root/.ollama");
    expect(config.restart).toBe("unless-stopped");
    expect(config.resources).toEqual({ memory: "4g", memorySwap: "4g" });
    expect(config.devices).toBeUndefined();
  });

  it("switches to Signal K-only networking for bind 127.0.0.1", () => {
    const settings = applyDefaults({ advanced: { bind: "127.0.0.1" } });
    const config = buildContainerConfig(settings, PINNED_TAG);
    expect(config.signalkAccessiblePorts).toEqual([11434]);
    expect(config.ports).toBeUndefined();
  });

  it("adds ROCm devices/groups for amd GPU mode", () => {
    const settings = applyDefaults({ advanced: { gpu: "amd" } });
    const config = buildContainerConfig(settings, `${PINNED_TAG}-rocm`);
    expect(config.devices).toEqual(["/dev/kfd", "/dev/dri"]);
    expect(config.groupAdd).toEqual(["video", "render"]);
  });

  it("adds Nvidia devices/env for nvidia GPU mode", () => {
    const settings = applyDefaults({ advanced: { gpu: "nvidia" } });
    const config = buildContainerConfig(settings, PINNED_TAG);
    expect(config.devices).toEqual([
      "/dev/nvidia0",
      "/dev/nvidiactl",
      "/dev/nvidia-uvm",
      "/dev/nvidia-uvm-tools",
      "/dev/nvidia-modeset",
    ]);
    expect(config.env).toEqual({
      NVIDIA_VISIBLE_DEVICES: "all",
      NVIDIA_DRIVER_CAPABILITIES: "compute,utility",
    });
  });
});

describe("CONFIG_SCHEMA", () => {
  it("declares defaults matching defaultSettings()", () => {
    const props = CONFIG_SCHEMA.properties;
    const d = defaultSettings();
    expect(props.imageTag.default).toBe(d.imageTag);
    expect(props.models.default).toEqual(d.models);
    expect(props.port.default).toBe(d.port);
    const adv = props.advanced.properties;
    expect(adv.bind.default).toBe(d.advanced.bind);
    expect(adv.memoryLimit.default).toBe(d.advanced.memoryLimit);
    expect(adv.restartPolicy.default).toBe(d.advanced.restartPolicy);
    expect(adv.gpu.default).toBe(d.advanced.gpu);
    const mcp = props.mcp.properties;
    expect(mcp.enabled.default).toBe(d.mcp.enabled);
    expect(mcp.connections.default).toEqual(d.mcp.connections);
  });
});
