# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- `models` now defaults to `["llama3.2:3b"]` (was `[]`) — Ollama pulls a
  small, usable model on first start instead of running bare. Clear the
  list in the config panel to opt back out.

### Added

- The config panel and standalone webapp now show a warning banner while
  none of the configured models have finished pulling, since Ollama can't
  answer chat/generate requests until then, along with the default model's
  approximate download size (~2.0 GB) and a size note when adding others.

## [0.2.1] - 2026-08-14

### Changed

- `advanced.bind` now defaults to `0.0.0.0` (was `127.0.0.1`) — Ollama is
  published on all interfaces out of the box, so sibling containers
  (signalk-whisper, signalk-wyoming, signalk-piper) and other boat systems
  can actually reach it without extra configuration. With the old default,
  only signalk-container's own loopback path to Signal K worked; other
  containers could not reach Ollama at all. Set `advanced.bind` back to
  `127.0.0.1` to restrict it to this machine only — see the README's
  "Security" section (the Ollama API has no authentication).

### Added

- Added the `npm publish` job to the release workflow (OIDC trusted
  publishing — no `NPM_TOKEN`) now that a trusted publisher is configured
  on npmjs.com. `/plugin-release` now publishes automatically as part of
  cutting a release.

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
