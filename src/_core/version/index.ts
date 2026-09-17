/**
 * The package version, read from package.json at runtime so the CLI
 * (`engram --version`), the MCP server's `serverInfo`, and `engram update
 * --check` can never disagree after an upgrade (#44). Works from both
 * `src/` (tsx) and `dist/`: both sit two levels below the package root.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Absolute path of the package root (the directory holding package.json). */
export const PACKAGE_ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Package name, e.g. `@devinmlowe/engram`. */
export const PACKAGE_NAME: string = (require(join(PACKAGE_ROOT, "package.json")) as { name: string }).name;

/** Package version, e.g. `0.3.0`. */
export const ENGRAM_VERSION: string = (require(join(PACKAGE_ROOT, "package.json")) as { version: string }).version;
