# signalk-ollama

> **Status: ALPHA.** Freshly built, not yet run against real boat hardware.
> It _should_ work. File issues for anything that doesn't.

## What is this?

[Ollama](https://ollama.com) as a [Signal K](https://signalk.org) managed
container — a local LLM server other software on the boat can call. The
plugin starts Ollama in a container (via the
[signalk-container](https://www.npmjs.com/package/signalk-container) plugin),
waits for its API to answer, pulls whatever models you've configured, and
keeps it healthy. You never have to touch docker or podman yourself.

It exists to feed **other plugins and services** that speak the
[Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md) —
[signalk-voice-llm](https://github.com/BoatHacks/signalk-voice-llm),
[signalk-ai-bridge](https://github.com/BoatHacks/signalk-ai-bridge), a
voice assistant summarizing the day's log, an alert-narration plugin, a
chatbot panel, or a script you wrote yourself. signalk-ollama does not do any
of that itself — it just makes sure a local LLM is running and has the
models you asked for.

## Requirements

- Signal K server ≥ 2.x on **Node 24+**
- The **signalk-container** plugin with a working podman or docker runtime
- RAM/disk for whatever models you configure — see "Sizing". CPU inference on
  a Raspberry Pi or small NUC is fine for small (≤ 3B) models; bigger models
  want more RAM and, ideally, a GPU (see "GPU acceleration").

## Install

Install **signalk-ollama** from the Signal K App Store (or `npm install
signalk-ollama` in your server directory), enable it in Plugin Config, and
enable the signalk-container plugin if you have not already.

## Configuration

The plugin ships a graphical configuration panel (Server → Plugin Config →
Ollama) with a live container status card, a one-click image update
check/apply, a version dropdown fed by Docker Hub, a model list editor with
per-model pull progress, and the settings below. On servers without
custom-panel support you get a plain settings form with the same options.

| Setting                  | Default           | Notes                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models`                 | `["llama3.2:3b"]` | Models to pull automatically. Defaults to `llama3.2:3b` (~2.0 GB) so Ollama is usable out of the box. Re-checked on every start; already-present models are skipped. Clear the list to run a bare server — pull models yourself with `ollama pull` or another service's API calls. Ollama can't answer chat/generate requests for a model until its pull finishes — see "Pulling models". |
| `imageTag`               | `auto`            | `auto` runs the pinned, tested upstream release (**0.32.10**) and follows plugin updates. Ignored (a `-rocm` variant is used instead) when GPU mode is `amd`.                                                                                                                                                                                                                             |
| `port`                   | `11434`           | Host TCP port Ollama is published on (default `advanced.bind` is `0.0.0.0`, so this applies out of the box). Ignored if you switch `advanced.bind` to `127.0.0.1` — signalk-container then assigns a host port automatically instead.                                                                                                                                                     |
| `advanced.bind`          | `0.0.0.0`         | `0.0.0.0` (default) publishes Ollama on all interfaces so sibling containers and other machines on the LAN can call it directly — see "Security". `127.0.0.1` restricts it to this machine only.                                                                                                                                                                                          |
| `advanced.memoryLimit`   | `4g`              | Hard container memory cap (swap capped to the same value). Size it to your largest model — see "Sizing".                                                                                                                                                                                                                                                                                  |
| `advanced.restartPolicy` | `unless-stopped`  | Container runtime restart policy.                                                                                                                                                                                                                                                                                                                                                         |
| `advanced.gpu`           | `none`            | `none` (CPU), `amd` (ROCm), or `nvidia` (best-effort). See "GPU acceleration".                                                                                                                                                                                                                                                                                                            |

### Sizing

Ollama models range from ~1 GB (small distilled/quantized models) to tens of
GB. As a rule of thumb, budget resident RAM roughly equal to the model's
download size, plus headroom for Signal K and everything else running on the
box. Set `advanced.memoryLimit` above that, or the container gets OOM-killed
mid-generation. On a Pi 4/5 or small NUC, stick to models in the 1B–3B range
(quantized) unless you've confirmed the latency is acceptable.

### GPU acceleration

- **`none` (default).** CPU inference. Works everywhere; slow for anything
  beyond small models.
- **`amd`.** Passes through `/dev/kfd` and `/dev/dri` and runs the image's
  `-rocm` tag variant. This works from device nodes alone — no extra host
  configuration needed beyond a ROCm-capable kernel driver.
- **`nvidia`.** Passes through the Nvidia device nodes (`/dev/nvidia0`,
  `/dev/nvidiactl`, …) and sets `NVIDIA_VISIBLE_DEVICES=all`. This is
  **best-effort**: full CUDA acceleration normally also requires the host's
  container runtime to be configured for Nvidia (the
  [nvidia-container-toolkit](https://github.com/NVIDIA/nvidia-container-toolkit)
  runtime hook, or CDI), which `signalk-container` does not yet drive itself.
  If your host already has the Nvidia runtime set up, this may be enough; if
  not, Ollama will fall back to CPU inference inside the container rather
  than failing outright. Track
  [dirkwa/signalk-container](https://github.com/dirkwa/signalk-container) for
  first-class `--gpus`/CDI support.

### Security

The Ollama API has **no authentication** — anyone who can reach the port can
use the model (and, on some builds, manage what's pulled). The default
`advanced.bind: 0.0.0.0` publishes it on every interface on the host, which
is what lets sibling containers and other boat systems call it — that's the
point of running it. If your boat's network isn't trusted (marina wifi,
guests, an exposed router), either set `advanced.bind` to `127.0.0.1` (only
Signal K's own host loopback can reach it — sibling containers on a separate
network then can't either) or firewall port 11434 at the network level.

## Pulling models

**Ollama isn't usable until at least one model finishes pulling** — the
config panel and webapp both call this out with a banner while none of your
configured models are `ready`. By default that's just `llama3.2:3b`
(~2.0 GB); the first start downloads it automatically, and both the panel
and webapp let you watch progress.

Add model names in the config panel (or the `models` array) and save —
Signal K restarts the plugin, which pulls anything not already present. Pull
progress shows in the plugin status line and per-model in the config panel;
a bad model name fails that one model without blocking the others. Add a
model later via the panel's "Add model" + "Pull now" without waiting for a
restart, or remove one you no longer want. Model sizes vary widely (roughly
1–5 GB for small/medium models, more for large ones) — check the size shown
on [ollama.com/library](https://ollama.com/library) before adding one on a
slow or metered connection.

Pulls happen over the Ollama API (`/api/pull`) — the same thing `ollama pull
<model>` does on the CLI, but driven by the plugin so it survives across
container recreates (models land in this plugin's Signal K data directory,
which is preserved across updates).

**Do the first pull of any model while you have internet** — at sea with no
connectivity, a never-downloaded model cannot load.

## Using it from other software

Once ready, Ollama is a plain HTTP API server at `http://<host>:<port>`
(normally `http://<boat-ip>:11434` — published on all interfaces by
default, see "Security"):

- **Other Signal K plugins** — [signalk-voice-llm](https://github.com/BoatHacks/signalk-voice-llm),
  [signalk-ai-bridge](https://github.com/BoatHacks/signalk-ai-bridge), or
  anything else — reach it at the host's address and port, pointing at this
  server's `/api/generate` or `/api/chat` endpoint. The default
  `advanced.bind: 0.0.0.0` is what makes this work without extra setup. Set
  `advanced.bind` to `127.0.0.1` only if nothing outside Signal K's own
  process needs it.
- **Anything else that speaks Ollama's API** — a script, a chatbot panel, or
  Home Assistant's Ollama integration — can use it the same way. Ollama has
  no built-in authentication: only expose `0.0.0.0` on trusted networks.

## The webapp

Besides the plugin config panel, signalk-ollama ships a standalone webapp —
find it under Server → Webapps → **Ollama** (or the App Store's webapps
list). Two views:

- **Status** — the same container/model state as the config panel's status
  card, in a dedicated dashboard, polled every 5s.
- **Playground** — pick a ready model, chat with it, watch the response
  stream token by token. Below the chat, **recent interactions** lists past
  exchanges from this server session (model, prompt, response, duration) —
  kept in memory only, cleared on a server restart, not written to disk.

The playground talks to Ollama through the plugin's own backend
(`POST /api/chat`, proxying to Ollama's `/api/chat`) rather than the browser
calling Ollama directly — Ollama has no CORS allowlist for the Admin UI's
origin, so a direct browser call would likely be blocked, and proxying
through the backend is what makes the interaction log possible at all.

## Development

```bash
npm install
npm test          # typecheck (source + tests), then vitest (fully mocked — no containers needed)
npm run build     # tsc → dist/, webpack → public/ (config panel)
npm run format    # prettier --write + eslint --fix
npm run ci-lint   # eslint + prettier --check (what CI runs)
```

## License

Apache-2.0
