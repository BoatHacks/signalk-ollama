/**
 * signalk-ollama configuration: JSON schema, defaults, and the pure
 * settings → ContainerConfig mapping consumed by signalk-container-helper.
 */

import type { ContainerConfig } from "signalk-container-helper";

export const PLUGIN_ID = "signalk-ollama";
export const PLUGIN_NAME = "Ollama";
/** Unprefixed container name; runs as `sk-ollama` on the host runtime. */
export const CONTAINER_NAME = "ollama";
export const IMAGE = "ollama/ollama";
/** Pinned, tested upstream release; `imageTag: "auto"` resolves to this. */
export const PINNED_TAG = "0.32.10";
export const DEFAULT_PORT = 11434;

export type GpuMode = "none" | "amd" | "nvidia";

export interface AdvancedSettings {
  /**
   * "127.0.0.1": Signal K-only networking via signalkAccessiblePorts.
   * "0.0.0.0": publish the port on all interfaces so other machines (or
   * sibling containers not on the Signal K bridge network) can reach it.
   */
  bind: "127.0.0.1" | "0.0.0.0";
  memoryLimit: string;
  restartPolicy: "no" | "unless-stopped" | "always";
  /**
   * Best-effort GPU passthrough. "amd" bind-mounts the ROCm device nodes and
   * runs the image's `-rocm` tag variant — this works from device nodes
   * alone. "nvidia" bind-mounts the Nvidia device nodes, but full CUDA
   * acceleration normally also needs the host's container runtime configured
   * with the nvidia-container-toolkit (CDI or the `--gpus` runtime hook),
   * which signalk-container does not currently expose — see the README.
   */
  gpu: GpuMode;
}

export interface OllamaSettings {
  imageTag: string;
  /** Models to pull automatically once the server answers, e.g. "llama3.2:3b". */
  models: string[];
  port: number;
  advanced: AdvancedSettings;
}

export function defaultSettings(): OllamaSettings {
  return {
    imageTag: "auto",
    models: [],
    port: DEFAULT_PORT,
    advanced: {
      bind: "127.0.0.1",
      memoryLimit: "4g",
      restartPolicy: "unless-stopped",
      gpu: "none",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a non-empty, plausible Ollama model reference (no whitespace). */
export function isValidModelName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.trim().length > 0 &&
    !/\s/.test(name.trim())
  );
}

function sanitizeModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const models: string[] = [];
  for (const entry of raw) {
    if (!isValidModelName(entry)) continue;
    const trimmed = entry.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    models.push(trimmed);
  }
  return models;
}

/**
 * Merge raw plugin config over the defaults. Signal K does NOT seed schema
 * defaults into saved configurations, and hand-edited config files can hold
 * anything — every field is validated and falls back to its default.
 */
export function applyDefaults(raw: unknown): OllamaSettings {
  const defaults = defaultSettings();
  if (!isRecord(raw)) return defaults;
  const adv = isRecord(raw.advanced) ? raw.advanced : {};

  const imageTag =
    typeof raw.imageTag === "string" && raw.imageTag.trim() !== ""
      ? raw.imageTag.trim()
      : defaults.imageTag;
  const port =
    typeof raw.port === "number" &&
    Number.isInteger(raw.port) &&
    raw.port > 0 &&
    raw.port <= 65535
      ? raw.port
      : defaults.port;
  const bind = adv.bind === "0.0.0.0" ? "0.0.0.0" : defaults.advanced.bind;
  const memoryLimit =
    typeof adv.memoryLimit === "string" && adv.memoryLimit.trim() !== ""
      ? adv.memoryLimit.trim()
      : defaults.advanced.memoryLimit;
  const restartPolicy =
    adv.restartPolicy === "no" ||
    adv.restartPolicy === "always" ||
    adv.restartPolicy === "unless-stopped"
      ? adv.restartPolicy
      : defaults.advanced.restartPolicy;
  const gpu =
    adv.gpu === "amd" || adv.gpu === "nvidia" ? adv.gpu : defaults.advanced.gpu;

  return {
    imageTag,
    models: sanitizeModels(raw.models),
    port,
    advanced: { bind, memoryLimit, restartPolicy, gpu },
  };
}

/**
 * Maps the user-facing tag to the tag actually pulled: "auto" → pinned
 * release, then a GPU-mode suffix. NEVER settings-independent — the caller
 * closes over the live settings so switching GPU mode is picked up on the
 * next start/update without needing a distinct "tag" field per mode.
 */
export function resolveTag(requested: string, gpu: GpuMode): string {
  const base = requested === "auto" ? PINNED_TAG : requested;
  if (gpu !== "amd") return base;
  return base.endsWith("-rocm") ? base : `${base}-rocm`;
}

/** True for plain numeric semver tags like "0.32.10" (update-check filter). */
export function isSemverTag(tag: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(tag);
}

const AMD_GPU_DEVICES = ["/dev/kfd", "/dev/dri"];
const AMD_GPU_GROUPS = ["video", "render"];
const NVIDIA_GPU_DEVICES = [
  "/dev/nvidia0",
  "/dev/nvidiactl",
  "/dev/nvidia-uvm",
  "/dev/nvidia-uvm-tools",
  "/dev/nvidia-modeset",
];

/**
 * Pure, deterministic settings → ContainerConfig mapping. Called on every
 * start/update; every field is always present and stable so
 * signalk-container's drift detection never recreate-loops.
 *
 * Networking: by default the API port is declared via
 * `signalkAccessiblePorts` (published on host loopback on bare metal; wired
 * to the right network on containerized Signal K). `bind: "0.0.0.0"`
 * switches to an explicit all-interfaces port publish — for sibling
 * containers (Whisper, Wyoming, Piper) that need to reach Ollama directly
 * rather than through Signal K, or for sharing it on the LAN. The two
 * mechanisms must never be combined on the same port.
 */
export function buildContainerConfig(
  settings: OllamaSettings,
  tag: string,
): ContainerConfig {
  const config: ContainerConfig = {
    image: IMAGE,
    tag,
    // Pulled models land in /root/.ollama; mounting the plugin's Signal K
    // data dir there makes them survive container recreation (offline-first
    // — a boat should not have to re-download a 4 GB model after an update).
    signalkDataMount: "/root/.ollama",
    restart: settings.advanced.restartPolicy,
    resources: {
      memory: settings.advanced.memoryLimit,
      memorySwap: settings.advanced.memoryLimit,
    },
  };
  if (settings.advanced.bind === "0.0.0.0") {
    config.ports = { [String(DEFAULT_PORT)]: `0.0.0.0:${settings.port}` };
  } else {
    config.signalkAccessiblePorts = [DEFAULT_PORT];
  }
  if (settings.advanced.gpu === "amd") {
    config.devices = [...AMD_GPU_DEVICES];
    config.groupAdd = [...AMD_GPU_GROUPS];
  } else if (settings.advanced.gpu === "nvidia") {
    config.devices = [...NVIDIA_GPU_DEVICES];
    config.env = {
      NVIDIA_VISIBLE_DEVICES: "all",
      NVIDIA_DRIVER_CAPABILITIES: "compute,utility",
    };
  }
  return config;
}

export const CONFIG_SCHEMA = {
  type: "object",
  properties: {
    models: {
      type: "array",
      title: "Models to pull",
      items: { type: "string" },
      default: [],
      description:
        "Ollama models to download and keep ready (e.g. llama3.2:3b, " +
        "qwen2.5:7b). Pulled once on first start and re-checked on every " +
        "restart; leave empty to just run the bare server and pull models " +
        "yourself (ollama pull, or another service's API calls). Browse " +
        "models at https://ollama.com/library.",
    },
    imageTag: {
      type: "string",
      title: "Image tag",
      default: "auto",
      description:
        `Docker image tag for ${IMAGE}. 'auto' runs the pinned, tested ` +
        `release (${PINNED_TAG}) and follows this plugin's updates. Set an ` +
        "explicit tag only if you need to pin a different upstream " +
        "version. Ignored (a -rocm variant is used instead) when GPU mode " +
        "is set to amd.",
    },
    port: {
      type: "number",
      title: "Host port",
      default: DEFAULT_PORT,
      description:
        "Host TCP port for the Ollama API — only used with 'Bind address' " +
        "0.0.0.0, where the service is published on exactly this port. " +
        "With the default loopback networking this setting is ignored: " +
        "signalk-container assigns the host port automatically (normally " +
        "11434, the next free port if that is taken).",
    },
    advanced: {
      type: "object",
      title: "Advanced",
      properties: {
        bind: {
          type: "string",
          title: "Bind address",
          enum: ["127.0.0.1", "0.0.0.0"],
          default: "127.0.0.1",
          description:
            "127.0.0.1 (default) keeps Ollama reachable only from this " +
            "machine. 0.0.0.0 publishes it on all interfaces so sibling " +
            "containers (signalk-whisper, signalk-wyoming, signalk-piper) " +
            "or other machines on the LAN can call it directly. The Ollama " +
            "API has no authentication: only expose it on trusted networks.",
        },
        memoryLimit: {
          type: "string",
          title: "Memory limit",
          default: "4g",
          description:
            "Hard container memory cap (docker syntax, e.g. 4g, 8192m). " +
            "Swap is capped to the same value. Size it to the largest " +
            "model you plan to run — a model that does not fit gets OOM " +
            "killed mid-generation.",
        },
        restartPolicy: {
          type: "string",
          title: "Restart policy",
          enum: ["no", "unless-stopped", "always"],
          default: "unless-stopped",
          description: "Container runtime restart policy.",
        },
        gpu: {
          type: "string",
          title: "GPU acceleration",
          enum: ["none", "amd", "nvidia"],
          default: "none",
          description:
            "'none' (default): CPU inference — fine for small models on a " +
            "Pi/NUC. 'amd': passes through /dev/kfd and /dev/dri and runs " +
            "the -rocm image variant (works from device nodes alone). " +
            "'nvidia': passes through the Nvidia device nodes, but full " +
            "CUDA acceleration usually also needs the host's container " +
            "runtime configured for Nvidia (nvidia-container-toolkit / " +
            "CDI) — signalk-container does not yet drive that itself, so " +
            "this is best-effort. See the README before relying on it.",
        },
      },
    },
  },
} as const;

export const UI_SCHEMA = {
  models: {
    "ui:options": { orderable: false },
  },
} as const;
