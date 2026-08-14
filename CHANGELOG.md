# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-08-14

### Added

- Project icon (the captain-hat llama): App Store/webapp-list icon via
  `signalk.appIcon`, plus a `public/favicon.ico`. Sizes 16–512px live under
  `public/assets/icons/`; the full-resolution source is kept at
  `assets/branding/icon-source.png` (not shipped in the npm package) for
  regenerating them later.
- A standalone webapp (Server → Webapps → Ollama), separate from the plugin
  config panel: a status dashboard (container/model state, polled live) and
  an LLM playground — pick a ready model, chat with it, watch the response
  stream in. Every playground exchange is logged to a "recent interactions"
  list for the current server session (in-memory only, not persisted).
  Chat is proxied through the plugin's own backend rather than the browser
  calling Ollama directly, sidestepping Ollama's lack of a CORS allowlist
  for the Admin UI's origin and letting the server log what was asked.
- Plugin router additions backing the webapp: `POST /api/chat` (streaming
  NDJSON proxy to Ollama's `/api/chat`) and `GET /api/interactions`.
- `POST /api/models/pull` failures are now logged via the plugin's error
  log (previously only visible in the HTTP response body).

## [0.1.0] - 2026-08-13

### Added

- Initial release: [Ollama](https://ollama.com) as a Signal K managed
  container — a local LLM server for other containerized services on the
  boat (signalk-whisper, signalk-wyoming, signalk-piper) or anything else
  that speaks the Ollama API.
- Managed container lifecycle via `signalk-container-helper`'s
  `ManagedContainer`: pulls a pinned, tested release of `ollama/ollama`
  (`imageTag: auto` follows plugin updates), waits for the API to answer,
  and offers image update check/apply from Signal K.
- Automatic model pulling: a configurable `models` list is pulled on start
  (already-present models are skipped), with per-model progress and a
  status-line summary. Add/remove/pull models on demand from the config
  panel without restarting.
- Graphical configuration panel (Server → Plugin Config → Ollama): live
  container status, image update check/apply, a Docker Hub version
  dropdown, and a model list editor with per-model pull progress.
- Optional GPU acceleration: `amd` passes through ROCm device nodes and
  runs the image's `-rocm` variant; `nvidia` passes through Nvidia device
  nodes as a best-effort option (documented limitation: full CUDA support
  also needs the host's container runtime configured for Nvidia, which
  `signalk-container` does not yet drive).
- Plugin router: `GET /api/status`, `GET /api/versions`,
  `POST /api/models/pull`, plus the standard `signalk-container-helper`
  update routes.
