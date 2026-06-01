# @magicpixelart/cli

Sync MagicPixel pixel-art assets to your local project as flattened PNGs. Zero runtime — just files on disk that your bundler picks up.

## Install

```bash
npm install --save-dev @magicpixelart/cli
# or: pnpm add -D @magicpixelart/cli
# or: bun add -d @magicpixelart/cli
```

Requires Node.js ≥ 18.

## Quickstart

```bash
npx magicpixel init          # interactive setup, detects your framework
export MAGICPIXEL_API_KEY=mp_live_...
npx magicpixel sync          # downloads changed assets
npx magicpixel sync --watch  # keeps assets fresh while you work
```

Get an API key at [magicpixel.art/settings](https://magicpixel.art/settings) → API Keys. Each key is bound to one project.

The key is read **only** from the `MAGICPIXEL_API_KEY` environment variable — never from `magicpixel.json` or any other file. This is intentional: it keeps secrets out of repos and CI logs.

## Typed asset index (default on)

If `emitIndex` is true in `magicpixel.json`, every sync writes `<outDir>/index.ts`:

```ts
import { MagicPixelAssets, type MagicPixelAssetKey } from '@/assets/magicpixel';

<img src={MagicPixelAssets['player/walk']} />
// Typo? TypeScript error. Vite/webpack hash the URL at build time.
```

No bundler config, no runtime, no extra package.

## Commands

| Command | What it does |
| --- | --- |
| `init [-y] [--force]` | Interactive config wizard. `-y` for CI. |
| `sync [...flags]` | Fetch manifest, diff against disk, download changed assets. |
| `add <glob>` / `remove <glob>` | Manage `include` patterns. |
| `list` | Print matching manifest as a table. |
| `status` | Config, last sync, diff vs remote. |
| `whoami` | Verify API key, report visible assets. |

### `sync` flags

| Flag | Meaning |
| --- | --- |
| `-w, --watch [seconds]` | Poll for changes (default 10s). Ideal during development. |
| `--prune` | Delete local files no longer in the manifest. |
| `--dry-run` | Print plan, write nothing. |
| `--full` | Ignore `lastSync`; re-fetch the full manifest. |
| `-c, --concurrency <n>` | Parallel downloads (1–16, default 6). |
| `-q, --quiet` | Minimal output (for CI). |

Sync is built to be cheap: a no-op run is one small manifest request, zero PNG bytes.

- sha256 diff against disk — matching files are never re-downloaded.
- `If-None-Match` ETag on per-asset GETs — server returns 304 if your local copy matches.
- `lastSync` in `.magicpixel/state.json` → incremental manifest fetch (`?since=…`).
- Atomic writes (`*.tmp` → `rename`) survive crashes mid-write.
- Retry with backoff on 429/5xx; `lastSync` only advances on a clean run.

## Config (`magicpixel.json`)

| Field      | Type       | Default                 | Meaning                                          |
| ---------- | ---------- | ----------------------- | ------------------------------------------------ |
| `outDir`   | `string`   | framework-dependent     | Where PNGs (and `index.ts`) are written.         |
| `include`  | `string[]` | `["**/*"]`              | Globs (picomatch) matched against `folder/slug`. |
| `exclude`  | `string[]` | `[]`                    | Globs to exclude.                                |
| `emitIndex`| `boolean`  | `true`                  | Emit `<outDir>/index.ts` with typed asset map.   |
| `endpoint` | `string?`  | production URL          | Override the API base (testing only).            |

State (`.magicpixel/state.json`) tracks `lastSync`. Add `.magicpixel/` to `.gitignore` (init offers to do this).

## CI usage

```yaml
name: Sync MagicPixel
on:
  workflow_dispatch:
  schedule:
    - cron: '0 * * * *'
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npx -y @magicpixelart/cli sync --prune --quiet
        env:
          MAGICPIXEL_API_KEY: ${{ secrets.MAGICPIXEL_API_KEY }}
      - uses: peter-evans/create-pull-request@v6
        with:
          commit-message: 'chore: sync MagicPixel assets'
          branch: chore/magicpixel-sync
          title: 'Sync MagicPixel assets'
```

## `.gitattributes` (optional)

Keep PR diffs clean by marking generated PNGs:

```
src/assets/magicpixel/** binary linguist-generated=true
```

## Troubleshooting

Every error message includes a `Fix:` block. Common ones:

| Symptom | Fix |
| --- | --- |
| `MAGICPIXEL_API_KEY is not set` | Export it from your shell. |
| `401` / `403` | Regenerate the key at magicpixel.art/settings. |
| `whoami` shows 0 assets | The key is bound to an empty project. Mint a key for the project that has art. |
| `index.ts` doesn't update | Run `sync --full` once; renames may take a full pass to propagate. |
| Files keep re-downloading | Your build system is rewriting PNGs. Sync into a dir your bundler reads but doesn't mutate. |

## What v1 does NOT do

- Layer JSON sync (PNG only)
- A runtime JS SDK (your bundler already handles PNG imports)
- Cross-user asset sharing

## License

MIT
