/**
 * Custom plugin-config panel for the Signal K Admin UI, built on the shared
 * signalk-container-helper/ui building blocks. Replaces the JSON-schema
 * auto-form (which remains the fallback on servers without panel support):
 * live container status card, image update check/apply, a Docker Hub
 * version dropdown fed by /api/versions, a model list editor with per-model
 * pull progress, and the port/advanced settings.
 *
 * Loaded as a webpack Module Federation remote; `react` resolves to the
 * Admin UI's shared singleton. The defaults mirror ../config.ts — the panel
 * bundle cannot import the Node-only server code.
 */

import React, { useState } from "react";
import {
  panelStyles as S,
  stateColors,
  SectionTitle,
  StatusCard,
  FieldRow,
  VersionSelect,
  UpdateControls,
  CollapsibleSection,
  ActionStatus,
  Button,
  useStatusPoll,
  useVersions,
} from "signalk-container-helper/ui";

const BASE = "/plugins/signalk-ollama";
const IMAGE = "ollama/ollama";
const DEFAULT_PORT = 11434;

/** Mirrors defaultSettings() in ../config.ts. */
const DEFAULTS = {
  imageTag: "auto",
  models: ["llama3.2:3b"],
  bind: "0.0.0.0",
  memoryLimit: "4g",
  restartPolicy: "unless-stopped",
  gpu: "none",
};
/** ~2.0 GB download — shown so users know what they're about to pull. */
const DEFAULT_MODEL_SIZE = "~2.0 GB";

function modelStatusLabel(state) {
  if (!state) return "not pulled";
  if (state.status === "ready") return "ready";
  if (state.status === "error") return `error: ${state.error ?? "unknown"}`;
  if (state.status === "pulling") {
    const pct = typeof state.percent === "number" ? ` ${state.percent}%` : "";
    return `pulling${pct}${state.message ? ` — ${state.message}` : ""}`;
  }
  return "pending";
}

function modelStatusColor(state) {
  if (!state) return undefined;
  if (state.status === "ready") return stateColors.ok;
  if (state.status === "error") return stateColors.error;
  if (state.status === "pulling") return stateColors.warn;
  return undefined;
}

export default function PluginConfigurationPanel({ configuration, save }) {
  const cfg = configuration || {};
  const adv = cfg.advanced || {};

  const [models, setModels] = useState(
    Array.isArray(cfg.models) ? cfg.models : DEFAULTS.models,
  );
  const [newModel, setNewModel] = useState("");
  const [imageTag, setImageTag] = useState(cfg.imageTag || DEFAULTS.imageTag);
  const [port, setPort] = useState(String(cfg.port ?? DEFAULT_PORT));
  const [bind, setBind] = useState(
    adv.bind === "0.0.0.0" ? "0.0.0.0" : DEFAULTS.bind,
  );
  const [memoryLimit, setMemoryLimit] = useState(
    adv.memoryLimit || DEFAULTS.memoryLimit,
  );
  const [restartPolicy, setRestartPolicy] = useState(
    adv.restartPolicy || DEFAULTS.restartPolicy,
  );
  const [gpu, setGpu] = useState(adv.gpu || DEFAULTS.gpu);
  const [saved, setSaved] = useState("");
  const [pulling, setPulling] = useState("");

  const { status, loading, refresh } = useStatusPoll(`${BASE}/api/status`, {
    fallback: { status: "not_running" },
  });
  const versions = useVersions(`${BASE}/api/versions`);

  const st =
    status && typeof status.status === "string" ? status.status : "not_running";
  const state = st === "ready" ? "ok" : st === "starting" ? "warn" : "error";
  const meta = loading
    ? "Checking..."
    : st === "ready"
      ? `${IMAGE}:${status.tag} at ${status.uri}`
      : st === "starting"
        ? "Starting..."
        : st === "error"
          ? `Not answering${status && status.uri ? ` at ${status.uri}` : ""}`
          : "Not running";

  const modelStates = (status && status.models) || {};

  const addModel = () => {
    const name = newModel.trim();
    if (name === "" || models.includes(name)) return;
    setModels([...models, name]);
    setNewModel("");
  };

  const removeModel = (name) => {
    setModels(models.filter((m) => m !== name));
  };

  const pullNow = async (name) => {
    setPulling(name);
    try {
      const res = await fetch(`${BASE}/api/models/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      void refresh();
    } catch {
      // Surfaced via the model's own status on the next poll; nothing more
      // to do here than stop the busy spinner.
    } finally {
      setPulling("");
    }
  };

  const doSave = () => {
    const portNumber = Number(port);
    save({
      ...cfg,
      models,
      imageTag,
      port:
        port !== "" && Number.isFinite(portNumber) ? portNumber : DEFAULT_PORT,
      advanced: { bind, memoryLimit, restartPolicy, gpu },
    });
    setSaved("Saved. Signal K restarts the plugin with the new configuration.");
  };

  return (
    <div style={S.root}>
      <SectionTitle>Ollama status</SectionTitle>
      <StatusCard
        icon="O"
        iconBackground={st === "ready" ? "#0ea5e9" : undefined}
        title="Ollama"
        meta={meta}
        state={state}
        stateTitle={st}
      />

      {st !== "not_running" && st !== "stopped" && (
        <UpdateControls
          checkUrl={`${BASE}/api/update/check`}
          applyUrl={`${BASE}/api/update/apply`}
          tag={imageTag}
          onApplied={() => void refresh()}
        />
      )}

      <SectionTitle>Models</SectionTitle>
      {models.length === 0 && (
        <div style={S.hint}>
          No models configured — Ollama runs bare and other services can
          pull/use models via its API directly.
        </div>
      )}
      {models.length > 0 &&
        !models.some((name) => modelStates[name]?.status === "ready") && (
          <div style={{ ...S.hint, color: stateColors.warn }}>
            Ollama is not usable yet — no model has finished pulling. Models
            download automatically on start, or click "Pull now" below to start
            immediately. The default model, llama3.2:3b, is a{" "}
            {DEFAULT_MODEL_SIZE} download; larger models can take a while
            depending on your connection.
          </div>
        )}
      {models.map((name) => {
        const st2 = modelStates[name];
        return (
          <FieldRow key={name} label={name}>
            <span style={{ color: modelStatusColor(st2) }}>
              {modelStatusLabel(st2)}
            </span>
            <Button
              onClick={() => pullNow(name)}
              disabled={pulling === name}
              style={{ marginLeft: 12 }}
            >
              {pulling === name ? "Pulling..." : "Pull now"}
            </Button>
            <Button onClick={() => removeModel(name)} style={{ marginLeft: 8 }}>
              Remove
            </Button>
          </FieldRow>
        );
      })}
      <FieldRow
        label="Add model"
        hint="e.g. llama3.2:3b (~2.0 GB) — sizes vary by model, browse ollama.com/library"
      >
        <input
          style={{ ...S.input, width: 220 }}
          value={newModel}
          onChange={(e) => setNewModel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addModel();
            }
          }}
          placeholder="llama3.2:3b"
        />
        <Button onClick={addModel} style={{ marginLeft: 8 }}>
          Add
        </Button>
      </FieldRow>

      <SectionTitle>Settings</SectionTitle>
      <FieldRow label="Image version">
        <VersionSelect
          value={imageTag}
          onChange={setImageTag}
          versions={versions.versions}
          floatingOptions={[
            { tag: "auto", label: "auto (pinned release, recommended)" },
          ]}
          loading={versions.loading}
          error={versions.versionsError}
          onRefresh={versions.refresh}
        />
      </FieldRow>
      <FieldRow label="Port" hint="leave at 11434 unless it collides">
        <input
          style={{ ...S.input, width: 90 }}
          type="number"
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
      </FieldRow>

      <CollapsibleSection title="Advanced">
        <FieldRow
          label="Bind address"
          hint={
            bind === "0.0.0.0"
              ? "reachable by sibling containers and the LAN — the Ollama API has no authentication, only run this on trusted networks"
              : "restricted to this machine only — sibling containers (signalk-whisper, signalk-wyoming, signalk-piper) will not be able to reach it"
          }
          hintColor={bind === "0.0.0.0" ? undefined : stateColors.warn}
        >
          <select
            style={S.select}
            value={bind}
            onChange={(e) => setBind(e.target.value)}
          >
            <option value="0.0.0.0">
              0.0.0.0 (recommended — all interfaces)
            </option>
            <option value="127.0.0.1">127.0.0.1 (this machine only)</option>
          </select>
        </FieldRow>
        <FieldRow
          label="Memory limit"
          hint='hard cap, e.g. "4g" — size to your largest model'
        >
          <input
            style={{ ...S.input, width: 90 }}
            value={memoryLimit}
            onChange={(e) => setMemoryLimit(e.target.value)}
          />
        </FieldRow>
        <FieldRow label="Restart policy">
          <select
            style={S.select}
            value={restartPolicy}
            onChange={(e) => setRestartPolicy(e.target.value)}
          >
            <option value="unless-stopped">unless-stopped</option>
            <option value="always">always</option>
            <option value="no">no</option>
          </select>
        </FieldRow>
        <FieldRow
          label="GPU acceleration"
          hint={
            gpu === "nvidia"
              ? "best-effort — usually also needs the host's runtime configured for Nvidia; see README"
              : gpu === "amd"
                ? "passes through /dev/kfd + /dev/dri and runs the -rocm image variant"
                : "CPU inference"
          }
          hintColor={gpu === "nvidia" ? stateColors.warn : undefined}
        >
          <select
            style={S.select}
            value={gpu}
            onChange={(e) => setGpu(e.target.value)}
          >
            <option value="none">none (CPU)</option>
            <option value="amd">amd (ROCm)</option>
            <option value="nvidia">nvidia (best-effort)</option>
          </select>
        </FieldRow>
      </CollapsibleSection>

      <div style={{ marginTop: 24 }}>
        <Button onClick={doSave}>Save Configuration</Button>
      </div>
      <ActionStatus message={saved} />
    </div>
  );
}
