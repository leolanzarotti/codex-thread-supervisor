import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendJsonl(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

function isoForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function threadStatusType(threadReadResponse) {
  return threadReadResponse?.thread?.status?.type || "unknown";
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function readJsonFile(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
}

function writeJsonFileAtomic(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function defaultState() {
  return {
    version: 1,
    attachments: [],
  };
}

class JsonRpcClient {
  constructor(transport, eventLogPath) {
    this.transport = transport;
    this.eventLogPath = eventLogPath;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = [];
  }

  async connect() {
    await this.transport.connect((message) => this.onMessage(message));
  }

  async close() {
    await this.transport.close();
  }

  onMessage(message) {
    if (this.eventLogPath) {
      appendJsonl(this.eventLogPath, {
        ts: nowIso(),
        direction: "in",
        message,
      });
    }
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const entry = this.pending.get(message.id);
      if (!entry) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(JSON.stringify(message.error)));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    this.notifications.push(message);
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        waiter.resolve(message);
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
      }
    }
  }

  async request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { jsonrpc: "2.0", id, method, params };
    if (this.eventLogPath) {
      appendJsonl(this.eventLogPath, {
        ts: nowIso(),
        direction: "out",
        message: payload,
      });
    }
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.transport.send(payload);
    return response;
  }

  waitForNotification(predicate, timeoutMs) {
    const seen = this.notifications.find(predicate);
    if (seen) {
      return Promise.resolve(seen);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for notification`));
      }, timeoutMs);
      const waiter = {
        predicate,
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
      };
      this.waiters.push(waiter);
    });
  }
}

class StdioTransport {
  constructor() {
    this.proc = null;
  }

  async connect(onMessage) {
    this.proc = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const stdoutRl = readline.createInterface({ input: this.proc.stdout });
    stdoutRl.on("line", (line) => {
      if (line.trim()) {
        onMessage(JSON.parse(line));
      }
    });

    const stderrRl = readline.createInterface({ input: this.proc.stderr });
    stderrRl.on("line", (line) => {
      if (line.trim()) {
        console.error(line);
      }
    });

    await new Promise((resolve) => this.proc.once("spawn", resolve));
  }

  send(payload) {
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async close() {
    if (!this.proc) {
      return;
    }
    this.proc.kill("SIGTERM");
    await new Promise((resolve) => {
      this.proc.once("exit", resolve);
      setTimeout(resolve, 1000);
    });
  }
}

function parseWebSocketUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "ws:") {
    throw new Error(`Unsupported websocket URL: ${url}`);
  }
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 80),
  };
}

function managedAppServerPaths(options, url) {
  const { port } = parseWebSocketUrl(url);
  return {
    pidPath: path.join(options.runDir, `app-server-${port}.pid`),
    logPath: path.join(options.logDir, `app-server-${port}.log`),
  };
}

function startManagedAppServer(options, url) {
  const { pidPath, logPath } = managedAppServerPaths(options, url);
  const existingPid = readPid({ pidPath });
  if (isPidRunning(existingPid)) {
    return { status: "already_running", pid: existingPid, pidPath, logPath };
  }
  safeUnlink(pidPath);

  const out = fs.openSync(logPath, "a");
  const err = fs.openSync(logPath, "a");
  const child = spawn("codex", ["app-server", "--listen", url], {
    cwd: options.rootDir,
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
  });
  child.unref();
  fs.writeFileSync(pidPath, `${child.pid}\n`);
  return { status: "started", pid: child.pid, pidPath, logPath };
}

function stopManagedAppServer(options, url) {
  const { pidPath } = managedAppServerPaths(options, url);
  const pid = readPid({ pidPath });
  if (!isPidRunning(pid)) {
    safeUnlink(pidPath);
    return { status: "not_running", pidPath, pid };
  }
  process.kill(pid, "SIGTERM");
  safeUnlink(pidPath);
  return { status: "stopped", pidPath, pid };
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

class WebSocketTransport {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.ws = null;
    this.fallback = null;
    this.startedManagedServer = false;
  }

  async openSocket(onMessage, timeoutMs = 3000) {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (event) => {
      onMessage(JSON.parse(event.data.toString()));
    });
    let timeout = null;
    await new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Timed out connecting to ${this.url}`));
      }, timeoutMs);
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    }).finally(() => {
      clearTimeout(timeout);
    });
  }

  async connect(onMessage) {
    try {
      await this.openSocket(onMessage);
      return;
    } catch (initialError) {
      try {
        this.ws?.close();
      } catch {}
      const { host } = parseWebSocketUrl(this.url);
      if (!isLoopbackHost(host)) {
        throw initialError;
      }

      const appServer = startManagedAppServer(this.options, this.url);
      this.startedManagedServer = appServer.status === "started";
      const deadline = nowMs() + 10000;
      let lastError = initialError;
      while (nowMs() < deadline) {
        try {
          await sleep(250);
          await this.openSocket(onMessage, 1000);
          return;
        } catch (error) {
          lastError = error;
          try {
            this.ws?.close();
          } catch {}
        }
      }

      this.fallback = new StdioTransport();
      try {
        await this.fallback.connect(onMessage);
      } catch (fallbackError) {
        if (this.startedManagedServer) {
          stopManagedAppServer(this.options, this.url);
          this.startedManagedServer = false;
        }
        throw new Error(
          `Could not connect to ${this.url} (${lastError.message}); stdio fallback also failed: ${fallbackError.message}`,
        );
      }
    }
  }

  send(payload) {
    if (this.fallback) {
      this.fallback.send(payload);
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  async close() {
    if (this.fallback) {
      await this.fallback.close();
      if (this.startedManagedServer) {
        stopManagedAppServer(this.options, this.url);
        this.startedManagedServer = false;
      }
      return;
    }
    if (!this.ws) {
      if (this.startedManagedServer) {
        stopManagedAppServer(this.options, this.url);
        this.startedManagedServer = false;
      }
      return;
    }
    this.ws.close();
    await new Promise((resolve) => {
      this.ws.addEventListener("close", resolve, { once: true });
      setTimeout(resolve, 1000);
    });
    if (this.startedManagedServer) {
      stopManagedAppServer(this.options, this.url);
      this.startedManagedServer = false;
    }
  }
}

function buildTransport(options) {
  if (options.transport === "ws") {
    return new WebSocketTransport(options.wsUrl, options);
  }
  return new StdioTransport();
}

function resolvePaths(args) {
  const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname));
  const logDir = path.resolve(args["log-dir"] || path.join(rootDir, "logs"));
  const statePath = path.resolve(args["state-file"] || path.join(rootDir, "state", "attachments.json"));
  const runDir = path.resolve(args["run-dir"] || path.join(rootDir, "run"));
  const pidPath = path.join(runDir, "daemon.pid");
  const daemonLogPath = path.join(logDir, "daemon.log");
  ensureDir(logDir);
  ensureDir(path.dirname(statePath));
  ensureDir(runDir);
  return { rootDir, logDir, statePath, runDir, pidPath, daemonLogPath };
}

function buildRunOptions(args) {
  const { rootDir, logDir, statePath, runDir, pidPath, daemonLogPath } = resolvePaths(args);
  const runId = `${isoForFile()}-${crypto.randomBytes(3).toString("hex")}`;
  return {
    command: args._[0],
    threadId: args["thread-id"],
    prompt: args.prompt,
    transport: args.transport || "stdio",
    wsUrl: args["ws-url"] || "ws://127.0.0.1:9234",
    rootDir,
    logDir,
    statePath,
    runDir,
    pidPath,
    daemonLogPath,
    runId,
    eventLogPath: args["debug-events"] ? path.join(logDir, `${runId}.events.jsonl`) : null,
    summaryLogPath: path.join(logDir, "heartbeats.jsonl"),
    everyMinutes: Number(args["every-minutes"] || 1),
    sms: Boolean(args.sms),
    smsScript:
      args["sms-script"] ||
      "/home/ubuntulxc/leo-codex-workspace/skills/free-mobile-sms/scripts/send_free_mobile_sms.sh",
    timeoutMs: Number(args["timeout-ms"] || 300000),
    idleTimeoutMs: Number(args["idle-timeout-ms"] || 300000),
    label: args.label || null,
    attachmentId: args.id || null,
    cwd: args.cwd || process.cwd(),
    pollSeconds: Number(args["poll-seconds"] || 30),
    limit: Number(args.limit || 5),
    debugEvents: Boolean(args["debug-events"]),
    eventRetentionHours: Number(args["event-retention-hours"] || 6),
    heartbeatRetentionHours: Number(args["heartbeat-retention-hours"] || 168),
    daemonLogMaxBytes: Number(args["daemon-log-max-bytes"] || 10 * 1024 * 1024),
    daemonLogKeepBytes: Number(args["daemon-log-keep-bytes"] || 1024 * 1024),
  };
}

function validateRunOptions(options) {
  if (!options.command) {
    throw new Error("Missing command.");
  }
  if (options.transport !== "stdio" && options.transport !== "ws") {
    throw new Error("Unsupported --transport. Use stdio or ws.");
  }
  if (options.transport === "ws" && !options.wsUrl) {
    throw new Error("Missing --ws-url for websocket transport.");
  }
}

function validateSingleRunOptions(options) {
  validateRunOptions(options);
  if (!options.threadId) {
    throw new Error("Missing --thread-id");
  }
  if (!options.prompt) {
    throw new Error("Missing --prompt");
  }
}

function loadState(statePath) {
  return readJsonFile(statePath, defaultState());
}

function saveState(statePath, state) {
  writeJsonFileAtomic(statePath, state);
}

function createAttachmentFromOptions(options, threadId) {
  return {
    id: options.attachmentId || randomId("attachment"),
    label: options.label || `thread-${threadId}`,
    threadId,
    prompt: options.prompt,
    transport: options.transport,
    wsUrl: options.transport === "ws" ? options.wsUrl : null,
    everyMinutes: options.everyMinutes,
    sms: options.sms,
    smsScript: options.smsScript,
    enabled: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    nextRunAt: nowIso(),
    lastRunAt: null,
    lastStatus: "attached",
    lastError: null,
    lastTurnId: null,
    lastAssistantMessage: null,
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function compactText(text, maxLength = 240) {
  if (!text) {
    return null;
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function compactSummary(summary) {
  return {
    ts: summary.ts,
    runId: summary.runId,
    startedAt: summary.startedAt,
    transport: summary.transport,
    wsUrl: summary.wsUrl,
    status: summary.status,
    error: summary.error || null,
    threadId: summary.result?.threadId || null,
    turnId: summary.result?.turnId || null,
    beforeTurnCount: summary.result?.beforeTurnCount ?? null,
    afterTurnCount: summary.result?.afterTurnCount ?? null,
    assistantMessage: compactText(summary.result?.assistantMessages?.[0] || null),
    durationMs: summary.result?.completed?.params?.turn?.durationMs ?? null,
    smsCode: summary.sms?.code ?? null,
    smsStdout: compactText(summary.sms?.stdout || null, 120),
  };
}

function cleanupOldFilesBySuffix(dirPath, suffix, maxAgeMs) {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  const cutoff = nowMs() - maxAgeMs;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(suffix)) {
      continue;
    }
    const filePath = path.join(dirPath, entry.name);
    const stats = fs.statSync(filePath);
    if (stats.mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
    }
  }
}

function trimJsonlByAge(filePath, maxAgeMs, transformEntry = null) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const cutoff = nowMs() - maxAgeMs;
  const keptLines = [];
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const ts = parsed.ts ? Date.parse(parsed.ts) : NaN;
      if (!Number.isNaN(ts) && ts >= cutoff) {
        const transformed = transformEntry ? transformEntry(parsed) : parsed;
        keptLines.push(JSON.stringify(transformed));
      }
    } catch {
      keptLines.push(line);
    }
  }
  fs.writeFileSync(filePath, keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "");
}

function trimDaemonLog(filePath, maxBytes, keepBytes) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const stats = fs.statSync(filePath);
  if (stats.size <= maxBytes) {
    return;
  }
  const content = fs.readFileSync(filePath);
  const sliceStart = Math.max(0, content.length - keepBytes);
  fs.writeFileSync(filePath, content.subarray(sliceStart));
}

function cleanupLogs(options) {
  cleanupOldFilesBySuffix(
    options.logDir,
    ".events.jsonl",
    options.eventRetentionHours * 60 * 60 * 1000,
  );
  trimJsonlByAge(
    options.summaryLogPath,
    options.heartbeatRetentionHours * 60 * 60 * 1000,
    compactSummary,
  );
  trimDaemonLog(
    options.daemonLogPath,
    options.daemonLogMaxBytes,
    options.daemonLogKeepBytes,
  );
}

function runSqliteQueryJson(dbPath, sql) {
  const result = spawnSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `sqlite3 failed with code ${result.status}`);
  }
  return JSON.parse(result.stdout || "[]");
}

function currentThreadCandidates(options) {
  const dbPath = path.join(process.env.HOME || "/home/ubuntulxc", ".codex", "state_5.sqlite");
  const where = [`archived = 0`];
  if (options.cwd) {
    where.push(`cwd = '${sqlEscape(options.cwd)}'`);
  }
  const sql = `
select id, title, cwd, updated_at_ms, rollout_path, first_user_message
from threads
where ${where.join(" and ")}
order by updated_at_ms desc
limit ${Math.max(1, options.limit)};
`;
  return runSqliteQueryJson(dbPath, sql).map((row) => ({
    id: row.id,
    title: row.title || null,
    cwd: row.cwd,
    updatedAtMs: Number(row.updated_at_ms),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    rolloutPath: row.rollout_path,
    firstUserMessage: row.first_user_message || null,
  }));
}

function inferCurrentThread(options) {
  const candidates = currentThreadCandidates(options);
  if (candidates.length === 0) {
    throw new Error(`No current-thread candidate found for cwd=${options.cwd}`);
  }
  return {
    selected: candidates[0],
    candidates,
  };
}

async function initialize(client) {
  return client.request("initialize", {
    clientInfo: {
      name: "codex-thread-supervisor",
      title: "Codex Thread Supervisor",
      version: "0.0.2",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
}

async function runTurn(client, options) {
  let before = await client.request("thread/read", {
    threadId: options.threadId,
    includeTurns: true,
  });
  let resumed = null;

  if (threadStatusType(before) === "notLoaded") {
    resumed = await client.request("thread/resume", {
      threadId: options.threadId,
      persistExtendedHistory: true,
    });
    before = await client.request("thread/read", {
      threadId: options.threadId,
      includeTurns: true,
    });
  }

  const idleDeadline = nowMs() + options.idleTimeoutMs;
  while (threadStatusType(before) !== "idle") {
    if (nowMs() > idleDeadline) {
      throw new Error(
        `Thread ${options.threadId} is not idle; current status=${threadStatusType(before)}`,
      );
    }
    await sleep(3000);
    before = await client.request("thread/read", {
      threadId: options.threadId,
      includeTurns: true,
    });
    if (threadStatusType(before) === "notLoaded" && !resumed) {
      resumed = await client.request("thread/resume", {
        threadId: options.threadId,
        persistExtendedHistory: true,
      });
      before = await client.request("thread/read", {
        threadId: options.threadId,
        includeTurns: true,
      });
    }
  }

  if (!resumed) {
    resumed = await client.request("thread/resume", {
      threadId: options.threadId,
      persistExtendedHistory: true,
    });
  }

  const start = await client.request("turn/start", {
    threadId: options.threadId,
    input: [
      {
        type: "text",
        text: options.prompt,
        text_elements: [],
      },
    ],
  });

  const turnId = start.turn.id;
  const completed = await client.waitForNotification(
    (message) =>
      message.method === "turn/completed" &&
      message.params?.threadId === options.threadId &&
      message.params?.turn?.id === turnId,
    options.timeoutMs,
  );

  const after = await client.request("thread/read", {
    threadId: options.threadId,
    includeTurns: true,
  });

  const latestTurn = after.thread.turns[after.thread.turns.length - 1] || null;
  const assistantMessages = (latestTurn?.items || [])
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text);

  return {
    threadId: options.threadId,
    resumedThreadId: resumed.thread.id,
    turnId,
    beforeTurnCount: before.thread.turns.length,
    afterTurnCount: after.thread.turns.length,
    assistantMessages,
    completed,
    after,
  };
}

async function sendSms(options, summaryText) {
  const child = spawn(options.smsScript, ["--msg", summaryText], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  return {
    code,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}

function buildSmsText(result) {
  const firstMessage = result.assistantMessages[0] || "no assistant text captured";
  return `Codex supervisor OK thread=${result.threadId} turn=${result.turnId} msg=${firstMessage}`.slice(
    0,
    159,
  );
}

async function executeSingleRun(options) {
  cleanupLogs(options);
  const transport = buildTransport(options);
  const client = new JsonRpcClient(transport, options.eventLogPath);
  const startedAt = nowIso();

  try {
    await client.connect();
    const init = await initialize(client);
    const result = await runTurn(client, options);
    let sms = null;
    if (options.sms) {
      sms = await sendSms(options, buildSmsText(result));
    }
    const summary = {
      ts: nowIso(),
      runId: options.runId,
      startedAt,
      transport: options.transport,
      wsUrl: options.transport === "ws" ? options.wsUrl : null,
      init,
      result,
      sms,
      status: "ok",
    };
    appendJsonl(options.summaryLogPath, compactSummary(summary));
    return summary;
  } catch (error) {
    const summary = {
      ts: nowIso(),
      runId: options.runId,
      startedAt,
      transport: options.transport,
      wsUrl: options.transport === "ws" ? options.wsUrl : null,
      status: "error",
      error: error.message,
    };
    appendJsonl(options.summaryLogPath, compactSummary(summary));
    return summary;
  } finally {
    await client.close();
    if (!options.debugEvents && options.eventLogPath) {
      safeUnlink(options.eventLogPath);
    }
  }
}

async function runOnce(options) {
  const summary = await executeSingleRun(options);
  if (summary.status === "error") {
    console.error(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
  return summary;
}

async function loopSingleThread(options) {
  while (true) {
    const runOptions = {
      ...options,
      runId: `${isoForFile()}-${crypto.randomBytes(3).toString("hex")}`,
      eventLogPath: options.debugEvents
        ? path.join(
            options.logDir,
            `${isoForFile()}-${crypto.randomBytes(3).toString("hex")}.events.jsonl`,
          )
        : null,
    };
    await runOnce(runOptions);
    await sleep(options.everyMinutes * 60 * 1000);
  }
}

function upsertAttachment(state, attachment) {
  const existingIndex = state.attachments.findIndex((entry) => entry.threadId === attachment.threadId);
  if (existingIndex >= 0) {
    state.attachments[existingIndex] = {
      ...state.attachments[existingIndex],
      ...attachment,
      updatedAt: nowIso(),
    };
    return state.attachments[existingIndex];
  }
  state.attachments.push(attachment);
  return attachment;
}

function listAttachments(state) {
  return state.attachments
    .slice()
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

async function attachThread(options, threadId) {
  if (!options.prompt) {
    throw new Error("Missing --prompt");
  }
  const state = loadState(options.statePath);
  const attachment = upsertAttachment(state, createAttachmentFromOptions(options, threadId));
  saveState(options.statePath, state);
  const daemon = daemonStart(options);
  printJson({
    status: "attached",
    statePath: options.statePath,
    attachment,
    daemon,
  });
}

function detachAttachment(options) {
  const state = loadState(options.statePath);
  const beforeCount = state.attachments.length;
  state.attachments = state.attachments.filter((entry) => {
    if (options.attachmentId && entry.id === options.attachmentId) {
      return false;
    }
    if (options.threadId && entry.threadId === options.threadId) {
      return false;
    }
    return true;
  });
  saveState(options.statePath, state);
  const daemon = state.attachments.length === 0 ? daemonStop(options) : null;
  printJson({
    status: state.attachments.length < beforeCount ? "detached" : "not_found",
    statePath: options.statePath,
    attachmentId: options.attachmentId,
    threadId: options.threadId,
    remaining: state.attachments.length,
    daemon,
  });
}

function printAttachments(options) {
  const state = loadState(options.statePath);
  printJson({
    statePath: options.statePath,
    attachments: listAttachments(state),
  });
}

function printCurrentThread(options) {
  printJson(inferCurrentThread(options));
}

async function runAttachmentOnce(options, attachment) {
  const runId = `${isoForFile()}-${attachment.id}`;
  const runOptions = {
    ...options,
    threadId: attachment.threadId,
    prompt: attachment.prompt,
    transport: attachment.transport,
    wsUrl: attachment.wsUrl || options.wsUrl,
    sms: attachment.sms,
    smsScript: attachment.smsScript || options.smsScript,
    runId,
    eventLogPath: options.debugEvents ? path.join(options.logDir, `${runId}.events.jsonl`) : null,
  };
  return executeSingleRun(runOptions);
}

async function tickAttachments(options) {
  cleanupLogs(options);
  const state = loadState(options.statePath);
  const due = state.attachments.filter(
    (entry) => entry.enabled !== false && new Date(entry.nextRunAt).getTime() <= nowMs(),
  );
  const results = [];

  for (const attachment of due) {
    const summary = await runAttachmentOnce(options, attachment);
    const stateEntry = state.attachments.find((entry) => entry.id === attachment.id);
    if (!stateEntry) {
      continue;
    }
    stateEntry.updatedAt = nowIso();
    stateEntry.lastRunAt = summary.ts;
    stateEntry.nextRunAt = new Date(
      new Date(summary.ts).getTime() + attachment.everyMinutes * 60 * 1000,
    ).toISOString();
    stateEntry.lastStatus = summary.status;
    stateEntry.lastError = summary.error || null;
    stateEntry.lastTurnId = summary.result?.turnId || null;
    stateEntry.lastAssistantMessage = summary.result?.assistantMessages?.[0] || null;
    results.push({
      attachmentId: attachment.id,
      threadId: attachment.threadId,
      status: summary.status,
      turnId: summary.result?.turnId || null,
      assistantMessage: summary.result?.assistantMessages?.[0] || null,
      error: summary.error || null,
      smsCode: summary.sms?.code ?? null,
    });
  }

  saveState(options.statePath, state);
  printJson({
    status: "tick_complete",
    processed: results.length,
    results,
  });
}

function cleanupCommand(options) {
  cleanupLogs(options);
  printJson({
    status: "cleanup_complete",
    logDir: options.logDir,
    summaryLogPath: options.summaryLogPath,
    eventRetentionHours: options.eventRetentionHours,
    heartbeatRetentionHours: options.heartbeatRetentionHours,
  });
}

async function daemon(options) {
  while (true) {
    await tickAttachments(options);
    await sleep(options.pollSeconds * 1000);
  }
}

function readPid(options) {
  try {
    return Number(fs.readFileSync(options.pidPath, "utf8").trim());
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isPidRunning(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemonStatus(options) {
  const pid = readPid(options);
  printJson({
    pidPath: options.pidPath,
    logPath: options.daemonLogPath,
    running: isPidRunning(pid),
    pid,
  });
}

function daemonStart(options) {
  const existingPid = readPid(options);
  if (isPidRunning(existingPid)) {
    return {
      status: "already_running",
      pid: existingPid,
      pidPath: options.pidPath,
      logPath: options.daemonLogPath,
    };
  }

  const out = fs.openSync(options.daemonLogPath, "a");
  const err = fs.openSync(options.daemonLogPath, "a");
  const child = spawn(
    process.execPath,
    [
      path.join(options.rootDir, "supervisor.mjs"),
      "daemon",
      "--state-file",
      options.statePath,
      "--log-dir",
      options.logDir,
      "--poll-seconds",
      String(options.pollSeconds),
      "--timeout-ms",
      String(options.timeoutMs),
      "--idle-timeout-ms",
      String(options.idleTimeoutMs),
    ],
    {
      cwd: options.rootDir,
      detached: true,
      stdio: ["ignore", out, err],
      env: process.env,
    },
  );
  child.unref();
  fs.writeFileSync(options.pidPath, `${child.pid}\n`);
  return {
    status: "started",
    pid: child.pid,
    pidPath: options.pidPath,
    logPath: options.daemonLogPath,
  };
}

function daemonStop(options) {
  const pid = readPid(options);
  if (!isPidRunning(pid)) {
    return {
      status: "not_running",
      pidPath: options.pidPath,
      pid,
    };
  }
  process.kill(pid, "SIGTERM");
  try {
    fs.unlinkSync(options.pidPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return {
    status: "stopped",
    pid,
    pidPath: options.pidPath,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = buildRunOptions(args);
  validateRunOptions(options);

  switch (options.command) {
    case "run-once":
      validateSingleRunOptions(options);
      await runOnce(options);
      return;
    case "loop":
      validateSingleRunOptions(options);
      await loopSingleThread(options);
      return;
    case "current-thread":
      printCurrentThread(options);
      return;
    case "attach":
      if (!options.threadId) {
        throw new Error("Missing --thread-id");
      }
      await attachThread(options, options.threadId);
      return;
    case "attach-current": {
      const inferred = inferCurrentThread(options);
      await attachThread(options, inferred.selected.id);
      return;
    }
    case "list":
      printAttachments(options);
      return;
    case "detach":
      if (!options.attachmentId && !options.threadId) {
        throw new Error("Use --id or --thread-id with detach");
      }
      detachAttachment(options);
      return;
    case "tick":
      await tickAttachments(options);
      return;
    case "cleanup":
      cleanupCommand(options);
      return;
    case "daemon":
      await daemon(options);
      return;
    case "daemon-start":
      printJson(daemonStart(options));
      return;
    case "daemon-status":
      daemonStatus(options);
      return;
    case "daemon-stop":
      printJson(daemonStop(options));
      return;
    default:
      throw new Error(`Unsupported command: ${options.command}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
