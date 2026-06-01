# Changelog

All notable changes to `@magicpixelart/cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
