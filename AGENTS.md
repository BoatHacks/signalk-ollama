# AGENTS.md

Working notes for AI agents and human contributors.

## What this is

A Signal K plugin that runs [Ollama](https://ollama.com) as a managed
container (via [signalk-container](https://github.com/dirkwa/signalk-container),
through the [signalk-container-helper](https://github.com/hoeken/signalk-container-helper)
library) and pulls whatever models are configured. It is the same "managed
container" archetype as
[signalk-whisper](https://github.com/hoeken/signalk-whisper),
[signalk-wyoming](https://github.com/hoeken/signalk-wyoming), and
[signalk-piper](https://github.com/hoeken/signalk-piper) — read one of those
for a second example of the pattern before changing the lifecycle code here.

The plugin's core job is still just making sure a local Ollama server is
running with the right models, for other services to call — it does not do
anything with the LLM on their behalf. The one exception is the bundled
webapp's playground (see below): a thin, in-repo consumer that exists to
let an operator test the server and see recent activity, not a pipeline
other plugins are expected to build on.

## Layout

```
src/
  config.ts        settings schema, defaults, pure settings → ContainerConfig
  ollama-api.ts     Ollama HTTP client: list/pull/delete models, chat proxy
  service.ts        OllamaService — container lifecycle, model reconcile, routes
  index.ts          Signal K plugin factory wiring service.ts to the app
  configpanel/       Admin UI panel (Module Federation remote, no JSX in dist)
test/               vitest suites, fully mocked (no real containers/network)
public/
  index.html, app.js, styles.css   the standalone webapp (status + playground)
                                    — vanilla JS, no build step, matches
                                    signalk-wyoming's public/ webapp pattern
  assets/icons/     checked-in App Store/favicon icons (16-512px), NOT
                     webpack output — see the .gitignore comment before
                     broadening any "ignore public/" pattern
  remoteEntry.js, *.mjs   webpack output for configpanel/ — generated,
                          gitignored, do NOT hand-edit or commit
assets/branding/    full-res icon source, not shipped in the npm package
                    (not in package.json "files"); regenerate the sizes
                    under public/assets/icons/ from this if the logo changes
```

Two mount points, two prefixes — don't mix them up when adding a route:

- The **plugin backend** (`registerRoutes` in `service.ts`) is served under
  `/plugins/signalk-ollama/...` — this is what `public/app.js` and the
  config panel both call for JSON APIs.
- **Static files** in `public/` (the webapp's `index.html`/`app.js`/
  `styles.css`, and the config panel's `remoteEntry.js`) are served under
  `/signalk-ollama/...` (the bare package name — see `mountWebModules` in
  signalk-server's `webapps.ts`) via the `signalk-webapp` and
  `signalk-plugin-configurator` package.json keywords respectively. Both
  keywords point at the same `public/` directory; nothing here needs two
  separate build outputs.

## Commands

```bash
npm install
npm run build     # tsc -> dist/, webpack -> public/ (config panel)
npm test          # typecheck:test && vitest run
npm run ci-lint    # eslint && prettier --check .
npm run format     # prettier --write && eslint --fix
```

Run `build`, `test`, and `ci-lint` before pushing — CI runs the same three.

`package-lock.json` **is** committed here (unlike `signalk-container-helper`,
which is a library other projects resolve against their own tree). This is
an application/plugin, so a committed lockfile is the right call — install
with `npm ci` in CI, `npm install` locally when `package.json` changes.

## Key design decisions

- **Readiness is the library's built-in HTTP poll**, not a custom gate.
  `ManagedContainer`'s `readiness: { port, path: "/api/version" }` is enough
  because Ollama's server itself starts fast — the slow part (model
  downloads) happens _after_ readiness, driven separately by
  `OllamaService.reconcileModels`. Contrast with `signalk-piper`, which
  needs a custom Wyoming `describe` gate because voice downloads block
  before the service answers at all. Don't copy piper's gate pattern here;
  it would be solving a problem this plugin doesn't have.

- **GPU mode is settings-dependent, so `resolveTag` and `buildConfig` are
  closures over `this.settings`**, not pure top-level functions taking only
  a tag. `resolveTag(requested, gpu)` in `config.ts` is pure; the closure
  lives in `service.ts`'s `ManagedContainer` constructor
  (`resolveTag: (requested) => resolveTag(requested, this.settings.advanced.gpu)`).
  If you add another setting that affects the resolved tag or image, follow
  the same shape — don't thread it through `ManagedContainerOptions` some
  other way, `resolveTag` there is genuinely just `(tag: string) => string`.

- **`ollama-api.ts` uses the raw global `fetch`, not `signalk-container-helper`'s
  `fetchImpl` injection.** `OllamaService` takes an optional `fetchImpl` in its
  constructor and passes it to `ManagedContainer` (for the readiness poll
  only) — but `listLocalModels`/`pullModel`/`deleteModel` always use global
  `fetch`. Tests therefore stub `globalThis.fetch` directly (see
  `test/helpers.ts` and how `test/service.test.ts` uses `vi.stubGlobal`) —
  the constructor's `fetchImpl` option only needs to be _the same stubbed
  function_ passed twice, once directly and once via the constructor, for a
  single fetch mock to cover both paths in a test.

- **Model pulling is non-fatal per model.** A bad model name or a failed
  pull must not stop the container from being reported "ready" or block the
  rest of the configured models — see `reconcileModels`'s try/catch inside
  the loop. Preserve this if you touch it: a boat with five configured
  models and one typo should still get the other four.

- **`isValidModelName` rejects whitespace but does not otherwise validate
  against Ollama's model-name grammar.** It's a cheap guard against garbage
  input on the `/api/models/pull` route, not a full parser. Don't build
  logic elsewhere that assumes a stricter contract than "non-empty,
  no-whitespace string".

- **The playground proxies chat through the plugin backend instead of the
  browser calling Ollama directly.** Two reasons, both load-bearing: Ollama
  has no CORS allowlist for the Admin UI's origin (a direct browser fetch
  would likely be blocked), and proxying is what lets the server see the
  exchange at all to log it as an "interaction". Don't "simplify" the
  playground into a direct browser→Ollama fetch — it would both break under
  CORS and silently stop populating recent interactions.

- **`/api/chat`'s handler casts `ResponseLike` to a wider `StreamableResponse`**
  (`setHeader`/`write`/`end`) because `signalk-container-helper`'s router
  type only promises `status()`/`json()` — true for every other route here,
  but chat needs to stream. The real Express response supports this at
  runtime; the cast is safe, just don't assume `ResponseLike` alone is
  enough if you add another streaming route.

- **A streaming response can't fall back to a clean HTTP error status once
  bytes have gone out.** `/api/chat`'s error handling branches on whether
  anything was already written: nothing yet → `res.status(500).json(...)`
  like normal; something written → an in-stream `{error}` line instead,
  since headers are already committed. `public/app.js`'s reader loop treats
  an `{error}` line the same as a thrown fetch — keep both sides of that
  contract in sync if you touch either.

## Traps

- **In `applyDefaults`, an enum-like field's fallback must not be one of the
  valid values.** A pattern like `adv.bind === "0.0.0.0" ? "0.0.0.0" :
defaults.advanced.bind` only works by accident when the default happens to
  be the _other_ valid value — flip the default and it silently swallows an
  explicit setting equal to the old default. `bind` hit exactly this when its
  default changed from `127.0.0.1` to `0.0.0.0`: validate against the full
  set of valid literals (`adv.bind === "0.0.0.0" || adv.bind === "127.0.0.1"
? adv.bind : defaults.advanced.bind`), not a single one vs. "anything
  else". `config.test.ts`'s "accepts an explicit 127.0.0.1" test guards this
  — don't let it get deleted as "redundant" with the defaults test.

- **`PINNED_TAG` in `config.ts` goes stale.** It's a real Docker Hub tag
  captured at write time (see `resolveTag`'s `"auto"` mapping), not a
  placeholder — bump it deliberately when you have a reason to (a known bug
  in the pinned version, a feature you need), not reflexively on every
  release. Check current tags with
  `curl -s "https://hub.docker.com/v2/repositories/ollama/ollama/tags/?page_size=25&ordering=last_updated"`
  before changing it.

- **`buildContainerConfig` must stay pure** — same `(settings, tag)` in,
  identical `ContainerConfig` out, every time. `signalk-container` diffs
  this against the live container to decide whether to recreate; a field
  that toggles between two shapes for the same settings (e.g. `undefined`
  vs. omitted, or non-deterministic ordering in `models`) looks like drift
  on every single start. `config.test.ts`'s "is pure" test guards this —
  don't weaken it.

- **Recent interactions are in-memory only, capped at `MAX_INTERACTIONS`
  (50) with truncated text (`INTERACTION_TEXT_LIMIT`, 4000 chars).** This
  is deliberate, not a shortcut to fix later — nothing here should grow
  into a persisted chat history or transcript export without a real
  decision about retention/PII first. If a future change needs history to
  survive a restart, that's a new design conversation, not a one-line
  tweak to `service.ts`.

- **`public/app.js`/`index.html`/`styles.css` have no build step, and
  ESLint/Prettier don't check `app.js`** (`eslint.config.js` only covers
  `**/*.ts` and `src/configpanel/**/*.jsx`; ordinary `.js` files are
  outside its `files` globs). Nothing catches a typo there except actually
  loading the page. There's no headless-browser test harness set up in
  this repo for it — verify changes by serving `public/` and clicking
  through, or write a throwaway Playwright script against the pre-installed
  Chromium (`/opt/pw-browsers`) the way the webapp/playground/interactions
  feature was verified before landing, matching the version-pinned
  `chrome-linux/chrome` binary rather than `npx playwright install`.

- **Never mix a version bump into a feature or fix PR.** Version bumps get
  their own commit so the history stays bisectable.

- **Cut releases with `/plugin-release`, not by hand.** It bumps the
  version, converts the CHANGELOG's `[Unreleased]` section to a dated
  entry, tags, and cuts the GitHub release. In an agent sandbox, `git push`
  of a tag ref (`refs/tags/*`) is blocked by the git proxy (branches push
  fine) — dispatch `.github/workflows/publish.yml` manually instead
  (`workflow_dispatch` with a `version` input); it tags and releases from
  inside the Actions runner, which isn't subject to that restriction. From
  a real machine with normal git credentials, `npm run release` (tag +
  push) works as usual.

- **This plugin does not have npm publishing credentials configured in
  agent sessions.** `npm publish` is the maintainer's own step, run
  manually — don't attempt it from an agent session even when asked to "cut
  a release"; releases here stop at the tagged GitHub release.
