/**
 * Lazy module loader for the acceptance suite.
 *
 * The harness implementation lives under `eval/src/`. At RED time those
 * modules do not exist; a static import would turn every test in the file
 * into a suite-level ERROR, and a string-template dynamic import trips
 * vite's dynamic-import-vars plugin. `import.meta.glob` compiles to an
 * empty object when the directory has no matching files, so each missing
 * module FAILS the test that asks for it — with a "not implemented" message,
 * not a setup crash.
 */
import { expect } from "vitest";

const modules = import.meta.glob("../../src/**/*.ts");

export async function loadEvalModule<T = unknown>(
  relPath: string,
): Promise<T> {
  const name = relPath.replace(/\.js$/, "");
  const key = Object.keys(modules).find((k) => k.endsWith(`/src/${name}.ts`));
  if (!key) {
    throw new Error(
      `eval harness not implemented: eval/src/${name}.ts is missing ` +
        `(expected module for this acceptance test, SPEC traceability).`,
    );
  }
  const mod: unknown = await (modules[key] as () => Promise<unknown>)();
  expect(mod, `eval/src/${name}.ts loaded but is empty`).toBeTruthy();
  return mod as T;
}
