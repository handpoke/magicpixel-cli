# Extracting @magicpixel/cli into its own repo

This package currently lives at `tools/cli/` inside the editor monorepo for
convenience. It has **zero coupling** to the editor app — no shared imports,
no shared types, no shared build. Moving it to a standalone repo is a copy.

## Steps

```bash
# 1. Copy the directory out
cp -r tools/cli ../magicpixel-cli
cd ../magicpixel-cli

# 2. Fresh git history
git init
git add .
git commit -m "Initial commit: @magicpixel/cli 0.1.0"

# 3. Install + build + smoke test
npm install
npm run build
node dist/index.js --help

# 4. Push to GitHub (create magicpixel/cli first)
git remote add origin git@github.com:magicpixel/cli.git
git branch -M main
git push -u origin main

# 5. Publish to npm (one-time: `npm login` first)
npm publish --access public
```

## After publish

- Update `tools/cli/package.json` `repository.url` if the GitHub slug differs.
- Update the editor's `/guides/sync-setup` page if it references "coming soon".
- Delete `tools/cli/` from the editor repo (this directory) once published —
  keeping two copies will drift.

## Updating the editor's pinned reference

The editor doesn't import the CLI — only the `/guides/sync-setup` page
references it by name. Search for `@magicpixel/cli` in `src/` and update any
install snippets if the npm name changes.
