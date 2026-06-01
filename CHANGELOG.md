# Changelog

All notable changes to `@magicpixelart/cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
