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

One command, inside your project folder (the one with `package.json`):

```bash
npx magicpixel start
```

That walks you through everything: detects your framework, writes `magicpixel.json`, prompts for your API key (paste it from [magicpixel.art/settings](https://magicpixel.art/settings) → API Keys), pulls your sprites, and tells you how to keep them fresh.

When it finishes:

```bash
npm run magicpixel:watch        # keeps sprites fresh while you edit them in MagicPixel
```

Production keys are prefixed `mp_live_`; sandbox keys (used internally for tests) are `mp_test_` and accepted the same way.

### Where your key lives

- **`MAGICPIXEL_API_KEY` env var** — highest priority, so CI keeps working with no code changes.
- **`.magicpixel/credentials`** — written by `magicpixel login`, mode `0600`, automatically gitignored. This is what `start` uses for local dev.

If `start` finds a `MAGICPIXEL_API_KEY` in your `.env` / `.env.local`, it offers to move it to the credentials file so it stops shipping in your bundler.

### Manual setup (advanced)

```bash
npx magicpixel init           # writes magicpixel.json
npx magicpixel login          # stores your key (or: export MAGICPIXEL_API_KEY=mp_live_...)
npx magicpixel sync           # downloads changed assets
npx magicpixel sync --watch   # keeps assets fresh while you work
```

### Something not working?

```bash
npx magicpixel doctor
```

Prints a one-screen diagnostic (CLI version, framework, outDir, key source, last sync, last error). Paste it to your AI agent — it's designed to be the only context they need.


## Typed asset index (default on)

If `emitIndex` is true in `magicpixel.json`, every sync writes `<outDir>/index.ts`:

```ts
import { MagicPixelAssets, MagicPixelAssetsById } from '@/assets/magicpixel';

// Key-based: ergonomic, but breaks if you rename or move the asset in the editor.
<img src={MagicPixelAssets['player/walk']} />

// Id-based: survives every rename. Use for assets you don't want to chase imports for.
<img src={MagicPixelAssetsById['abc123…']} />
```

The index is built from what's actually on disk after each sync, so it can never disagree with the PNGs your bundler picks up. Renames are detected against the prior sync's snapshot — `sync` prints the old → new key plus the matching `MagicPixelAssetsById[...]` import hint so you can pick whichever you prefer.

No bundler config, no runtime, no extra package.

## Commands

| Command | What it does |
| --- | --- |
| `start [--force]` | One-command bootstrap. Init + login + first sync. The only command to tell new users to run. |
| `init [-y] [--force]` | Interactive config wizard. Offers a `magicpixel:watch` npm script. `-y` for CI. |
| `login [--key <key>]` | Save your API key to `.magicpixel/credentials` (mode `0600`). Validates against the server first. |
| `logout` | Remove the stored API key. |
| `doctor` | Print a one-screen diagnostic — paste it to your AI agent when something breaks. |
| `sync [...flags]` | Fetch manifest, diff against disk, download changed assets, prune orphans. |
| `add <glob>` / `remove <glob>` | Manage `include` patterns. |
| `list` | Print matching manifest as a table. |
| `status` | Config, last sync, diff vs remote. |
| `whoami` | Verify API key, report visible assets. |

### `sync` flags

| Flag | Meaning |
| --- | --- |
| `-w, --watch [seconds]` | Poll for changes (default 10s). Ideal during development. |
| `--no-prune` | Keep local files not in the manifest (default: prune them on full syncs). |
| `--dry-run` | Print plan, write nothing. |
| `--full` | Ignore `lastSync`; re-fetch the full manifest. |
| `-c, --concurrency <n>` | Parallel downloads (1–16, default 6). |
| `-q, --quiet` | Minimal output (for CI). |

Each successful sync prints a per-file change list (`+` added, `~` modified, `↪` renamed, `-` pruned) so you (and any AI agent reading the logs) know exactly what to wire up.

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
| `endpoint` | `string?`  | production URL          | Override the API base (testing only). Must be **HTTPS**. |

State (`.magicpixel/state.json`) tracks `lastSync` (file mode `0600`). Add `.magicpixel/` to `.gitignore` (init offers to do this).

### Custom endpoint (advanced)

For local integration testing against `http://localhost`, set `MAGICPIXEL_ALLOW_INSECURE_ENDPOINT=1` in the environment. Do not commit custom endpoints to shared repos — `sync` warns when `endpoint` is set.

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
      - run: npx -y @magicpixelart/cli sync --quiet --full
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
| `No MagicPixel API key found` | Run `magicpixel login`, or `export MAGICPIXEL_API_KEY=mp_live_...`. |
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
