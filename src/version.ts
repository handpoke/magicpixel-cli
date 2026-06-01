import { createRequire } from 'node:module';

// Single source of truth: read version from package.json at runtime so
// `npm version <bump>` propagates everywhere without code edits.
// dist/version.js resolves `../package.json` → tools/cli/package.json.
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const CLI_VERSION: string = pkg.version;
export const CLI_USER_AGENT = `@magicpixelart/cli/${CLI_VERSION} (node ${process.versions.node})`;
