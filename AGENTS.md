# CLI rules
- `sync --only` (`syncScope.ts`) makes out-of-scope rows hold-only, so nothing outside is pulled, pushed, or pruned.
- Connected-folder entries carry `game: true` (`strayGuard.ts`: local game path or beside siblings only); monorepo `workspace` roots keep member-relative keys with root-relative `sourceRel`, so merging setups never re-uploads.
