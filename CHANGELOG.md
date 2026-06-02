# Changelog

All notable changes to `@magicpixelart/cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.3] — 2026-06-02

### Fixed

- **Continuous `.magicpixel/state.json.<pid>.<hex>.tmp` churn in watch mode.**
  `saveState()` still used `atomicWrite`, and because watch mode persists
  state every poll, editors like VS Code visibly filled `.magicpixel/` with
  staged `state.json.*.tmp` files before the rename landed or when file
  watchers raced the staging path. State saves now use a direct `writeFile`
  with `0600` permissions instead. This is safe because `state.json` is a
  recoverable cache: if a process dies mid-write, `loadState()` already
  quarantines corrupt JSON and the next sync re-derives the snapshot from the
  manifest and local files. `atomicWrite` remains for durable config,
  credentials, `AGENTS.md`, package metadata, and generated index files.

## [0.5.2] — 2026-06-02

### Fixed

- **Instant HMR for synced assets (regression from 0.5.1).** 0.5.1 routed
  the per-asset PNG writer through `atomicWrite`, which stages a
  `<name>.<pid>.<hex>.tmp` file and `rename()`s over the target. Vite's
  chokidar watcher only collapses the resulting unlink/add pair when the
  tmp filename starts with `.` or ends with `~` — ours matches neither, so
  the target was observed as an `add` rather than a `change` and Vite did
  not re-push the new image URL to the open browser. Users had to hard
  refresh to see freshly-synced assets (e.g. after renaming an artboard).
  The asset writer is back to a direct `writeFile(diskPath, bytes)` —
  same inode, single `change` event, immediate HMR. Atomicity is not
  needed for asset bytes (a torn write is self-healing on the next watch
  tick via sha mismatch); `atomicWrite` remains in use for `state.json`,
  credentials, `AGENTS.md`, `package.json`, and `magicpixel.json`, where
  torn writes WOULD corrupt cross-run state. A regression-guard test
  (`tests/sync.assetWriterDirect.test.ts`) pins this contract.

## [0.5.1] — 2026-06-02

### Fixed

- **`.tmp` file leak in `atomicWrite` and the asset writer.** Every CLI write
  that goes through `atomicWrite` (`state.json`, `package.json`,
  `magicpixel.json`, credentials, `AGENTS.md`, the generated index) and the
  inline tmp+rename in `sync` previously skipped cleanup when `rename()`
  threw (FS hiccup, AV scan, racing writer, ENOSPC). Because `saveState`
  fires every watch tick, even a low failure rate accumulated hundreds of
  `<file>.<pid>.<hex>.tmp` files inside `.magicpixel/` and
  `src/assets/magicpixel/<folder>/` — and they were invisible to the
  `*.png`-only orphan walker. `atomicWrite` now wraps the write/chmod/rename
  body in a `try { … } catch { unlink(tmp); throw }` block; the asset writer
  in `sync` is reduced to a single `atomicWrite(diskPath, bytes)` call so
  there's only one staging path left.
- **Renamed artboard left the old PNG on disk in incremental mode.** When
  `state.json` was stale (e.g. a victim of the `.tmp` leak above) the
  rename detector couldn't correlate the new manifest entry to the prior
  key, and the incremental code path skips the full orphan sweep. Sync now
  has a sha-based fallback: for each download-bound entry whose `sha256`
  matches a stranded local PNG (one whose disk path is not in the current
  manifest), we record a synthetic `RenameInfo` and prune the stale PNG.
  Same-bytes + manifest-no-longer-references-that-path is unambiguous
  evidence of a rename and never deletes anything the user still owns.

### Added

- **Startup `.tmp` janitor.** `magicpixel sync` (one-shot and `--watch`)
  sweeps stale `<file>.<pid>.<hex>.tmp` files left over from prior crashed
  or killed runs across `outDir/**`, `.magicpixel/`, and the project root.
  Pattern is anchored (`\.\d+\.[0-9a-f]{16}\.tmp$`) so user files with
  `.tmp` in the name are never touched, and a 30-second age floor prevents
  any race with a concurrent in-flight write.
- **`atomicWrite` now accepts `Uint8Array` in addition to `string`** so the
  asset-bytes writer in `sync` can share the same cleanup-guaranteed
  staging logic as every other writer.

## [0.5.0] — 2026-06-02

### Added
- **Legacy slug-folder sweep.** When a server-side slug rule change renames
  a doc (e.g. `cards-2` → `cards`) and the prior id→key snapshot is missing
  (fresh clone, CI runner, snapshot wipe), `sync` now detects top-level
  `outDir` folders matching `<currentSlug>-<n>` for any slug known from the
  manifest OR the prior persisted snapshot, and prunes them whole. Always
  prints a `Legacy slug folders removed — update your imports:` block with
  find/replace hints so users fix any source code references. Runs in both
  full and incremental mode; respects `--no-prune`. Sibling slugs that are
  themselves valid (e.g. a user-named `tiles-2/` next to `tiles/`) are
  never deleted because the "known slugs" set unions the live manifest
  with the persisted id→key map.

### Fixed

- **`sync --watch 1` silently coerced to 2.** The commander validator
  accepted `1–3600` but the watch loop enforced a 2s floor via
  `Math.max(2, …)`, so `--watch 1` quietly ran at 2s with no warning.
  Validator and loop now agree on `2–3600`; passing `1` fails fast with
  `expected an integer 2–3600 (seconds)`.
- **`magicpixel start` printed "You're set up ✨" after a failed first
  sync.** `syncCommand` sets `process.exitCode = 1` on download failures
  without throwing — same misleading-success pattern we previously fixed
  in `repair`. `start` now snapshots `process.exitCode` around the first
  sync and prints a yellow "first sync completed with errors" line
  (pointing at `magicpixel sync` and `magicpixel doctor`) when a fresh
  non-zero exit code is set. The watch-script hint still prints either
  way so the user knows how to retry.
- **Watch-tick `(other)` and `(network)` errors lost the request id.**
  Friendly `ApiError` messages put `(request id: …)` on a second line, so
  the `firstLine` we logged for non-auth tick failures dropped it. Both
  branches now suffix the request id when the underlying error is an
  `ApiError` — matching what the auth-pause branch has always done.
- **`whoami` could print a negative asset count** if a malformed server
  response returned `count: -5`. Shape guard now clamps to `Math.max(0, …)`
  and floors to an integer.

### Internal
- New `reportAndExit(err, command, exitCode)` in `util/telemetry.ts`.
  Collapses the duplicated lazy-import + best-effort-config ceremony that
  used to live in both `wrap()` (index.ts, exit 1) and the watch
  give-up branch (sync.ts, exit 2). One source of truth for the
  fork-endpoint guard and any future flush-pending-spans hook.

### Tests
- 119 → 130 passing. New coverage: `whoami` negative-count clamp, and
  `parseWatchInterval` / `parseConcurrency` validators (extracted to
  `util/flagValidators.ts` so they unit-test in-process without spawning
  a subprocess — bare `-w` boolean form, lower/upper bounds, non-integer
  and out-of-range rejection).

## [0.4.0] — 2026-06-02

Production hardening pass. Reliability, self-healing, traceability, and
significant onboarding polish — no breaking changes for callers on 0.3.x.

### Added
- **Opt-out CLI error telemetry.** Unexpected failures (5xx server errors and
  uncaught exceptions) are reported fire-and-forget to a new
  `log-cli-error` edge function so they surface on `/admin/errors` alongside
  browser crashes. Authenticated by your API key, never blocking, 2s timeout,
  per-message dedupe. Skipped when no key is configured, when pointed at a
  non-canonical endpoint, or when `MAGICPIXEL_TELEMETRY=0`. User-fixable
  errors (missing config, bad key, ENOENT/EACCES, commander arg errors,
  401/403/404/429) are filtered out client-side and never reported.
- **`magicpixel repair`** — one-shot self-healing command. Validates the API
  key, quarantines `state.json`, prunes empty subdirs under `outDir`, and runs
  a full sync. `--dry-run` previews; `--yes` skips the prompt. The dry-run
  output lists the actual paths it would quarantine and the empty subdirs it
  would remove (capped at 10 + “…and N more”). If the underlying sync exits
  non-zero the final line reports “completed with errors” instead of a green
  check.
- **`magicpixel doctor --json`** — stable, machine-readable diagnostic report
  (no ANSI). Pipeable into `jq` or pasted verbatim into an LLM. Never includes
  the API key, only its source. New `--offline` flag skips the live manifest
  probe for users behind a strict proxy. The `network` field uses a
  discriminated shape: `{ skipped: 'offline' | 'no-api-key' }` when no probe
  ran, `{ ok, status, roundtripMs, requestId, error }` when one did — so JSON
  consumers can branch on `network.skipped` instead of mis-reading a probe
  skip as a network failure.
- **`magicpixel doctor` actively probes** the manifest endpoint with a 5s
  timeout. Reports HTTP status, roundtrip ms, and the `X-Request-Id` the
  server echoed.
- **`X-Request-Id` echo end-to-end.** The CLI mints a uuid for every request
  via a shared `authHeaders` helper (one source of truth for the
  `Authorization` / `User-Agent` / `X-Request-Id` triple); the edge function
  echoes it on every response (success + error). 401/403 and other API
  errors now suffix `(request id: …)` so support can grep edge logs in one
  shot.
- **Friendly EACCES/EPERM/EROFS/EBUSY messages.** Asset writes and
  `state.json` saves surface multi-line, action-oriented diagnostics (“close
  OneDrive”, “chmod -R u+w …”) instead of raw libc errors.
- **Watch-loop resume message.** After an auth-pause clears (the user ran
  `magicpixel login` in another terminal), the watcher logs
  `✓ Key accepted again — resuming.` instead of silently picking up.
- **`sync --watch` exits with code `2`** after 5 consecutive 401/403s so
  parent processes (Vite plugin, systemd, pm2) can detect a genuinely
  revoked key rather than a transient blip. A successful tick resets the
  counter. Non-auth failures don’t count toward the streak, so a flaky
  network interleaved with a stale 401 can’t sneak past the threshold.
- **Per-command `--help` examples** via `commander`’s `addHelpText`. Each
  command ships a 2-line example block ready to paste to an AI agent.
- **README “Production checklist”** pointing at `doctor`, `repair`,
  `--offline`, watcher exit codes, and `X-Request-Id` grepping.
- **`AGENTS.md` is always written**, regardless of `emitIndex` — `public/`
  and `static/` users now get a snippet that uses the correct absolute URL
  form (`<img src="/magicpixel/items/tree.png" />`) instead of a broken
  bundler-relative `import` path.

### Fixed
- **`sync --watch` Ctrl+C waited out the full backoff before exiting.** When
  a signal arrived during the idle sleep the watcher slept up to 60s (the
  error-backoff ceiling) before re-checking `stopping`. The sleep is now
  cancellable: `onStopSignal` calls `wakeStop()` and the loop exits within a
  tick.
- **`magicpixel whoami` ignored `Retry-After` on 429.** Every other call site
  passed `retryAfterMsFromResponse(res)` to `ApiError`; `whoami` dropped it,
  burning through retries in ~750ms instead of waiting the server-suggested
  window. Now honours the header (helper exported from `api.ts`).
- **`magicpixel init` patched `package.json` non-atomically.** A crash
  between write and flush could corrupt `package.json`. Now uses the shared
  `atomicWrite` (stage-tmp + rename) helper, same pattern as `state.json`
  and the asset download path.
- **`[watch] stopped.` printed under `--quiet`.** The termination line now
  honours the quiet contract so CI consumers capturing watcher output get a
  clean stream.
- **`sync --watch` ignored SIGTERM.** Only `SIGINT` (Ctrl+C) was handled, so
  `kill <pid>`, `docker stop`, systemd, and pm2 killed the watcher mid-sync
  without draining in-flight work or preserving the exit code. Both signals
  now share a single `onStopSignal` handler; second signal force-exits with
  the conventional code (130 for SIGINT, 143 for SIGTERM).
- **`sync --watch` went silent after the first network blip.** Once backoff
  doubled past 30s the offline message was suppressed entirely, so a user
  returning to the terminal saw no signal at all. The message now prints
  every time backoff changes (and the next successful tick prints a single
  “Back online — resuming.” line, mirroring the auth-recovery pattern).
- **`magicpixel repair` could mis-report success.** The exit-code comparison
  used raw inequality on `process.exitCode`, so a sync failure that re-set
  it to `1` after a prior `1` looked like success. Now snapshots
  `process.exitCode ?? 0` and compares `>`, honouring any fresh non-zero.
- **`assertKeyValid` read unbounded error bodies.** A misbehaving server
  returning a multi-MB 500 page would buffer it entirely just to slice 120
  chars. Now capped at 16 KB via `readBodyWithLimit`.
- **`magicpixel status` falsely reported “key not set”** when the user had
  logged in via `magicpixel login` (file-backed). Now honors the same
  precedence as `getApiKey()` and labels the source.
- **`magicpixel status` / `whoami` worked only with a project config.** Both
  now fall back to defaults when `magicpixel.json` is missing, so a brand-new
  user can `magicpixel whoami` to validate a key before bothering with init.
- **`magicpixel start` couldn’t recover from a broken `magicpixel.json`.** It
  used to skip init on `existsSync` and then crash deep inside `syncCommand`.
  It now tries `loadConfig` first and prints the friendly error with a
  `magicpixel init --force` hint when the file is malformed.
- **`sync --watch` idle backoff was measured in *ticks*, not seconds.** At
  `--watch 10`, the first slowdown waited 15 minutes (90 ticks) and the
  second 50 minutes (300 ticks) instead of the documented ~3 / ~15 min.
  Thresholds are now elapsed-seconds and behave the same at any interval.
- **`sync --watch` graceful stop overwrote `process.exitCode`.** A failed
  download earlier in the loop set `exitCode = 1`; the post-loop
  `process.exit(0)` then zeroed it out. The watcher now preserves any prior
  exit code on graceful stop and on SIGINT.
- **304 responses now credit `bytesSaved`.** A steady-state sync (all assets
  unchanged via ETag) used to report `~0 B saved`; it now reports the
  manifest’s reported byte total.
- **`magicpixel.json` shape validation** at load time. Hand-edited configs
  with wrong types (e.g. `include: "**/*"` instead of `["**/*"]`, or
  `emitIndex: "true"`) surface friendly multi-line errors pointing at the
  offending field instead of cryptic TypeErrors deep in glob matching.
- **`assertSafeOutDir` rejects absolute paths and `..` segments** at both
  `init` prompt-time and `loadConfig` file-time — single helper, single
  policy. Previously an absolute `outDir` could escape the cwd-relative
  containment check.
- **`fetchAllManifest` / `fetchAssetBytes` shape-validate the manifest JSON.**
  A malformed edge response (`{items: null}`, non-string `nextCursor`, etc.)
  used to crash with `TypeError: null is not iterable` mid-pagination; now
  surfaces a friendly `ApiError(502, …)` carrying the request id.
- **`fetchAllManifest` detects stuck cursors in O(1) round-trips.** A buggy
  server that returns the same `nextCursor` twice now aborts immediately
  instead of burning the 200-page budget.
- **`assertKeyValid` + `whoami` retry transient failures.** A single 503 or
  network blip during onboarding used to kick the user back to “paste your
  key again”, and `whoami` would falsely report “rejected”. Both now retry
  5xx/429 with `Retry-After` honoring; hard 4xx still bubble immediately.
- **`magicpixel repair` final line** no longer claims success when the
  underlying `sync` set a non-zero exit code without throwing.
- **`init` validates outDir at input time** with a re-prompt loop, instead of
  letting `loadConfig` reject it on the next `sync` / `status`.
- **`maxIsoTimestamp`** requires strict ISO-8601 (matches the edge function’s
  regex), so loose `Date.parse`-able inputs can’t silently rewind `lastSync`.
- **`sync --watch` default documented correctly.** Help text and README said
  10s but the actual default is 2s (intentional — perceived-instant UX).
  Docs now reflect 2s + adaptive idle backoff.
- **`sync -w <bad>` no longer silently coerces to 2s.** Commander now
  validates the watch interval (`InvalidArgumentError` for non-integers and
  out-of-range values, 1–3600s). The bare boolean form (`-w` with no arg)
  still defaults to 2s.
- **Watcher network-error detection** now also matches `ENETUNREACH`,
  `EHOSTUNREACH`, and `502/504` upstream-gateway text so corporate-proxy
  blips back off correctly instead of being treated as auth failures.
- **`magicpixel list` size column** now formats bytes as `KB` / `MB` instead
  of dumping raw byte counts (`1234567B`). Shares the same `formatBytes`
  helper as `sync`.
- **`magicpixel whoami` shape-guards the manifest response** the same way
  `fetchAllManifest` does. A malformed `{ items: null }` body now reports
  "0 assets" with the request id rather than throwing `TypeError`.
- **`findKeyInDotenv` regex anchored on the exact key name.** Sibling vars
  like `MAGICPIXEL_API_KEY_OLD` or `MAGICPIXEL_API_KEY_BACKUP` no longer
  match and return the wrong value. Also tolerates `export ` prefix and
  inline `# comment` trailing the value.
- **`magicpixel repair --dry-run`** now predicts the step-2 skip a real
  run would hit on non-TTY without `--yes`, prints a yellow `note`, and
  closes with "would skip the state reset" instead of an unconditional
  green check.
- **`magicpixel start` no longer instructs users to run an npm script
  they don't have.** When `init` couldn't patch `package.json` the final
  hint falls back to `npx magicpixel sync --watch`. The concurrently tip
  follows the same branch.
- **`retryTransient` wraps network failures with `{ cause }`** so the
  underlying transport error keeps its stack for debugging.
- **`validateEndpointUrl` uses an explicit scheme allowlist** (`https:` /
  `http:` for localhost). `file:`, `data:`, `javascript:`, etc. now get a
  clear "scheme not allowed" message instead of the generic HTTPS error.

### Changed
- **`magicpixel status` Diff vs remote** now parallelizes the per-asset SHA
  check through the shared concurrency pool (matches the `sync` diff loop).
- **`sync.runOnce` parallel disk-SHA pre-check** using the same
  `createLimit(concurrency)` pool as downloads (default 6 in flight). On a
  1k-asset all-unchanged sync this is the dominant wall-clock cost.
- **`sync.runOnce` caches `assetDiskPath` and per-entry SHA** in maps reused
  across the diff / orphan / download loops. Saves three resolves + two
  security asserts per asset and, on the download path, avoids re-hashing
  the same file moments after the pre-check.
- **`sync` orphan-prune message no longer reads inverted** when `--no-prune`
  is passed.

### Internal
- New `util/framework.isStaticOutDir` — single predicate for "is outDir
  served as a static asset?", used by `init` (skip typed index) and
  `emitIndex` (emit absolute-URL AGENTS.md snippet). Replaces two copies of
  the same regex.
- New `nextBackoffForIdle` exported from `sync.ts` — pure helper used by
  the watch loop's idle backoff math; testable in isolation.
- New `util/authHeaders.ts` — one source of truth for the Authorization +
  User-Agent + X-Request-Id triple (4 call sites collapsed).
- New `util/iso.ts` — `STRICT_ISO_8601_RE`, `isStrictIso8601`,
  `maxIsoTimestamp` extracted from `sync.ts`.
- New `util/security.assertSafeOutDir` — single trim+validate helper used by
  both `init` and `loadConfig`.
- New `util/paths.walkOutDirPngs` — single canonical disk walker for PNGs
  under outDir, replacing the two near-identical implementations that used
  to live in `sync.ts` and `emitIndex.ts`.
- New `util/paths.listEmptyDirs` — DFS post-order walker shared by
  `pruneEmptyDirs` and `repair --dry-run`. Deletion order is now provably
  safe.
- `fetchAssetBytes` refactored onto the shared `retryTransient` helper; one
  retry policy now governs both manifest pagination and asset downloads
  (including `Retry-After` parsing).
- `MAX_GLOB_LEN` exported from `util/security.ts`, imported by `config.ts`.
- `emitTypedIndex` + `ensureAgentsDoc` use atomic writes (`.tmp` →
  `rename`) so a crash mid-write can never leave a truncated `index.ts` /
  `AGENTS.md` that fails bundler resolves.
- New `util/format.ts` — `formatBytes` shared by `sync` and `list`; was
  previously a private helper inside `sync.ts`.
- `start.ts` no longer dynamically imports `node:fs/promises` mid-function.
- `loadState` corrupt-state quarantine — renames a malformed `state.json`
  to `.corrupt-<ts>` and falls back to a full sync.
- `_shared/errorHandler.ts` (edge) mints a fallback `X-Request-Id` when the
  caller didn’t pass one through.

### Tests
- Test suite expanded from 6 to **78** passing. New coverage: manifest
  shape guard, cursor-loop detection, retry semantics (5xx triple-retry,
  429 Retry-After, network-error wrap, non-retryable 4xx bubble),
  `assertSafeOutDir` (relative / absolute / `..` / null byte),
  `assertSafeAssetSegments`, `validateEndpointUrl` (HTTPS-only, insecure
  escape hatch, no embedded credentials, redirect refusal),
  `assertPathInsideRoot`, `safeFetch` cross-origin redirect,
  `walkOutDirPngs` (dotfile / symlink / cross-root), `listEmptyDirs`,
  `maxIsoTimestamp` strictness, `doctor --json` discriminated `network`
  shape, watcher idle backoff math at multiple intervals (regression
  guard for the ticks-vs-seconds fix), `friendlyFsError` rewrites for
  `EACCES`/`EROFS`/`EBUSY`, corrupt-state quarantine.

## [0.3.3] — 2026-06-01

### Added
- **Honor `Retry-After` on 429.** When the server rate-limits a download, the
  CLI now waits for the duration the server suggests (capped at 60s) before
  retrying instead of using its own fixed 250ms exponential backoff.
- **Stale-version nudge.** The CLI reads `X-MagicPixel-Min-CLI-Version` from
  manifest responses and prints a one-time hint when it's running an older
  version, pointing at `npm i -D @magicpixelart/cli@latest`.

## [0.3.2] — 2026-06-01

### Changed
- **`sync --watch` now backs off when idle.** After ~3 min of nothing-to-do the
  poll relaxes from 2s → 5s, and after ~15 min → 10s, so a dev who walked away
  isn't hammering the manifest endpoint. Any change *or* error snaps it back to
  the fast interval immediately, so the "edit → see it" promise is intact the
  moment you come back. Configurable floor still set by `--watch <seconds>`.

## [0.3.1] — 2026-06-01

### Changed
- **`sync --watch` polls every 2s by default** (was 10s). Edits in MagicPixel
  now appear in your project within ~2s without you running `magicpixel sync`.
  Incremental polls send `?since=<lastSync>` so empty ticks are a cheap
  no-op manifest round-trip. Pass `--watch 5` (or any value ≥ 2) to slow it
  down if needed.


## [0.3.0] — 2026-06-01

This release rolls in the 0.2.0 polish (see below) and adds a first-run onboarding flow built for people who have never used a CLI.

### Added
- **`magicpixel start`** — one-command bootstrap. Detects your framework, runs `init` with smart defaults, prompts for an API key, runs a first `sync --full`, then tells you how to start the watcher. The only command we now tell new users to run.
- **`magicpixel login` / `magicpixel logout`** — store / remove the API key in `.magicpixel/credentials` (mode `0600`). `login` validates the key against the server before saving and re-prompts on rejection instead of crashing.
- **`magicpixel doctor`** — single-page diagnostic (CLI/Node version, framework, `outDir`, key source, watch-script status, last sync time, last error) you can paste to an AI agent when something breaks.
- **`.magicpixel/credentials`** — gitignored, mode `0600` API-key store. `MAGICPIXEL_API_KEY` env var still takes precedence (CI keeps working unchanged); `init`/`start` offer to migrate any `MAGICPIXEL_API_KEY` they find in `.env` / `.env.local` so it stops shipping in your bundler.
- **`AGENTS.md`** — written to the repo root on first successful sync (idempotent — appends a single fenced `## MagicPixel sprites` section if a file already exists). Gives Lovable / Cursor / Claude Code three concrete `import` examples.
- **AI-agent header in `index.ts`** — generated barrel now opens with a comment block telling agents how to import by key vs by stable id.

### Changed
- **`sync --watch`** is now self-explanatory and resilient:
  - Header: `👀 MagicPixel watching for changes…` with the edit URL and stop-key.
  - Each non-empty tick is prefixed `[HH:MM:SS] Pulled N changes from MagicPixel:` followed by the per-file list.
  - 401 / 403 stops crashing the loop — prints `Run: magicpixel login` and retries every 30s.
  - Network failures back off (2s → 60s cap) instead of aborting; "MagicPixel is offline or your internet is. Sprites you already have still work."
- **`getApiKey()`** now reads `MAGICPIXEL_API_KEY` env var first, then `.magicpixel/credentials`. Error message points at `magicpixel login` instead of an `export` snippet.
- **`init`** uses the shared `util/framework.ts` detector (Vite / Next / Remix / TanStack Start / Astro / Nuxt / SvelteKit / CRA) and falls back to `src/assets/magicpixel` when `src/` exists, otherwise `assets/magicpixel`.

### 0.2.0 polish included in this release
- `sync` prunes by default; `--no-prune` opts out. The old `--prune` flag is gone.
- Per-file change summary at the end of every sync and on each non-empty watch tick (`+` added, `~` modified, `↪` renamed, `-` pruned), capped at 50 lines.
- Rename-resilient imports via `MagicPixelAssetsById` + auto-detected renames printed with old → new key hints and stale-PNG cleanup (even in incremental mode).
- `index.ts` emitted from the local filesystem (not the manifest) so the barrel can never disagree with what bundlers see on disk.
- `init` offers to add a `magicpixel:watch` npm script so users discover `sync --watch` without reading the docs.


### Changed (breaking)
- **`sync` prunes by default.** Local PNGs no longer present in the manifest are deleted unless you pass the new `--no-prune` flag. The old `--prune` flag is gone; CI scripts that passed it will see an unknown-option error — drop the flag (behavior is now the default). Pruning still only runs on full syncs (no `lastSync`, or `--full`).
- **Manifest keys now use `<document>/<artboard>`** for every asset, including documents with only one artboard. A document **Items** containing artboards `tree`, `cards`, `rock` now syncs as three separate files (`items/tree.png`, `items/cards.png`, `items/rock.png`) instead of a single `items.png` of the active artboard. Old key shapes (`<library-folder>/<doc-slug>`) become orphan files on the next sync — and are now auto-pruned (see above).

### Added
- **`init` offers a `magicpixel:watch` npm script** so users discover `sync --watch` (the documented happy path) without reading the docs. Existing scripts of the same name are never overwritten.
- **Rename-resilient imports via `MagicPixelAssetsById`.** Every emitted `index.ts` now also exposes an id-keyed map:
  ```ts
  import { MagicPixelAssetsById } from '@/assets/magicpixel';
  <img src={MagicPixelAssetsById['abc123…']} />  // survives folder/slug renames
  ```
- **Rename detection.** When an asset's path changes server-side, `sync` prints the old → new key (and the corresponding stable-id import hint), and auto-prunes the stale PNG even in incremental mode. Detection uses a small `id → key` snapshot persisted alongside `lastSync` in `.magicpixel/state.json`.
- **Per-file change summary** at the end of every sync (and on each watch tick that produced changes): `+` added, `~` modified, `↪` renamed, `-` pruned. Capped at 50 lines with a `…and N more` tail to keep CI logs readable; suppressed under `--quiet`.

### Changed
- **`index.ts` is now emitted from the local filesystem**, not from the manifest. Previously a transient server error during the post-sync barrel refetch left `index.ts` silently stale while the PNGs on disk were fresh — a confusing split-brain state. The barrel can no longer disagree with disk.
- `sync` summary line now breaks `downloaded` into `added` + `modified` so you can tell new assets from updates at a glance.


## [0.1.2] — 2026-06-01

### Security
- Reject manifest `folder` / `slug` values that could escape `outDir` (`..`, `\`, null bytes); verify every write and prune stays inside `outDir`.
- Custom `endpoint` must be HTTPS (local `http://localhost` only with `MAGICPIXEL_ALLOW_INSECURE_ENDPOINT=1`); credentials in the URL are rejected.
- HTTP fetches follow redirects only within the same origin so an API key cannot be sent to a third party.
- Cap per-asset download size at 64 MiB; validate `Content-Length` before buffering.
- Sanitize `If-None-Match` to hex sha256 only; stricter `MAGICPIXEL_API_KEY` format check and whitespace trim.
- Skip symlinks when scanning local PNGs for orphan detection; random-suffix temp files for atomic writes.
- `.magicpixel/state.json` written with mode `0600`.

### Changed
- `whoami` now requests a full manifest page (server-capped at 1000) and reports an honest asset count instead of always showing "1+".
- `sync --watch` waits for the in-flight sync to drain on Ctrl+C before exiting, so you never leave half-written `*.tmp` files or an unflushed `lastSync`. A second Ctrl+C still hard-quits (exit 130).
- `emitTypedIndex` is now idempotent — when the generated `index.ts` matches what's already on disk, the file is left untouched. Stops Vite/webpack HMR from reloading on every `--watch` poll.
- `whoami` now sends the standard `User-Agent` header (was the only command missing it).
- README documents that both `mp_live_` and `mp_test_` key prefixes are accepted.
- `magicpixel.json` validates `include` / `exclude` / `outDir` / `endpoint` on load; `add` / `remove` validate glob patterns.

### Fixed
- `fetchAssetBytes` drains 304 / error response bodies so undici can return sockets to the keep-alive pool (fewer socket warnings on flaky networks).


## [0.1.1] — 2026-05-30

### Added
- `sync --watch` now handles `SIGINT` cleanly (clears the in-flight status line and prints `[watch] stopped`).
- Manifest pagination cycle guard (caps at 200 pages / ~100k assets) so a buggy server cursor can't hang the CLI.
- Smoke workflow exercises `sync --dry-run` to catch broken release builds before publish.
- `sync` warns when `magicpixel.json` has a custom `endpoint` configured (catches stray test overrides before they ship to CI).

### Changed
- Version is now read from `package.json` at runtime (single source of truth for `--version` and `User-Agent`).
- `--concurrency` rejects non-integer / out-of-range values with a clear error instead of silently falling back to the default.
- `init` `.gitignore` insertion now treats `.magicpixel`, `.magicpixel/`, `/.magicpixel`, and `/.magicpixel/` as equivalent, so it doesn't append a duplicate marker.
- README clarifies that `MAGICPIXEL_API_KEY` is env-only by design.

### Fixed
- `sync` verifies the downloaded payload's sha256 against the manifest before atomic rename — corrupt bodies now retry on next run instead of writing to disk.
- `emitTypedIndex` uses positional identifiers (`asset_0`, …) so keys differing only by non-alphanumeric chars no longer collide.
- `emitTypedIndex` dedupes duplicate manifest keys (warns) instead of emitting an invalid TS object literal.

## [0.1.0] — 2026-05-29

Initial release.

### Added
- `init` — interactive setup with framework detection (Vite/Next/Remix/Astro/Nuxt/SvelteKit/CRA), suggests `outDir`, offers typed-index emission and `.gitignore` updates. `-y` for CI.
- `sync` — incremental manifest fetch (`since=lastSync`), sha256 diff against disk, parallel atomic downloads (`*.tmp` → rename), `If-None-Match` 304 short-circuit, retry on 429/5xx.
  - `--watch [seconds]` — poll and apply changes live (default 10s).
  - `--full`, `--prune`, `--dry-run`, `-c/--concurrency`, `-q/--quiet`.
  - Progress bar + bytes-saved summary.
- `add` / `remove` — manage include globs.
- `list` — print matching manifest as a table.
- `status` — config, lastSync, diff vs remote.
- `whoami` — verify API key, report visible assets.
- Typed asset index — when `emitIndex: true`, writes `<outDir>/index.ts` with `MagicPixelAssets` map + `MagicPixelAssetKey` type.
- Friendly errors with copy-pasteable `Fix:` blocks for missing key, malformed key, missing config, broken JSON, network failures, 401/403/404/429/5xx.
- `User-Agent: @magicpixelart/cli/0.1.0 (node X)` on all requests for server-side observability.
