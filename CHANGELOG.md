# Changelog

All notable changes to `@magicpixelart/cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
