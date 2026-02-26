# macOS launchd Daemon Patterns for Node.js/TypeScript Applications

## Research Document for Engram Phase 5: Dream State Daemon

**Date**: 2026-02-26
**Domain**: macOS process management, launchd, Node.js daemons
**Scope**: Best practices for running a TypeScript/Node.js background processing daemon on macOS via launchd

---

## Table of Contents

1. [launchd Fundamentals](#1-launchd-fundamentals)
2. [Plist Configuration for Node.js Daemons](#2-plist-configuration-for-nodejs-daemons)
3. [Scheduling Strategies](#3-scheduling-strategies)
4. [Process Management Patterns](#4-process-management-patterns)
5. [Logging Best Practices](#5-logging-best-practices)
6. [Error Recovery and Restart Policies](#6-error-recovery-and-restart-policies)
7. [Health Checks and Watchdog Patterns](#7-health-checks-and-watchdog-patterns)
8. [Node.js-Specific Considerations](#8-nodejs-specific-considerations)
9. [Alternative Approaches](#9-alternative-approaches)
10. [Real-World Examples](#10-real-world-examples)
11. [Key Takeaways for Engram](#11-key-takeaways-for-engram)

---

## 1. launchd Fundamentals

### 1.1 What is launchd?

launchd is the macOS system service manager -- the first process the kernel starts (PID 1), responsible for starting all other processes on the system. It replaces `init`, `rc`, `init.d/rc.d` scripts, `SystemStarter`, `inetd`, `xinetd`, `atd`, `crond`, and `watchdog` from traditional Unix systems.

There are two types of launchd jobs:

| Type | Runs As | Location | Use Case |
|------|---------|----------|----------|
| **Daemon** | Root (or specified user) | `/Library/LaunchDaemons/` | System-level services, no GUI |
| **Agent** | Current logged-in user | `~/Library/LaunchAgents/` | Per-user services, may use GUI |

For Engram's dream state daemon, a **Launch Agent** is the right choice because:
- It processes the current user's conversation data
- It does not need root privileges
- It should only run when the user is logged in
- File permissions align with the user's data directories

(Source: [Apple Developer: Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html))

### 1.2 Agents vs Daemons

> "If the process is running as the current logged user, then you will use an Agent. If it's running as root, then you will use a Daemon."

Agents are loaded when the user logs in and unloaded on logout. Daemons are loaded at system boot regardless of user login. For a personal cognitive memory system, an Agent is appropriate.

(Source: [Launch a Node Script at Boot on macOS](https://dev.to/mjehanno/launch-a-node-script-at-boot-on-macos-1dnd))

### 1.3 launchctl Commands

```bash
# Load a job definition
launchctl load ~/Library/LaunchAgents/com.engram.dream.plist

# Unload a job definition
launchctl unload ~/Library/LaunchAgents/com.engram.dream.plist

# Start immediately (regardless of schedule)
launchctl start com.engram.dream

# Stop a running job
launchctl stop com.engram.dream

# List all loaded jobs (filter for engram)
launchctl list | grep engram

# Check job status
launchctl print gui/$(id -u)/com.engram.dream

# Bootstrap (modern replacement for load, macOS 10.10+)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.engram.dream.plist

# Bootout (modern replacement for unload)
launchctl bootout gui/$(id -u)/com.engram.dream
```

(Source: [Mastering macOS Process Management](https://osxhub.com/macos-process-management-ps-kill-launchctl-guide/))

---

## 2. Plist Configuration for Node.js Daemons

### 2.1 Complete Plist Template for Engram

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- Required: Unique identifier for this job -->
    <key>Label</key>
    <string>com.engram.dream</string>

    <!-- Program to run with arguments -->
    <key>ProgramArguments</key>
    <array>
        <!-- Use absolute path to node binary -->
        <string>/opt/homebrew/bin/node</string>
        <!-- Use absolute path to the compiled daemon entry point -->
        <string>/Users/USER/.local/share/engram/dist/daemon/index.js</string>
    </array>

    <!-- Schedule: Run every 4 hours -->
    <key>StartCalendarInterval</key>
    <array>
        <dict>
            <key>Hour</key>
            <integer>2</integer>
            <key>Minute</key>
            <integer>0</integer>
        </dict>
        <dict>
            <key>Hour</key>
            <integer>6</integer>
            <key>Minute</key>
            <integer>0</integer>
        </dict>
        <dict>
            <key>Hour</key>
            <integer>10</integer>
            <key>Minute</key>
            <integer>0</integer>
        </dict>
        <dict>
            <key>Hour</key>
            <integer>14</integer>
            <key>Minute</key>
            <integer>0</integer>
        </dict>
        <dict>
            <key>Hour</key>
            <integer>18</integer>
            <key>Minute</key>
            <integer>0</integer>
        </dict>
        <dict>
            <key>Hour</key>
            <integer>22</integer>
            <key>Minute</key>
            <integer>0</integer>
        </dict>
    </array>

    <!-- Working directory -->
    <key>WorkingDirectory</key>
    <string>/Users/USER/.local/share/engram</string>

    <!-- Environment variables -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/USER</string>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>ENGRAM_DATA_DIR</key>
        <string>/Users/USER/.local/share/engram</string>
    </dict>

    <!-- Logging -->
    <key>StandardOutPath</key>
    <string>/Users/USER/.local/share/engram/logs/dream-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/USER/.local/share/engram/logs/dream-stderr.log</string>

    <!-- Don't keep alive -- this is a scheduled batch job, not a long-running service -->
    <key>KeepAlive</key>
    <false/>

    <!-- If the job exits within 10 seconds, wait 30 seconds before restarting -->
    <key>ThrottleInterval</key>
    <integer>30</integer>

    <!-- Lower scheduling priority (positive = nicer to other processes) -->
    <key>Nice</key>
    <integer>10</integer>

    <!-- Resource limits -->
    <key>SoftResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>4096</integer>
    </dict>

    <!-- Prevent multiple simultaneous runs -->
    <key>AbandonProcessGroup</key>
    <false/>

    <!-- Allow the job to run even if computer wakes from sleep -->
    <!-- launchd coalesces missed intervals and runs once on wake -->
</dict>
</plist>
```

### 2.2 Key Plist Configuration Options

**Label** (required): Use reverse domain notation. Must be unique across all loaded jobs.

**ProgramArguments**: Array where the first element is the executable path. Shell expansion does NOT work -- all paths must be absolute. Pipes and redirections are not interpreted. To use shell features, wrap with `/bin/sh -c`.

**StartCalendarInterval**: Cron-like scheduling. Omitted keys act as wildcards. If the machine is asleep when a scheduled time passes, launchd coalesces missed events and fires once on wake -- unlike cron which simply skips them.

**KeepAlive**: For a batch processing daemon, set to `false`. The job runs on schedule, does its work, and exits. For a long-running service (like an HTTP server), set to `true` or use conditional KeepAlive.

**ThrottleInterval**: Minimum seconds between restarts. Prevents rapid restart loops if the process crashes immediately. Default is 10 seconds.

**Nice**: Process scheduling priority. 0 is normal, positive values are lower priority (nicer to other processes). For background processing, 10 is appropriate.

(Sources: [launchd.plist man page](https://keith.github.io/xcode-man-pages/launchd.plist.5.html), [launchd Tutorial](https://www.launchd.info/))

### 2.3 Plist Validation

Always validate plist syntax before loading:

```bash
# Check XML syntax
plutil -lint ~/Library/LaunchAgents/com.engram.dream.plist

# Convert to readable JSON for inspection
plutil -convert json -o /dev/stdout ~/Library/LaunchAgents/com.engram.dream.plist
```

File permissions matter:
- The plist file must be owned by the user and have permissions `0644`
- The parent directory (`~/Library/LaunchAgents/`) must have permissions `0755`

(Source: [Debugging launchd plist jobs](https://mobeets.github.io/blog/launchd/))

---

## 3. Scheduling Strategies

### 3.1 Scheduled Batch Processing (Recommended for Engram)

For Engram's dream state daemon, the recommended approach is **scheduled batch processing** using `StartCalendarInterval`. The daemon runs on a schedule, processes all pending work, then exits cleanly.

```xml
<!-- Run at 2 AM daily (primary consolidation) -->
<key>StartCalendarInterval</key>
<dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>0</integer>
</dict>
```

**Advantages:**
- Simple mental model: run, process, exit
- No long-lived process to manage memory for
- Natural checkpoint boundaries between runs
- Can be manually triggered with `launchctl start`

**Sleep handling:** If the Mac is asleep at 2 AM, launchd fires the job when the computer wakes. Multiple missed intervals are coalesced into a single invocation.

### 3.2 Interval-Based Processing

For more frequent processing, use `StartInterval`:

```xml
<!-- Run every 4 hours (14400 seconds) -->
<key>StartInterval</key>
<integer>14400</integer>
```

**Difference from StartCalendarInterval:** `StartInterval` counts seconds since last execution. `StartCalendarInterval` fires at fixed wall-clock times. For a "dream state" metaphor, fixed times make more conceptual sense.

### 3.3 Watch-Based Triggering

launchd can watch filesystem paths and trigger when they change:

```xml
<key>WatchPaths</key>
<array>
    <string>/Users/USER/.local/share/engram/pending/</string>
</array>
```

This could trigger processing when new conversations are ingested. However, for consolidation workloads, scheduled processing is preferred over reactive triggering to allow batching.

### 3.4 Combined Approach

Use `StartCalendarInterval` for regular scheduled runs, with the option for manual triggering via `launchctl start com.engram.dream` or a CLI command (`engram dream --now`).

(Source: [Scheduling Timed Jobs - Apple](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html))

---

## 4. Process Management Patterns

### 4.1 Graceful Shutdown with Signal Handling

When launchd needs to stop a job (e.g., on user logout, `launchctl stop`, or system shutdown), it sends `SIGTERM`. If the process does not exit within 20 seconds, launchd sends `SIGKILL`.

```typescript
// src/daemon/signals.ts
import { DreamPipeline } from './pipeline.js';

let isShuttingDown = false;
let pipeline: DreamPipeline | null = null;

export function setupSignalHandlers(p: DreamPipeline): void {
  pipeline = p;

  // SIGTERM: launchd wants us to stop
  process.on('SIGTERM', async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('[dream] Received SIGTERM, initiating graceful shutdown...');
    try {
      await pipeline?.checkpoint();
      await pipeline?.close();
      console.log('[dream] Graceful shutdown complete.');
      process.exitCode = 0;
    } catch (err) {
      console.error('[dream] Error during shutdown:', err);
      process.exitCode = 1;
    }
  });

  // SIGINT: manual Ctrl+C during development
  process.on('SIGINT', async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('[dream] Received SIGINT, checkpointing and exiting...');
    try {
      await pipeline?.checkpoint();
      await pipeline?.close();
      process.exitCode = 0;
    } catch (err) {
      console.error('[dream] Error during shutdown:', err);
      process.exitCode = 1;
    }
  });
}
```

**Key principle:** Use `process.exitCode = N` and let the event loop drain naturally rather than calling `process.exit(N)` directly. This allows async cleanup to complete.

(Source: [Graceful Shutdown in Node.js](https://dev.to/superiqbal7/graceful-shutdown-in-nodejs-handling-stranger-danger-29jo))

### 4.2 PID File Management

For preventing concurrent execution of the same daemon:

```typescript
// src/daemon/pidfile.ts
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PID_FILE = join(process.env.ENGRAM_DATA_DIR ?? '', 'dream.pid');

export function acquirePidLock(): boolean {
  if (existsSync(PID_FILE)) {
    const existingPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    try {
      // Signal 0 checks if process exists without sending a signal
      process.kill(existingPid, 0);
      // Process is still running -- another instance is active
      console.log(`[dream] Another instance is running (PID ${existingPid}). Exiting.`);
      return false;
    } catch {
      // Process is not running -- stale PID file from a crash
      console.log(`[dream] Removing stale PID file for PID ${existingPid}.`);
      unlinkSync(PID_FILE);
    }
  }

  writeFileSync(PID_FILE, String(process.pid), 'utf-8');
  return true;
}

export function releasePidLock(): void {
  try {
    if (existsSync(PID_FILE)) {
      const storedPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      if (storedPid === process.pid) {
        unlinkSync(PID_FILE);
      }
    }
  } catch {
    // Best effort cleanup
  }
}
```

### 4.3 Preventing Concurrent Runs

launchd does not run a second instance of a job if the first is still running. If `StartCalendarInterval` fires but the previous run is still active, the new run is simply skipped. This provides natural protection against overlapping runs.

However, if the daemon is also triggerable via CLI (`engram dream --now`), a PID file or SQLite advisory lock provides additional safety.

---

## 5. Logging Best Practices

### 5.1 launchd Log Routing

launchd captures stdout and stderr and routes them to the paths specified in the plist:

```xml
<key>StandardOutPath</key>
<string>/Users/USER/.local/share/engram/logs/dream-stdout.log</string>
<key>StandardErrorPath</key>
<string>/Users/USER/.local/share/engram/logs/dream-stderr.log</string>
```

**Important**: These files are opened once when the job starts and appended to on each run. They are NOT automatically rotated. The daemon must handle rotation or use a log rotation mechanism.

### 5.2 Structured Logging Pattern

```typescript
// src/daemon/logger.ts

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
}

function log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    ...(data ? { data } : {}),
  };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  debug: (component: string, msg: string, data?: Record<string, unknown>) => log('debug', component, msg, data),
  info: (component: string, msg: string, data?: Record<string, unknown>) => log('info', component, msg, data),
  warn: (component: string, msg: string, data?: Record<string, unknown>) => log('warn', component, msg, data),
  error: (component: string, msg: string, data?: Record<string, unknown>) => log('error', component, msg, data),
};
```

### 5.3 Log Rotation

Since launchd reopens log files on each job start (for non-KeepAlive jobs), a simple rotation strategy works:

```typescript
// src/daemon/log-rotate.ts
import { renameSync, statSync, existsSync } from 'node:fs';

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATIONS = 5;

export function rotateLogIfNeeded(logPath: string): void {
  if (!existsSync(logPath)) return;

  const stats = statSync(logPath);
  if (stats.size < MAX_LOG_SIZE) return;

  // Rotate: .log -> .log.1 -> .log.2 -> ...
  for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
    const from = `${logPath}.${i}`;
    const to = `${logPath}.${i + 1}`;
    if (existsSync(from)) renameSync(from, to);
  }
  renameSync(logPath, `${logPath}.1`);
}
```

### 5.4 macOS Console.app Integration

The `node-mac` library automatically creates log files visible through macOS Console.app at `/Library/Logs/<name>/`. For a user-level agent, placing logs at `~/Library/Logs/engram/` follows macOS conventions and makes them discoverable.

(Source: [node-mac npm](https://www.npmjs.com/package/node-mac))

---

## 6. Error Recovery and Restart Policies

### 6.1 Exit Code Semantics

launchd interprets exit codes to decide restart behavior:

| Exit Code | Meaning | launchd Behavior |
|-----------|---------|-----------------|
| 0 | Success | Normal completion, do not restart (unless KeepAlive) |
| 1-127 | Error | May restart based on KeepAlive/SuccessfulExit config |
| 128+N | Signal N | Process killed by signal |

### 6.2 KeepAlive Policies

For a batch processing daemon (not long-running), the relevant KeepAlive option is:

```xml
<!-- Restart only on crash (non-zero exit) -->
<key>KeepAlive</key>
<dict>
    <key>SuccessfulExit</key>
    <false/>
</dict>
```

This means: restart the job only if it exited with a non-zero exit code (i.e., it crashed). Successful completions do not trigger a restart.

### 6.3 Crash-Safe Recovery with ThrottleInterval

```xml
<!-- Wait at least 60 seconds between crash restarts -->
<key>ThrottleInterval</key>
<integer>60</integer>
```

If the daemon crashes immediately on startup (e.g., configuration error), ThrottleInterval prevents rapid restart loops that waste CPU and fill logs.

### 6.4 node-mac's Exponential Backoff

The `node-mac` library implements intelligent restart behavior: "node-mac adds 25% to the wait interval each time it needs to restart the script." This prevents thundering herd effects on persistent failures.

A similar pattern can be implemented at the application level:

```typescript
// src/daemon/retry.ts
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 5000;

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= MAX_RETRIES) {
        throw new Error(`[${label}] Failed after ${MAX_RETRIES} attempts: ${err}`);
      }
      const delay = BASE_DELAY_MS * Math.pow(1.25, attempt);
      console.warn(`[${label}] Attempt ${attempt} failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
```

(Sources: [node-mac](https://github.com/coreybutler/node-mac), [launchd Tutorial](https://www.launchd.info/))

---

## 7. Health Checks and Watchdog Patterns

### 7.1 launchd as Watchdog

launchd inherently acts as a watchdog when `KeepAlive` is enabled. It monitors the process and restarts it if it dies. Unlike dedicated watchdog daemons, launchd requires that processes do not fork or daemonize on their own -- launchd manages the lifecycle.

> "Similar to watchdogd, launchd can monitor daemons to make sure that they keep running."

(Source: [What are launchd agents and daemons on macOS?](https://victoronsoftware.com/posts/macos-launchd-agents-and-daemons/))

### 7.2 Application-Level Health Monitoring

For the dream state daemon, which is a batch processor (not a long-running service), health monitoring takes a different form:

```typescript
// src/daemon/health.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface HealthStatus {
  lastRunStart: string;
  lastRunEnd: string | null;
  lastRunStatus: 'running' | 'success' | 'error';
  lastError: string | null;
  conversationsProcessed: number;
  factsExtracted: number;
  entitiesResolved: number;
}

const HEALTH_FILE = join(process.env.ENGRAM_DATA_DIR ?? '', 'dream-health.json');

export function writeHealth(status: HealthStatus): void {
  writeFileSync(HEALTH_FILE, JSON.stringify(status, null, 2), 'utf-8');
}
```

The CLI can then read this health file:

```bash
# Check dream state daemon health
engram dream --status
# Output: Last run: 2026-02-26T02:00:00Z | Status: success | Processed: 12 conversations
```

### 7.3 Heartbeat Pattern for Long Runs

If the daemon's batch processing takes a long time, a heartbeat file can signal liveness:

```typescript
const HEARTBEAT_FILE = join(process.env.ENGRAM_DATA_DIR ?? '', 'dream-heartbeat');
let heartbeatInterval: NodeJS.Timeout;

export function startHeartbeat(): void {
  heartbeatInterval = setInterval(() => {
    writeFileSync(HEARTBEAT_FILE, new Date().toISOString(), 'utf-8');
  }, 30_000); // Every 30 seconds
}

export function stopHeartbeat(): void {
  clearInterval(heartbeatInterval);
}
```

An external monitoring script (or a separate launchd agent) can check if the heartbeat file is stale and alert the user or force-kill a hung process.

---

## 8. Node.js-Specific Considerations

### 8.1 Uncaught Exception Handling

The critical rule for Node.js daemons: **never try to keep running after an uncaught exception**. The application is in an unknown, potentially corrupt state.

```typescript
// src/daemon/index.ts

// Must be registered before any async work
process.on('uncaughtException', (err) => {
  console.error('[dream] FATAL: Uncaught exception:', err);
  console.error(err.stack);
  // Attempt to checkpoint current progress
  pipeline?.checkpointSync?.();
  process.exitCode = 1;
  // Do NOT call process.exit() -- let cleanup handlers run
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[dream] FATAL: Unhandled promise rejection:', reason);
  // Treat as fatal -- convert to uncaught exception
  throw reason;
});
```

> "You must have handlers for `process.on('uncaughtException')` and `process.on('unhandledRejection')`, and their only job is to log the error with as much detail as possible and then gracefully shut down."

(Source: [Let It Crash: Best Practices for Handling Node.js Errors on Shutdown](https://blog.heroku.com/best-practices-nodejs-errors))

### 8.2 Memory Management

For a batch processing daemon that runs periodically:

1. **Process exit is the best garbage collector.** Since the daemon exits after each batch run, memory leaks are naturally bounded. This is a major advantage of the scheduled-exit pattern over a long-running daemon.

2. **Monitor memory during processing.** For large batches, track heap usage:

```typescript
function logMemoryUsage(label: string): void {
  const mem = process.memoryUsage();
  console.log(`[dream] Memory (${label}): RSS=${(mem.rss / 1024 / 1024).toFixed(1)}MB, Heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`);
}
```

3. **Set memory limits.** Node.js defaults to ~4GB heap on 64-bit systems. For background processing, constrain it:

```xml
<key>ProgramArguments</key>
<array>
    <string>/opt/homebrew/bin/node</string>
    <string>--max-old-space-size=1024</string>
    <string>/path/to/daemon/index.js</string>
</array>
```

### 8.3 Event Loop Awareness

The Node.js event loop is critical for daemon behavior:

- **Process exits when the event loop is empty.** After the batch work completes, ensure all timers, handles, and listeners are cleaned up so the process can exit naturally.
- **Unref timers and handles** that should not keep the process alive:

```typescript
// A timer that should not prevent process exit
const timer = setInterval(heartbeat, 30_000);
timer.unref(); // Won't keep process alive
```

- **Close database connections, HTTP clients, and file handles** in the shutdown path.

### 8.4 Native Module Considerations

Engram uses `better-sqlite3` (native C++ addon) and `sqlite-vec` (native vector extension). Native modules require:

1. **Matching Node.js version at runtime.** The plist must point to the same Node.js binary used during `npm install`.
2. **Environment variables for native resolution.** Ensure `NODE_PATH` or working directory is set correctly.
3. **Clean shutdown.** `better-sqlite3` connections should be explicitly closed before exit to ensure WAL checkpoints complete.

```typescript
// Always close the database on shutdown
process.on('SIGTERM', () => {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  process.exitCode = 0;
});
```

### 8.5 ESM Module Loading

Engram uses `"type": "module"` (ESM). Node.js 22+ runs TypeScript natively with `--experimental-strip-types` (default in v23+). For the compiled daemon:

```xml
<key>ProgramArguments</key>
<array>
    <string>/opt/homebrew/bin/node</string>
    <!-- ESM entry point (compiled .js) -->
    <string>/Users/USER/.local/share/engram/dist/daemon/index.js</string>
</array>
```

Alternatively, for development, use `tsx` directly:

```xml
<key>ProgramArguments</key>
<array>
    <string>/opt/homebrew/bin/npx</string>
    <string>tsx</string>
    <string>/Users/USER/Documents/git/engram/src/daemon/index.ts</string>
</array>
```

(Source: [A Modern Node.js + TypeScript Setup for 2025](https://dev.to/woovi/a-modern-nodejs-typescript-setup-for-2025-nlk))

---

## 9. Alternative Approaches

### 9.1 launchd vs cron

| Feature | launchd | cron |
|---------|---------|------|
| Status on macOS | Recommended | Deprecated |
| Sleep handling | Fires on wake (coalesced) | Skips missed intervals |
| Process monitoring | Built-in watchdog | None |
| Logging | StandardOutPath/StandardErrorPath | Requires manual setup |
| Environment | Full control via plist | Minimal environment |
| Conditional start | KeepAlive conditions, WatchPaths | None |
| Process priority | Nice value configurable | Not directly |

**Verdict:** launchd is strictly superior on macOS. cron is deprecated and lacks sleep handling, which is critical for a laptop/desktop that may sleep frequently.

(Source: [How to transition from CRONTAB to Launchd on macOS](https://discussions.apple.com/thread/255838871))

### 9.2 launchd vs pm2

pm2 is a Node.js process manager commonly used on Linux servers.

| Feature | launchd | pm2 |
|---------|---------|-----|
| macOS native | Yes | Requires Node.js |
| Boot integration | Native plist | Requires setup script |
| Scheduling | StartCalendarInterval, StartInterval | cron module |
| Log management | Basic (file redirect) | Built-in rotation, merge |
| Process monitoring | Built-in | Built-in with dashboard |
| Cluster mode | No | Yes |
| Extra dependency | None | npm package |

**Verdict:** For a single-user macOS daemon, launchd is simpler and more reliable. pm2 adds a dependency without significant benefits for this use case. pm2 shines in multi-process server deployments.

(Source: [Setting up a LaunchDaemon with pm2](https://gist.github.com/bf3a33c5a82a2d93bba4))

### 9.3 launchd vs node-mac

`node-mac` is a library that generates launchd plist files and manages service lifecycle from JavaScript:

```javascript
const { Service } = require('node-mac');

const svc = new Service({
  name: 'Engram Dream',
  description: 'Background memory consolidation daemon',
  script: '/path/to/daemon/index.js',
  logpath: '/Users/USER/Library/Logs/engram/',
});

svc.on('install', () => svc.start());
svc.install();
```

**Advantages:** Simplifies plist generation, handles log directory setup.
**Disadvantages:** Creates system-level daemons (requires sudo), last updated 2023, uses CommonJS.

**Verdict:** For Engram, generating the plist directly is preferred -- it provides full control over scheduling and avoids an extra dependency. The plist template above covers everything node-mac would provide.

(Source: [node-mac GitHub](https://github.com/coreybutler/node-mac))

### 9.4 launchd vs Homebrew Services

Homebrew provides `brew services` which wraps launchd:

```bash
brew services start engram
brew services stop engram
```

This requires a Homebrew formula for Engram, which is overkill for a personal tool. Direct plist management is simpler.

---

## 10. Real-World Examples

### 10.1 LM Studio Background Service

LM Studio runs local LLMs on macOS using MLX. It manages a background process that keeps models loaded. It uses launchd for process management and handles model warm/cold start transitions.

### 10.2 Ollama Daemon

Ollama runs as a macOS background service:
- Installed via Homebrew: `brew install ollama`
- Uses launchd to manage `ollama serve` process
- Keeps models in memory with configurable timeout (`OLLAMA_KEEP_ALIVE`)
- Exposes HTTP API on localhost:11434
- Architecture: daemon manages model lifecycle, CLI client communicates via API

This is relevant for Engram's integration pattern: the daemon can start Ollama/MLX server as a subprocess and communicate via HTTP.

### 10.3 Scheduled Script Pattern (Simple)

From the macOS community, a common pattern for scheduled Node.js tasks:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.daily-script</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>/usr/local/bin/node /path/to/script.js >> /path/to/log 2>&1</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>3</integer>
    </dict>
</dict>
</plist>
```

Note the `/bin/sh -c` wrapper to enable shell features (stderr redirect). Engram's plist avoids this by using separate StandardOutPath/StandardErrorPath keys.

(Source: [Schedule Node.js Scripts on Your Mac With Launchd](https://medium.com/better-programming/schedule-node-js-scripts-on-your-mac-with-launchd-a7fca82fbf02))

---

## 11. Key Takeaways for Engram

### Architecture Decision: Scheduled Batch Agent

The dream state daemon should be implemented as a **launchd Launch Agent** (not Daemon) that runs on a configurable schedule. The recommended pattern:

1. **Scheduled runs** via `StartCalendarInterval` (e.g., every 4-6 hours, or daily at 2 AM)
2. **Process-per-run**: Each invocation is a fresh Node.js process. No long-lived process.
3. **Natural memory management**: Process exit after each batch cleans up all resources.
4. **Checkpoint on exit**: If interrupted by SIGTERM, save progress for the next run.
5. **Idempotent**: Safe to run again -- resumes from last checkpoint.

### Plist Installation

The CLI should include an install command:

```bash
# Install the launchd agent
engram dream --install

# Uninstall
engram dream --uninstall

# Check status
engram dream --status

# Trigger immediately
engram dream --now
```

The install command generates the plist with correct absolute paths and loads it via `launchctl`.

### Signal Handling Checklist

1. Handle `SIGTERM` (launchd shutdown) -- checkpoint and exit cleanly
2. Handle `SIGINT` (manual Ctrl+C) -- checkpoint and exit cleanly
3. Handle `uncaughtException` -- log, attempt checkpoint, exit with code 1
4. Handle `unhandledRejection` -- convert to uncaughtException
5. Use `process.exitCode` instead of `process.exit()` for clean shutdown
6. Close database connections explicitly (WAL checkpoint + close)

### File Structure

```
~/.local/share/engram/
  engram.db            # Main SQLite database
  logs/
    dream-stdout.log   # launchd stdout capture
    dream-stderr.log   # launchd stderr capture
  dream.pid            # PID lock file
  dream-health.json    # Last run status
~/Library/LaunchAgents/
  com.engram.dream.plist  # launchd job definition
```

---

## Sources

### Apple Documentation
- [Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [Scheduling Timed Jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html)
- [launchd.plist man page](https://keith.github.io/xcode-man-pages/launchd.plist.5.html)

### Tutorials and Guides
- [launchd Tutorial (launchd.info)](https://www.launchd.info/)
- [Launch a Node Script at Boot on macOS](https://dev.to/mjehanno/launch-a-node-script-at-boot-on-macos-1dnd)
- [Schedule Node.js Scripts on Your Mac With Launchd](https://medium.com/better-programming/schedule-node-js-scripts-on-your-mac-with-launchd-a7fca82fbf02)
- [A Simple Launchd Tutorial](https://medium.com/@chetcorcos/a-simple-launchd-tutorial-9fecfcf2dbb3)
- [Overview of launchd Services](https://gist.github.com/johndturn/09a5c055e6a56ab61212204607940fa0)
- [Notes on Apple's Under-documented launchd](https://gist.github.com/dabrahams/4092951)
- [Debugging launchd plist jobs](https://mobeets.github.io/blog/launchd/)
- [What are launchd agents and daemons on macOS?](https://victoronsoftware.com/posts/macos-launchd-agents-and-daemons/)
- [Mastering macOS Process Management](https://osxhub.com/macos-process-management-ps-kill-launchctl-guide/)

### Node.js Best Practices
- [Let It Crash: Best Practices for Handling Node.js Errors on Shutdown](https://blog.heroku.com/best-practices-nodejs-errors)
- [Graceful Shutdown in Node.js](https://dev.to/superiqbal7/graceful-shutdown-in-nodejs-handling-stranger-danger-29jo)
- [Don't Let Your Node.js App Die Ugly](https://dev.to/nse569h/dont-let-your-nodejs-app-die-ugly-a-guide-to-perfect-graceful-shutdowns-ing)
- [Node.js Process Exit Strategies](https://leapcell.io/blog/nodejs-process-exit-strategies)
- [Node.js Process Lifecycle](https://www.thenodebook.com/node-arch/node-process-lifecycle)

### Tools and Libraries
- [node-mac GitHub](https://github.com/coreybutler/node-mac)
- [Setting up a LaunchDaemon with pm2](https://gist.github.com/bf3a33c5a82a2d93bba4)
- [launchd macOS Examples](https://alvinalexander.com/mac-os-x/launchd-examples-launchd-plist-file-examples-mac/)
- [Scheduled Jobs on macOS with launchd](https://blog.darnell.io/automation-on-macos-with-launchctl/)
