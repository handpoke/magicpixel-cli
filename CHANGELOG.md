# Changelog

All notable changes to `@magicpixel/cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- `User-Agent: @magicpixel/cli/0.1.0 (node X)` on all requests for server-side observability.
