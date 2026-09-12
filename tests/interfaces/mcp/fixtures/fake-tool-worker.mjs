// Real worker_threads fixture for the MCP worker-pool tests.
// Speaks the pool protocol ({id, tool, args} -> {id, ok, result}) and lets
// tests exercise genuinely off-main-thread behaviour:
//   - tool "recall"  : busy-loops synchronously for args.ms (default 2000)
//                       before answering — simulates a blocking SQLite/ONNX call
//   - tool "hang"    : never answers
//   - tool "crash"   : exits the thread with code 3
//   - tool "whoami"  : answers with this worker's threadId
//   - anything else  : echoes the args back
import { parentPort, threadId } from "node:worker_threads";

function busyWait(ms) {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x = (x + 1) % 1000003;
  return x;
}

const text = (t) => ({ content: [{ type: "text", text: t }] });

parentPort.on("message", (msg) => {
  const { id, tool, args } = msg;
  switch (tool) {
    case "recall": {
      const ms = (args && args.ms) ?? 2000;
      busyWait(ms);
      parentPort.postMessage({ id, ok: true, result: text(`<engram_memory query="${(args && args.query) ?? ""}" slow="${ms}"/>`) });
      return;
    }
    case "hang":
      return;
    case "crash":
      process.exit(3);
    case "whoami":
      parentPort.postMessage({ id, ok: true, result: text(String(threadId)) });
      return;
    default:
      parentPort.postMessage({ id, ok: true, result: { tool, args, threadId } });
  }
});

parentPort.postMessage({ type: "ready" });
