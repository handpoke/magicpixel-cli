/**
 * Unity `.meta` generation for CLI-synced sprites.
 *
 * MIRROR: the TextureImporter body below is byte-identical to the in-app
 * engine's (`src/utils/unitySync/unityMeta.ts`) so both sync paths produce the
 * same pixel-art-correct importer settings. A sync test
 * (`src/utils/unitySync/__tests__/unityMetaMirror.test.ts`) fails if they
 * drift. The duplication is deliberate: the CLI is published as a standalone
 * npm package and cannot import from the web app's source tree.
 *
 * GUIDs are derived deterministically from the asset identity, so re-running
 * sync never changes a sprite's GUID and Unity scene/prefab references survive.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

export const DEFAULT_UNITY_PPU = 32;

/** 32-char hex GUID, stable for a given seed. */
export function unityGuid(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

/**
 * TextureImporter meta tuned for pixel art:
 * - textureType 8 (Sprite), single sprite mode
 * - filterMode 0 (Point — no filtering)
 * - textureCompression 0 (none)
 * - mipmaps off, nPOTScale 0 (keep original size), wrap clamp
 * - alphaIsTransparency 1
 */
export function buildTextureImporterMeta(guid: string, ppu: number): string {
  return `fileFormatVersion: 2
guid: ${guid}
TextureImporter:
  internalIDToNameTable: []
  externalObjects: {}
  serializedVersion: 12
  mipmaps:
    mipMapMode: 0
    enableMipMap: 0
    sRGBTexture: 1
    linearTexture: 0
    fadeOut: 0
    borderMipMap: 0
    mipMapsPreserveCoverage: 0
    alphaTestReferenceValue: 0.5
    mipMapFadeDistanceStart: 1
    mipMapFadeDistanceEnd: 3
  bumpmap:
    convertToNormalMap: 0
    externalNormalMap: 0
    heightScale: 0.25
    normalMapFilter: 0
    flipGreenChannel: 0
  isReadable: 0
  streamingMipmaps: 0
  streamingMipmapsPriority: 0
  vTOnly: 0
  ignoreMipmapLimit: 0
  grayScaleToAlpha: 0
  generateCubemap: 6
  cubemapConvolution: 0
  seamlessCubemap: 0
  textureFormat: 1
  maxTextureSize: 2048
  textureSettings:
    serializedVersion: 2
    filterMode: 0
    aniso: 1
    mipBias: 0
    wrapU: 1
    wrapV: 1
    wrapW: 1
  nPOTScale: 0
  lightmap: 0
  compressionQuality: 50
  spriteMode: 1
  spriteExtrude: 1
  spriteMeshType: 1
  alignment: 0
  spritePivot: {x: 0.5, y: 0.5}
  spritePixelsToUnits: ${ppu}
  spriteBorder: {x: 0, y: 0, z: 0, w: 0}
  spriteGenerateFallbackPhysicsShape: 1
  alphaUsage: 1
  alphaIsTransparency: 1
  spriteTessellationDetail: -1
  textureType: 8
  textureShape: 1
  singleChannelComponent: 0
  flipbookRows: 1
  flipbookColumns: 1
  maxTextureSizeSet: 0
  compressionQualitySet: 0
  textureFormatSet: 0
  ignorePngGamma: 0
  applyGammaDecoding: 0
  swizzle: 50462976
  cookieLightType: 0
  platformSettings:
  - serializedVersion: 4
    buildTarget: DefaultTexturePlatform
    maxTextureSize: 16384
    resizeAlgorithm: 0
    textureFormat: -1
    textureCompression: 0
    compressionQuality: 50
    crunchedCompression: 0
    allowsAlphaSplitting: 0
    overridden: 0
    ignorePlatformSupport: 0
    androidETC2FallbackOverride: 0
    forceMaximumCompressionQuality_BC6H_BC7: 0
  spriteSheet:
    serializedVersion: 2
    sprites: []
    outline: []
    customData:
    physicsShape: []
    bones: []
    spriteID:
    internalID: 0
    vertices: []
    indices:
    edges: []
    weights: []
    secondaryTextures: []
    spriteCustomMetadata:
      entries: []
    nameFileIdTable: {}
  mipmapLimitGroupName:
  pSDRemoveMatte: 0
  userData:
  assetBundleName:
  assetBundleVariant:
`;
}

export interface UnityMetaSprite {
  /** Manifest asset id — the GUID seed (stable across renames). */
  id: string;
  /** Absolute path of the synced PNG. */
  pngPath: string;
}

export interface UnityMetaResult {
  written: number;
  failed: number;
}

/**
 * Write `<file>.png.meta` beside each synced PNG that doesn't have one yet.
 *
 * Existing `.meta` files are never overwritten: once Unity has imported a
 * sprite the user may have tweaked its importer settings (pivot, slicing,
 * PPU) and clobbering that on every sync would be hostile. Delete the `.meta`
 * to regenerate it.
 */
export async function writeMissingUnityMetas(
  sprites: UnityMetaSprite[],
  ppu: number = DEFAULT_UNITY_PPU,
): Promise<UnityMetaResult> {
  const result: UnityMetaResult = { written: 0, failed: 0 };
  for (const sprite of sprites) {
    const metaPath = `${sprite.pngPath}.meta`;
    if (!existsSync(sprite.pngPath) || existsSync(metaPath)) continue;
    try {
      await writeFile(metaPath, buildTextureImporterMeta(unityGuid(sprite.id), ppu));
      result.written++;
    } catch {
      // Non-fatal: Unity generates its own default .meta on import. Counted
      // so `sync` can surface a single warning line instead of failing.
      result.failed++;
    }
  }
  return result;
}
