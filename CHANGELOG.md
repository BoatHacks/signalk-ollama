# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.6] - 2026-08-15

### Fixed

- MCP tool calls could fail with "SSE response carried no data frame" even
  after the 0.2.4 fix, when the server-side session went stale between the
  pre-round tool probe and the model actually requesting the call — e.g. an
  idle timeout or a container restart in between. This surfaced as an
  instant, empty response rather than a clear session error. Tool calls now
  get one retry, with the connection's session reset and re-initialized in
  between, before the failure is reported back to the model. Visible in the
  downloadable session log as "retrying once after session reset".

## [0.2.5] - 2026-08-15

### Added

- Playground: a "Download session log" link next to the chat controls,
  downloading a plain-text backend activity log for the current
  session — MCP connection probes, tool calls and their results, round
  timing, and errors. Distinct from the chat transcript itself (already
  visible in the browser) and from "recent interactions" (a short summary
  per exchange); this is the detail needed to debug why a tool call failed
  or which MCP connection served it, without digging through Signal K's
  server log. In-memory only, capped at the last 20 sessions and 2,000
  lines per session, cleared on a server restart like the rest of the
  playground's state. A fresh session starts (and gets its own log) each
  page load and on "Clear conversation".

## [0.2.4] - 2026-08-15

### Fixed

- MCP tool calls could fail with "SSE response carried no data frame" for
  longer-running tools (e.g. `execute_code`) whose Streamable HTTP response
  streams progress notifications before the actual result — the client only
  ever looked at the first SSE event. It now parses every event in the
  stream and picks the one whose `id` matches the request, skipping
  notifications along the way.

## [0.2.3] - 2026-08-14

### Added

- MCP tool support in chat: when `mcp.enabled` (default on), `/api/chat` —
  the playground included — offers tools from configured
  [MCP](https://modelcontextprotocol.io) (Streamable HTTP) connections to
  the model via Ollama's tool-calling API, executes any tool calls it makes,
  and feeds the results back for up to a few rounds. Defaults to one
  connection: [signalk-mcp-container](https://github.com/BoatHacks/signalk-mcp-container)
  at `http://localhost:8000/mcp`, reachable directly since both plugins'
  backends run in the same Signal K process. Manage connections (add,
  remove, enable/disable, test) from the config panel's new "MCP tool
  connections" section; tool calls and results show up inline in the
  playground transcript.

### Changed

- App Store `recommends` (and other user-facing mentions of typical Ollama
  callers) now list `signalk-voice-llm` and `signalk-ai-bridge` instead of
  `signalk-whisper`/`signalk-wyoming`/`signalk-piper` — those three were
  cited as examples of the `signalk-container` managed-container pattern,
  not as things that actually speak the Ollama API, and recommending them
  as Ollama consumers was misleading.

## [0.2.2] - 2026-08-14

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
