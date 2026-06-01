# Extracting @magicpixelart/cli into its own repo

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
git commit -m "Initial commit: @magicpixelart/cli 0.1.0"

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

- Canonical repo: [github.com/handpoke/magicpixel-cli](https://github.com/handpoke/magicpixel-cli)
- npm: [@magicpixelart/cli](https://www.npmjs.com/package/@magicpixelart/cli)

## Keeping two copies in sync

`tools/cli/` stays in the editor monorepo for edits in external tools (Lovable, etc.).
When you cut a release, rsync into the standalone repo and publish:

```bash
rsync -a --delete --exclude .git --exclude node_modules --exclude dist \
  tools/cli/ ../magicpixel-cli/
# Restore handpoke repository.url and .github/workflows/publish.yml in ../magicpixel-cli/ if needed
cd ../magicpixel-cli && npm install && npm run build && npm publish --access public
```

## Updating the editor's pinned reference

The editor doesn't import the CLI — only the `/guides/sync-setup` page
references it by name. Search for `@magicpixelart/cli` in `src/` and update any
install snippets if the npm name changes.
