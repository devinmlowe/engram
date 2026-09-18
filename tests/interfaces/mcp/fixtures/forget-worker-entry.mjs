// Bootstrap for tests/interfaces/mcp/fixtures/forget-worker.ts.
//
// A worker_threads Worker cannot be given `--import tsx` (tsx does not
// register its hooks off the main thread), and Node's native type stripping
// does not resolve the `.js` specifiers the sources use for `.ts` files. So
// the worker starts here, registers tsx's ESM loader for THIS thread, and
// only then imports the TypeScript fixture.
import { register } from "tsx/esm/api";

register();
await import("./forget-worker.ts");
