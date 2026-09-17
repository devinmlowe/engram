// Worker for tests/core/writer-contention.test.ts: hammers the shared WAL
// database with short BEGIN IMMEDIATE transactions from its own connection,
// like the dream daemon does from another process.
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const { dbPath, rounds, holdMs } = workerData;
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
const bump = db.prepare("UPDATE memories SET importance = MIN(1.0, importance + 0.0001) WHERE id = ?");
const ids = db.prepare("SELECT id FROM memories").all().map((r) => r.id);
const buf = new Int32Array(new SharedArrayBuffer(4));
let done = 0;
for (let i = 0; i < rounds; i++) {
  db.transaction(() => {
    for (const id of ids) bump.run(id);
    Atomics.wait(buf, 0, 0, holdMs); // hold the write lock briefly
  }).immediate();
  done++;
}
db.close();
parentPort.postMessage({ done });
