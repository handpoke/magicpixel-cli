# CLI rules
- `sync --only` (`syncScope.ts`) makes out-of-scope rows hold-only, so nothing outside is pulled, pushed, or pruned.
- Connected-folder entries carry `game: true` (`strayGuard.ts`: local game path or beside siblings only); monorepo `workspace` roots keep member-relative keys with root-relative `sourceRel`, so merging setups never re-uploads.
- Unity `.meta` files are written whole only when missing (`writeMissingUnityMetas`); the one later change is an artboard's 9-slice `border` from the manifest (`writeUnitySpriteBorders`: the `spriteBorder` and `spriteMeshType` lines only, single-sprite metas only, sprites without a border never touched), because importer settings set in Unity (pivot, PPU) must survive every sync.
