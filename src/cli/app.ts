/**
 * CLI handler for `verdikt app` command.
 *
 * Serves a web-based UI for configuring and running tasks.
 */

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { readActionApprovalState } from "../approval/actionStore.js";
import { appendRunEvent, readRunEvents } from "../trace/events.js";
import type { ApprovalRequest, RunAgentPhase, RunPhaseUpdate, TaskSpec } from "../types.js";
import { coerceUsageSummary, formatCost } from "../usage.js";
import { validateTaskSpec } from "../validation.js";
import { readVerdictResult } from "../verdict/store.js";
import { forkRunFromIteration, rewindRunToIteration } from "./checkpointActions.js";
import { runDoctorChecks } from "./doctor.js";
import {
  type LocalServerHandle,
  dataContentType,
  injectDefaultDataDir,
  isAllowedDataFile,
  isPathInside,
  isValidRunId,
  listenLocal,
} from "./localServer.js";
import { addRunNote } from "./note.js";
import { getFlag, hasFlag, parseArgs } from "./parseArgs.js";
import { readPatchReview } from "./patchReview.js";
import {
  createPersistCoalescer,
  emptyPersistedRunQueue,
  loadPersistedRunQueue,
  recoverPersistedRunQueue,
  savePersistedRunQueue,
  upsertPersistedRun,
} from "./persistentQueue.js";
import { checkRepoPreflight } from "./repoPreflight.js";
import { type RunSummaryForAdvice, buildRunAdvice } from "./runAdvice.js";
import {
  buildRunStats,
  listSavedRuns,
  readTaskForSavedRun,
  updateRunMetadata,
} from "./runStore.js";

// Security: Maximum request body size (10MB)
const MAX_BODY_SIZE = 10 * 1024 * 1024;
const MAX_LIVE_LOG_CHARS = 200_000;
const MAX_PERSISTED_LOG_CHARS = 8_192;
const DEFAULT_TERMINAL_RUN_TTL_MS = 30 * 60 * 1000;
export const APP_SESSION_HEADER = "x-verdikt-session";

export interface AppServerHandle extends LocalServerHandle {
  sessionToken: string;
  sessionHeaders: Readonly<Record<string, string>>;
}

type LiveRunTask = {
  process: Promise<void>;
  controller: AbortController;
  log: string;
  status:
    | "queued"
    | "running"
    | "waiting_approval"
    | "resumable"
    | "cancelling"
    | "cancelled"
    | "completed"
    | "error";
  result: unknown;
  task: TaskSpec;
  mode: "new" | "resume";
  queuedAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  ownerPid?: number;
  recoveryReason?: string;
  approvalRequest?: ApprovalRequest;
  resumeRunDir?: string;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  stall?: {
    phase: RunAgentPhase;
    elapsedMs: number;
    outputIdleMs: number;
    detectedAt: string;
    iteration?: number;
    stageId?: string;
  };
  currentPhase?: RunAgentPhase;
};

type LiveRunStall = NonNullable<LiveRunTask["stall"]>;

type IterationDigest = {
  index: number;
  stageId?: string | null;
  stageIteration?: number;
  judge?: { passed?: boolean; failedChecks?: string[]; summary?: string };
  verifier?: { done?: boolean; problems?: string[]; nextInstruction?: string };
  verifierVerdict?: { done?: boolean; problems?: string[]; nextInstruction?: string };
  patch?: { filesChanged?: string[] };
  changedFiles?: string[];
  costUsd?: number;
  usageStatus?: string;
};

type RunPhaseSnapshot = {
  phase: string;
  title: string;
  detail: string;
  confidence: "low" | "medium" | "high";
  lanes: {
    executor: string;
    judge: string;
    verifier: string;
  };
  latestIteration: IterationDigest | null;
};

type RunQueueState = {
  activeRunId: string | null;
  queue: string[];
  stopped: boolean;
};

type PersistQueue = () => Promise<void>;

export async function handleApp(args: string[]): Promise<void> {
  const options = parseAppArgs(args);

  const app = await startAppServer({
    port: options.port,
    logStartup: true,
    browserAutoOpen: options.openBrowser,
  });
  if (options.openBrowser) {
    await openBrowser(app.url);
  }
}

export function parseAppArgs(args: string[]): { port: number; openBrowser: boolean } {
  const parsed = parseArgs(args, {
    optional: ["port", "open"],
    boolean: ["no-open"],
    positional: { max: 0 },
  });
  const portArg = getFlag(parsed, "port", "3849");
  if (!/^\d+$/.test(portArg)) {
    throw new Error(`Invalid port number: ${portArg}`);
  }
  const port = Number(portArg);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port number: ${portArg}`);
  }

  const openArg = getFlag(parsed, "open", "true");
  if (openArg !== "true" && openArg !== "false") {
    throw new Error('Flag --open must be either "true" or "false".');
  }
  const openBrowser = !hasFlag(parsed, "no-open") && openArg !== "false";
  return { port, openBrowser };
}

export async function startAppServer(options: {
  port: number;
  host?: string;
  logStartup?: boolean;
  browserAutoOpen?: boolean;
  terminalRunTtlMs?: number;
  doctorChecks?: typeof runDoctorChecks;
}): Promise<AppServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const terminalRunTtlMs = options.terminalRunTtlMs ?? DEFAULT_TERMINAL_RUN_TTL_MS;
  const { createServer } = await import("node:http");
  const sessionToken = randomBytes(32).toString("base64url");
  let trustedAuthority = formatAuthority(host, options.port);
  const { readFile: readFileFs } = await import("node:fs/promises");

  const config = (await import("../config.js")).getConfig();
  const stateDir = resolve(config.stateDir);

  // Track running tasks
  const runningTasks = new Map<string, LiveRunTask>();
  const queueState: RunQueueState = { activeRunId: null, queue: [], stopped: false };

  const recoveredQueue = await recoverPersistedRunQueue(
    stateDir,
    await loadPersistedRunQueue(stateDir),
  );
  await savePersistedRunQueue(stateDir, recoveredQueue);
  for (const item of Object.values(recoveredQueue.items)) {
    if (!["queued", "running", "waiting_approval", "resumable"].includes(item.status)) continue;
    runningTasks.set(item.runId, {
      process: Promise.resolve(),
      controller: new AbortController(),
      log:
        item.lastLog ??
        `${item.status} run ${item.runId}\nTask: ${item.task.goal}\nRepo: ${item.task.repoPath}\n\n`,
      status: item.status,
      result: null,
      task: item.task,
      mode: item.mode,
      queuedAt: item.queuedAt,
      startedAt: item.startedAt,
      heartbeatAt: item.heartbeatAt,
      ownerPid: item.ownerPid,
      resumeRunDir: item.resumeRunDir,
      recoveryReason: item.recoveryReason,
      approvalRequest: item.approvalRequest,
      currentPhase: isRunAgentPhase(item.currentAction) ? item.currentAction : undefined,
    });
  }
  queueState.queue = recoveredQueue.order.filter(
    (runId) => runningTasks.get(runId)?.status === "queued",
  );
  queueState.activeRunId =
    recoveredQueue.activeRunId && runningTasks.get(recoveredQueue.activeRunId)?.status === "running"
      ? recoveredQueue.activeRunId
      : null;

  const requestPersist: PersistQueue = createPersistCoalescer(() =>
    savePersistedRunQueue(stateDir, buildPersistedQueueSnapshot(runningTasks, queueState)),
  );

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${host}:${options.port}`);

    // Security: bind every browser request to the actual loopback listener, not caller-supplied Host.
    const expectedOrigin = `http://${trustedAuthority}`;
    const trustedOrigin = getTrustedOrigin(req.headers.origin, expectedOrigin);
    if (!isLocalAddress(req.socket.remoteAddress) || req.headers.host !== trustedAuthority) {
      denyRequest(res, "Untrusted request host");
      return;
    }
    if (typeof trustedOrigin === "string") {
      res.setHeader("Access-Control-Allow-Origin", trustedOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${APP_SESSION_HEADER}`);
      res.setHeader("Vary", "Origin");
    }

    if (req.method === "OPTIONS") {
      if (trustedOrigin === null) {
        denyRequest(res, "Untrusted request origin");
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (isStateChangingMethod(req.method)) {
      if (trustedOrigin === null) {
        denyRequest(res, "Untrusted request origin");
        return;
      }
      if (!matchesSessionToken(req.headers[APP_SESSION_HEADER], sessionToken)) {
        denyRequest(res, "Invalid workbench session");
        return;
      }
    }

    if (url.pathname === "/api/v1/capabilities" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          version: 1,
          features: [
            "durable-timeline",
            "exact-action-approval",
            "queued-notes",
            "checkpoint-rewind",
            "checkpoint-fork",
            "planning-phase",
            "lifecycle-hooks",
            "usage-completeness",
            "run-search",
            "workspace-prewarm",
          ],
        }),
      );
      return;
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Serve the main app UI
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const htmlPath = resolve(import.meta.dirname, "../../apps/ui/app.html");
      const html = await readFileFs(htmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(injectAppDefaults(html, sessionToken));
      return;
    }

    // Serve other UI files
    if (url.pathname.startsWith("/view/")) {
      const id = url.pathname.replace("/view/", "");

      // Security: Validate runId format
      if (!isValidRunId(id)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid run ID");
        return;
      }

      const itemDir = join(stateDir, id);

      // Security: Validate path is within stateDir
      if (!isPathInside(stateDir, itemDir)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Access denied");
        return;
      }

      const isBenchmark = existsSync(join(itemDir, "benchmark.json"));
      const htmlPath = isBenchmark
        ? resolve(import.meta.dirname, "../../apps/ui/benchmark.html")
        : resolve(import.meta.dirname, "../../apps/ui/index.html");
      const html = await readFileFs(htmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        injectDefaultDataDir(
          html,
          `/data/${encodeURIComponent(id)}`,
          `/api/verdict/${encodeURIComponent(id)}`,
        ),
      );
      return;
    }

    if (url.pathname.startsWith("/data/")) {
      const parts = url.pathname.replace(/^\/data\//, "").split("/");
      const id = decodeURIComponent(parts.shift() ?? "");
      const fileName = parts.join("/");

      if (!isValidRunId(id) || !isAllowedDataFile(fileName)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid data path");
        return;
      }

      const filePath = join(stateDir, id, fileName);
      if (!isPathInside(stateDir, filePath)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Access denied");
        return;
      }

      try {
        const content = await readFileFs(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": dataContentType(fileName) });
        res.end(content);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
      return;
    }

    // API: Workbench list of live, queued, saved, and resumable runs
    if (url.pathname === "/api/runs" && req.method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase();
      const savedAll = (await listSavedRuns(stateDir)).filter((run) => matchesRunQuery(run, query));
      const live = (
        await Promise.all(
          [...runningTasks.entries()].map(async ([runId, task]) => {
            const item = liveTaskListItem(runId, task, queueState);
            if (task.status === "running" || task.status === "cancelling") {
              const pending = (await readActionApprovalState(join(stateDir, runId))).pending;
              if (pending) {
                item.status = "waiting_approval";
                item.approvalRequest = actionApprovalRequest(pending);
              }
            }
            return item;
          }),
        )
      ).filter((run) => matchesRunQuery(run, query));
      const liveIds = new Set(live.map((run) => run.runId));
      const saved = savedAll.filter((run) => !liveIds.has(run.runId));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          activeRunId: queueState.activeRunId,
          queuedRunIds: queueState.queue,
          live,
          saved,
        }),
      );
      return;
    }

    // API: Canonical, versioned verdict for a saved run.
    if (url.pathname.startsWith("/api/verdict/") && req.method === "GET") {
      const runId = url.pathname.slice("/api/verdict/".length);
      if (!isValidRunId(runId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid run ID" }));
        return;
      }

      const runDir = resolve(stateDir, runId);
      if (!isPathInside(stateDir, runDir)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Access denied" }));
        return;
      }

      const verdict = await readVerdictResult(runDir);
      if (verdict.status === "ok") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(verdict.verdict));
        return;
      }
      if (verdict.status === "missing") {
        const legacy = existsSync(join(runDir, "summary.json"));
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: legacy ? "Verdict result is not available for this legacy run" : "Run not found",
            legacy,
          }),
        );
        return;
      }
      if (verdict.status === "unsupported") {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `Unsupported verdict version: ${String(verdict.version)}`,
          }),
        );
        return;
      }
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: verdict.error }));
      return;
    }

    // API: Environment preflight for first-run onboarding
    if (url.pathname === "/api/doctor" && req.method === "GET") {
      const report = await (options.doctorChecks ?? runDoctorChecks)();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(report));
      return;
    }

    // API: Project-level run statistics for long-term workbench usage
    if (url.pathname === "/api/stats" && req.method === "GET") {
      const stats = await buildRunStats(stateDir);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stats));
      return;
    }

    // API: Load a saved task into the form so failed runs can be edited before rerun
    if (url.pathname.startsWith("/api/task/") && req.method === "GET") {
      const runId = url.pathname.replace("/api/task/", "");
      const task = await readTaskForSavedRun(stateDir, runId);
      if (!task) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Saved task is not available for this run." }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ task }));
      return;
    }

    // API: Save run metadata such as pin/archive/tags/notes
    if (
      url.pathname.startsWith("/api/run/") &&
      url.pathname.endsWith("/metadata") &&
      req.method === "POST"
    ) {
      const runId = url.pathname.replace("/api/run/", "").replace("/metadata", "");
      if (!isValidRunId(runId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid run ID" }));
        return;
      }

      const metadataPatch = await readJsonBody(req, res);
      if (metadataPatch === null) return;

      const metadata = await updateRunMetadata(stateDir, runId, metadataPatch);
      if (!metadata) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Run not found" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, metadata }));
      return;
    }

    // API: Read patch review data for a passed run
    if (url.pathname.startsWith("/api/patch/") && req.method === "GET") {
      const runId = url.pathname.replace("/api/patch/", "");
      if (!isValidRunId(runId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid run ID" }));
        return;
      }
      const review = await readPatchReview(stateDir, runId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(review));
      return;
    }

    // API: Start a run
    if (url.pathname === "/api/run" && req.method === "POST") {
      let body = "";
      let bodySize = 0;

      try {
        for await (const chunk of req) {
          bodySize += chunk.length;
          // Security: Limit request body size
          if (bodySize > MAX_BODY_SIZE) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Request body too large" }));
            return;
          }
          body += chunk;
        }
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to read request body" }));
        return;
      }

      try {
        const parsedTask: unknown = JSON.parse(body);
        if (!isRecord(parsedTask)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid task request body" }));
          return;
        }

        const task = parsedTask as unknown as TaskSpec;

        // Validate
        if (
          typeof task.repoPath !== "string" ||
          task.repoPath.trim() === "" ||
          typeof task.goal !== "string" ||
          task.goal.trim() === ""
        ) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "repoPath and goal are required" }));
          return;
        }

        // Security: Validate repoPath exists and is accessible
        if (!existsSync(task.repoPath)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "repoPath does not exist" }));
          return;
        }

        // Resolve relative path
        if (!task.repoPath.startsWith("/") && !task.repoPath.match(/^[A-Z]:\\/i)) {
          task.repoPath = resolve(task.repoPath);
        }

        // Apply defaults
        task.maxIterations = task.maxIterations ?? 5;
        task.maxBudgetUsd = task.maxBudgetUsd ?? 5;
        task.runSource = task.runSource ?? "user";

        const validation = validateTaskSpec(task, "web app request");
        if (!validation.valid) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Task validation failed",
              details: validation.errors,
              warnings: validation.warnings,
            }),
          );
          return;
        }

        // Fail fast on dirty repositories: apply-side safety would refuse the
        // final patch anyway, so reject before any budget is spent.
        const preflight = await checkRepoPreflight(task.repoPath, task.allowDirtyRepo === true);
        if (!preflight.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "目标仓库有未提交的改动，任务未开始。",
              details: [{ field: "repoPath", message: preflight.message, fix: preflight.fix }],
            }),
          );
          return;
        }

        // Generate run ID
        const { createRunId } = await import("../trace/recorder.js");
        const runId = createRunId();
        const queuePosition = await enqueueRun({
          runningTasks,
          queueState,
          stateDir,
          terminalRunTtlMs,
          persist: requestPersist,
          runId,
          task,
          mode: "new",
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ runId, status: "queued", queuePosition }));
      } catch (err) {
        if (err instanceof SyntaxError) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON request body" }));
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      }
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/note/")) {
      const runId = url.pathname.slice("/api/note/".length);
      const body = await readJsonBody(req, res);
      if (body === null) return;
      try {
        const note = await addRunNote(runId, typeof body.text === "string" ? body.text : "", "web");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ runId, note }));
      } catch (error) {
        res.writeHead(statusForRunActionError(error), { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/rewind/")) {
      const runId = url.pathname.slice("/api/rewind/".length);
      const liveTask = runningTasks.get(runId);
      if (liveTask?.status === "running" || liveTask?.status === "cancelling") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Stop the active run before rewinding it." }));
        return;
      }
      const iterationNumber = parseRequiredIteration(url.searchParams.get("iteration"));
      if (iterationNumber === null) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "iteration must be a whole number between 1 and 10000" }));
        return;
      }
      const iteration = iterationNumber - 1;
      try {
        const result = await rewindRunToIteration(runId, iteration);
        const { loadRunState } = await import("../trace/recorder.js");
        const state = await loadRunState(result.runDir);
        if (!state) throw new Error("Rewound run is not resumable");
        queueState.queue = queueState.queue.filter((id) => id !== runId);
        const queuePosition = await enqueueRun({
          runningTasks,
          queueState,
          stateDir,
          terminalRunTtlMs,
          persist: requestPersist,
          runId,
          task: state.task,
          mode: "resume",
          resumeRunDir: result.runDir,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...result, status: "queued", queuePosition }));
      } catch (error) {
        res.writeHead(statusForRunActionError(error), { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/fork/")) {
      const sourceRunId = url.pathname.slice("/api/fork/".length);
      const iterationNumber = parseRequiredIteration(url.searchParams.get("iteration"));
      if (iterationNumber === null) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "iteration must be a whole number between 1 and 10000" }));
        return;
      }
      const iteration = iterationNumber - 1;
      const requestedRunId = url.searchParams.get("runId") ?? undefined;
      try {
        const result = await forkRunFromIteration(sourceRunId, iteration, requestedRunId);
        const { loadRunState } = await import("../trace/recorder.js");
        const state = await loadRunState(result.runDir);
        if (!state) throw new Error("Forked run is not resumable");
        const queuePosition = await enqueueRun({
          runningTasks,
          queueState,
          stateDir,
          terminalRunTtlMs,
          persist: requestPersist,
          runId: result.runId,
          task: state.task,
          mode: "resume",
          resumeRunDir: result.runDir,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...result, status: "queued", queuePosition }));
      } catch (error) {
        res.writeHead(statusForRunActionError(error), { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    // API: Approve or reject a waiting high-risk run and continue it safely
    if (
      req.method === "POST" &&
      (url.pathname.startsWith("/api/approve/") || url.pathname.startsWith("/api/reject/"))
    ) {
      const decision = url.pathname.startsWith("/api/approve/") ? "approve" : "reject";
      const prefix = decision === "approve" ? "/api/approve/" : "/api/reject/";
      const runId = url.pathname.slice(prefix.length);
      if (!isValidRunId(runId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid run ID" }));
        return;
      }

      try {
        const liveTask = runningTasks.get(runId);
        const pendingAction = liveTask
          ? (await readActionApprovalState(join(stateDir, runId))).pending
          : undefined;
        const isLiveExactAction = Boolean(
          liveTask && pendingAction && ["running", "cancelling"].includes(liveTask.status),
        );
        if (
          liveTask &&
          !isLiveExactAction &&
          liveTask.status !== "waiting_approval" &&
          liveTask.status !== "resumable"
        ) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Run is not waiting for a decision." }));
          return;
        }
        const { decideRunApproval } = await import("./approval.js");
        const saved = await decideRunApproval(
          runId,
          decision,
          url.searchParams.get("note") ?? undefined,
          url.searchParams.get("scope") === "run" ? "run" : "once",
        );
        if (liveTask && isLiveExactAction && saved.kind === "action") {
          if (decision === "approve") {
            runningTasks.set(runId, {
              ...liveTask,
              approvalRequest: undefined,
              stall: undefined,
              log: `${liveTask.log}\nExact action approved. The current run may continue.\n`,
            });
            await requestPersist();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ runId, decision, status: "running", continued: true }));
            return;
          }
          liveTask.controller.abort("approval_rejected");
          runningTasks.set(runId, {
            ...liveTask,
            status: "cancelling",
            approvalRequest: undefined,
            log: `${liveTask.log}\nExact action rejected. Stopping the current run safely.\n`,
          });
          await requestPersist();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ runId, decision, status: "cancelling" }));
          return;
        }
        let queuePosition: number;
        if (liveTask) {
          if (liveTask.cleanupTimer) clearTimeout(liveTask.cleanupTimer);
          if (liveTask.heartbeatTimer) clearInterval(liveTask.heartbeatTimer);
          runningTasks.set(runId, {
            ...liveTask,
            process: Promise.resolve(),
            controller: new AbortController(),
            status: "queued",
            result: null,
            mode: "resume",
            resumeRunDir: saved.runDir,
            approvalRequest: undefined,
            recoveryReason:
              decision === "approve"
                ? "Approved by user; queued to continue"
                : "Rejected by user; queued for safe shutdown",
            log: `${liveTask.log}\n${decision === "approve" ? "Approved" : "Rejected"} by user. Continuing saved run...\n`,
          });
          if (!queueState.queue.includes(runId)) queueState.queue.push(runId);
          queuePosition = queueState.queue.findIndex((id) => id === runId) + 1;
          await requestPersist();
          void pumpRunQueue(runningTasks, queueState, stateDir, terminalRunTtlMs, requestPersist);
        } else {
          const { loadRunState } = await import("../trace/recorder.js");
          const state = await loadRunState(saved.runDir);
          if (!state) throw new Error("Run is not resumable.");
          queuePosition = await enqueueRun({
            runningTasks,
            queueState,
            stateDir,
            terminalRunTtlMs,
            persist: requestPersist,
            runId,
            task: state.task,
            mode: "resume",
            resumeRunDir: saved.runDir,
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ runId, decision, status: "queued", queuePosition }));
      } catch (err) {
        res.writeHead(statusForRunActionError(err), { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // API: Verify a saved run's evidence manifest
    if (
      req.method === "GET" &&
      url.pathname.startsWith("/api/evidence/") &&
      url.pathname.endsWith("/verify")
    ) {
      const runId = url.pathname.slice("/api/evidence/".length, -"/verify".length);
      if (!isValidRunId(runId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid run ID" }));
        return;
      }
      try {
        const { verifyRunEvidence } = await import("./evidence.js");
        const verification = await verifyRunEvidence(runId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(verification));
      } catch (err) {
        res.writeHead(statusForRunActionError(err), { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // API: Resume a saved interrupted run
    if (url.pathname.startsWith("/api/resume/") && req.method === "POST") {
      const runId = url.pathname.replace("/api/resume/", "");

      if (!isValidRunId(runId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid run ID" }));
        return;
      }
      if (runningTasks.has(runId)) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Run is already live in the workbench." }));
        return;
      }

      const runDir = join(stateDir, runId);
      if (!isPathInside(stateDir, runDir)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Access denied" }));
        return;
      }

      const { loadRunState } = await import("../trace/recorder.js");
      const state = await loadRunState(runDir);
      if (!state) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Run is not resumable." }));
        return;
      }

      const queuePosition = await enqueueRun({
        runningTasks,
        queueState,
        stateDir,
        terminalRunTtlMs,
        persist: requestPersist,
        runId,
        task: state.task,
        mode: "resume",
        resumeRunDir: runDir,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ runId, status: "queued", queuePosition }));
      return;
    }

    // API: Retry a saved run with the same task as a fresh run
    if (url.pathname.startsWith("/api/retry/") && req.method === "POST") {
      const sourceRunId = url.pathname.replace("/api/retry/", "");
      if (!isValidRunId(sourceRunId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid run ID" }));
        return;
      }

      const task = await readTaskForRun(stateDir, sourceRunId);
      if (!task) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Saved task is not available for this run." }));
        return;
      }

      const retryPreflight = await checkRepoPreflight(task.repoPath, task.allowDirtyRepo === true);
      if (!retryPreflight.ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "目标仓库有未提交的改动，任务未开始。",
            details: [
              { field: "repoPath", message: retryPreflight.message, fix: retryPreflight.fix },
            ],
          }),
        );
        return;
      }

      const { createRunId } = await import("../trace/recorder.js");
      const runId = createRunId();
      const queuePosition = await enqueueRun({
        runningTasks,
        queueState,
        stateDir,
        terminalRunTtlMs,
        persist: requestPersist,
        runId,
        task,
        mode: "new",
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ runId, status: "queued", queuePosition }));
      return;
    }

    // API: Cancel a live run
    if (url.pathname.startsWith("/api/cancel/") && req.method === "POST") {
      const runId = url.pathname.replace("/api/cancel/", "");

      if (!isValidRunId(runId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid run ID" }));
        return;
      }

      const task = runningTasks.get(runId);
      if (!task) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Run not found" }));
        return;
      }

      if (task.status === "queued") {
        queueState.queue = queueState.queue.filter((id) => id !== runId);
        runningTasks.set(runId, {
          ...task,
          status: "cancelled",
          log: `${task.log}\nQueued run ${runId} was cancelled before start.\n`,
          result: cancelledResult(runId),
        });
        await requestPersist();
        scheduleTerminalTaskCleanup(runningTasks, runId, terminalRunTtlMs, requestPersist);
      } else if (task.status === "running") {
        const runDir = join(stateDir, runId);
        if (existsSync(runDir)) {
          await appendRunEvent(runDir, {
            type: "run_cancel_requested",
            runId,
            data: {
              phase: task.currentPhase,
              runSource: task.task.runSource ?? "unknown",
            },
          });
        }
        task.controller.abort("user_cancel");
        runningTasks.set(runId, {
          ...task,
          status: "cancelling",
          log: `${task.log}\nCancelling run ${runId}...\n`,
        });
        await requestPersist();
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, status: runningTasks.get(runId)?.status }));
      return;
    }

    // API: Get run status
    if (url.pathname.startsWith("/api/events/") && req.method === "GET") {
      const runId = url.pathname.replace("/api/events/", "");
      const runDir = resolve(stateDir, runId);
      if (!isValidRunId(runId) || !isPathInside(stateDir, runDir)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid run ID" }));
        return;
      }
      if (!existsSync(runDir)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Run not found" }));
        return;
      }
      const after = parseBoundedInteger(
        url.searchParams.get("after"),
        0,
        0,
        Number.MAX_SAFE_INTEGER,
      );
      const limit = parseBoundedInteger(url.searchParams.get("limit"), 200, 1, 1000);
      const events = await readRunEvents(runDir, { after, limit });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ runId, events, nextAfter: events.at(-1)?.sequence ?? after }));
      return;
    }

    if (url.pathname.startsWith("/api/run/") && req.method === "GET") {
      const runId = url.pathname.replace("/api/run/", "");

      // Security: Validate runId format
      if (!isValidRunId(runId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid run ID" }));
        return;
      }

      const task = runningTasks.get(runId);

      if (!task) {
        // Check if it's a completed run on disk
        const summaryPath = join(stateDir, runId, "summary.json");

        // Security: Validate path is within stateDir
        if (!isPathInside(stateDir, summaryPath)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Access denied" }));
          return;
        }

        if (existsSync(summaryPath)) {
          let summary: RunSummaryForAdvice;
          try {
            summary = JSON.parse(await readFileFs(summaryPath, "utf-8"));
          } catch {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Saved run summary is unreadable" }));
            return;
          }
          const iterations = Array.isArray(summary.iterations)
            ? summary.iterations.map(toIterationDigest)
            : [];
          const savedPartial = (summary as Record<string, unknown>).partialIteration;
          if (
            isRecord(savedPartial) &&
            !iterations.some((item) => item.index === savedPartial.index)
          ) {
            iterations.push(toIterationDigest(savedPartial));
          }
          // Canonical resumability: a valid state.json (see trace/lifecycle).
          // A summary flag alone is not enough — resume needs real state.
          const { deriveRunLifecycle } = await import("../trace/lifecycle.js");
          const resumable = (await deriveRunLifecycle(join(stateDir, runId))).resumable;
          const status =
            summary.stopReason === "cancelled"
              ? "cancelled"
              : resumable
                ? "resumable"
                : "completed";
          const phase = buildCompletedPhaseSnapshot(summary, iterations);
          const usage = coerceUsageSummary(
            summary.usage ?? {
              status: summary.usageStatus,
              costUsd: summary.totalCostUsd,
            },
            typeof summary.totalCostUsd === "number" ? summary.totalCostUsd : undefined,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status,
              log: `Run ${runId} ${status}.`,
              progress: 100,
              phase,
              iterations: iterations.slice(-5),
              result: {
                passed: summary.stopReason === "passed",
                stopReason: summary.stopReason,
                iterations: summary.totalIterations,
                totalCostUsd: usage.costUsd ?? 0,
                usageStatus: usage.status,
                totalDurationMs: summary.totalDurationMs,
                applyStatus: summary.applyStatus ?? "pending",
                runId: runId,
                reviewOnly: Boolean((summary as Record<string, unknown>).reviewOnly),
                reviewReport: (summary as Record<string, unknown>).reviewReport ?? null,
                partialIteration: (summary as Record<string, unknown>).partialIteration ?? null,
                providerError: (summary as Record<string, unknown>).providerError ?? null,
                resumable,
                currentPhase: (summary as Record<string, unknown>).currentPhase ?? null,
                advice: buildRunAdvice(summary),
              },
            }),
          );
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Run not found" }));
        return;
      }

      // Read live log from iterations.jsonl
      let log = task.log;
      const iterations: IterationDigest[] = [];
      const iterPath = join(stateDir, runId, "iterations.jsonl");
      if (existsSync(iterPath)) {
        try {
          const iterContent = await readFileFs(iterPath, "utf-8");
          const lines = iterContent.trim().split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const iter = JSON.parse(line);
              iterations.push(toIterationDigest(iter));
              log += `\n── Iteration ${iter.index + 1} ──\n`;
              if (iter.judge) {
                log += `  Judges: ${iter.judge.passed ? "✅ passed" : "❌ failed"}\n`;
              }
              if (iter.verifierVerdict) {
                log += `  Verifier: done=${iter.verifierVerdict.done}, problems=${iter.verifierVerdict.problems.length}\n`;
                for (const p of iter.verifierVerdict.problems) {
                  log += `    • ${p}\n`;
                }
              }
              if (iter.usageStatus || iter.costUsd !== undefined) {
                log += `  Cost: ${formatCost({ status: iter.usageStatus === "complete" || iter.usageStatus === "partial" ? iter.usageStatus : "unknown", costUsd: iter.costUsd }, 4)}\n`;
              }
            } catch {
              // Skip invalid lines
            }
          }
        } catch {
          // Ignore read errors
        }
      }
      const livePartial =
        isRecord(task.result) && isRecord(task.result.partialIteration)
          ? task.result.partialIteration
          : null;
      if (livePartial && !iterations.some((item) => item.index === livePartial.index)) {
        iterations.push(toIterationDigest(livePartial));
      }
      const pendingAction = (await readActionApprovalState(join(stateDir, runId))).pending;
      const liveApprovalRequest = pendingAction
        ? actionApprovalRequest(pendingAction)
        : task.approvalRequest;
      const effectiveStatus =
        pendingAction && task.status === "running" ? "waiting_approval" : task.status;
      const phase = pendingAction
        ? {
            phase: "waiting_approval",
            title: "等待你的确认",
            detail: "执行中遇到一个需要明确允许的动作。",
            confidence: "high" as const,
            lanes: {
              executor: "已暂停当前动作，等待确认。",
              judge: "尚未开始验收。",
              verifier: "尚未开始审查。",
            },
            latestIteration: iterations.at(-1) ?? null,
          }
        : buildRunPhaseSnapshot(task, iterations, queueState, runId);

      const progress =
        effectiveStatus === "completed" || effectiveStatus === "cancelled"
          ? 100
          : task.status === "queued"
            ? queueProgress(runId, queueState)
            : task.status === "cancelling"
              ? 95
              : task.result
                ? 90
                : 50;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: effectiveStatus,
          log,
          progress,
          phase,
          iterations: iterations.slice(-5),
          result: task.result,
          queuePosition:
            task.status === "queued" ? queueState.queue.findIndex((id) => id === runId) + 1 : 0,
          heartbeatAt: task.heartbeatAt,
          recoveryReason: task.recoveryReason,
          approvalRequest: liveApprovalRequest,
          stall: task.stall,
          currentPhase: task.currentPhase,
          taskMode: task.task.taskMode ?? "implement",
          runSource: task.task.runSource ?? "unknown",
          startedAt: task.startedAt,
        }),
      );
      return;
    }

    // API: Apply patch
    if (url.pathname.startsWith("/api/apply/") && req.method === "POST") {
      const runId = url.pathname.replace("/api/apply/", "");

      // Security: Validate runId format
      if (!isValidRunId(runId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid run ID" }));
        return;
      }

      const liveTask = runningTasks.get(runId);
      if (
        liveTask?.status === "queued" ||
        liveTask?.status === "running" ||
        liveTask?.status === "cancelling"
      ) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Cannot apply a run before it is completed." }));
        return;
      }

      try {
        const { applyPassedRun } = await import("./apply.js");
        await applyPassedRun(runId);
        updateRunTaskApplyStatus(runningTasks, runId, "applied");
        await requestPersist();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, applyStatus: "applied" }));
      } catch (err) {
        res.writeHead(statusForRunActionError(err), { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // API: Discard run
    if (url.pathname.startsWith("/api/discard/") && req.method === "POST") {
      const runId = url.pathname.replace("/api/discard/", "");

      // Security: Validate runId format
      if (!isValidRunId(runId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid run ID" }));
        return;
      }

      const liveTask = runningTasks.get(runId);
      if (
        liveTask?.status === "queued" ||
        liveTask?.status === "running" ||
        liveTask?.status === "cancelling"
      ) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Cannot discard a run before it is completed." }));
        return;
      }

      try {
        const { discardSavedRun } = await import("./discard.js");
        await discardSavedRun(runId);
        deleteRunTask(runningTasks, runId);
        await requestPersist();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, applyStatus: "discarded" }));
      } catch (err) {
        res.writeHead(statusForRunActionError(err), { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // 404
    res.writeHead(404);
    res.end("Not found");
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    });
  });

  const handle = await listenLocal(server, { port: options.port, host });
  trustedAuthority = new URL(handle.url).host;
  const appHandle: AppServerHandle = {
    ...handle,
    sessionToken,
    sessionHeaders: Object.freeze({ [APP_SESSION_HEADER]: sessionToken }),
    close: async () => {
      if (queueState.stopped) {
        await requestPersist().catch(() => undefined);
        return;
      }
      queueState.stopped = true;
      await handle.close();

      const activeProcesses: Promise<void>[] = [];
      for (const task of runningTasks.values()) {
        if (task.cleanupTimer) clearTimeout(task.cleanupTimer);
        if (task.heartbeatTimer) clearInterval(task.heartbeatTimer);
        if (
          task.ownerPid === process.pid &&
          (task.status === "running" || task.status === "cancelling")
        ) {
          task.controller.abort("app_shutdown");
          activeProcesses.push(task.process);
        }
      }
      await requestPersist();
      await Promise.allSettled(activeProcesses);
      // Resolves only after a write that includes the final task states.
      await requestPersist();
    },
  };

  void pumpRunQueue(runningTasks, queueState, stateDir, terminalRunTtlMs, requestPersist);

  if (options.logStartup !== false) {
    const browserAutoOpen = options.browserAutoOpen ?? false;
    console.log("\nVerdikt App");
    console.log(`   ${appHandle.url}`);
    console.log(
      browserAutoOpen
        ? "\n   Opening the browser automatically. Use --no-open to disable."
        : "\n   Open the URL above in your browser.",
    );
    console.log("\n   Press Ctrl+C to stop.\n");
  }

  return appHandle;
}

export function buildBrowserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; detached: boolean } {
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url], detached: true };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url], detached: true };
  }
  return { command: "xdg-open", args: [url], detached: true };
}

export async function openBrowser(url: string): Promise<boolean> {
  const { command, args, detached } = buildBrowserOpenCommand(url);
  return new Promise<boolean>((resolveOpen) => {
    try {
      const child = spawn(command, args, {
        detached,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => resolveOpen(false));
      child.unref();
      resolveOpen(true);
    } catch {
      resolveOpen(false);
    }
  });
}

async function readJsonBody(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<Record<string, unknown> | null> {
  let body = "";
  let bodySize = 0;

  try {
    for await (const chunk of req) {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
        return null;
      }
      body += chunk;
    }
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to read request body" }));
    return null;
  }

  try {
    const parsed: unknown = body.trim() ? JSON.parse(body) : {};
    if (!isRecord(parsed)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON request body" }));
      return null;
    }
    return parsed;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON request body" }));
    return null;
  }
}

function buildRunPhaseSnapshot(
  task: LiveRunTask,
  iterations: IterationDigest[],
  queueState: RunQueueState,
  runId: string,
): RunPhaseSnapshot {
  const latest = iterations[iterations.length - 1] ?? null;

  if (task.status === "queued") {
    const queuePosition = queueState.queue.findIndex((id) => id === runId) + 1;
    return {
      phase: "queued",
      title: "排队中",
      detail: queuePosition > 0 ? `当前排队第 ${queuePosition} 位。` : "等待前一个任务结束。",
      confidence: "medium",
      lanes: {
        executor: "等待执行 agent 接手任务。",
        judge: "验收命令尚未运行。",
        verifier: "审查 agent 尚未开始。",
      },
      latestIteration: latest,
    };
  }

  if (task.status === "cancelling") {
    return {
      phase: "cancelling",
      title: "正在停止",
      detail: "已经请求停止，正在等待当前进程退出。",
      confidence: "medium",
      lanes: {
        executor: "执行 agent 正在被中断。",
        judge: "验收命令不会继续启动。",
        verifier: "审查 agent 等待停止完成。",
      },
      latestIteration: latest,
    };
  }

  // Task-level approval (risk categories / plan approval). Without this branch
  // the fallback claimed "executor running" while the badge said "waiting" —
  // a contradictory state on the trust-critical approval surface.
  if (task.status === "waiting_approval") {
    return {
      phase: "waiting_approval",
      title: "等待你的确认",
      detail: "任务在继续之前需要你先做一个决定。确认或拒绝后会自动继续。",
      confidence: "high",
      lanes: {
        executor: "执行已暂停，等待你的决定。",
        judge: "验收命令暂不会启动。",
        verifier: "审查 agent 暂不会启动。",
      },
      latestIteration: latest,
    };
  }

  if (task.status === "running" && task.stall) {
    const phase = task.stall.phase ?? task.currentPhase ?? "executor";
    return {
      phase: "stalled",
      title: `${activePhaseTitle(phase)}可能卡住了`,
      detail: `当前阶段已经 ${Math.max(1, Math.round(task.stall.outputIdleMs / 1000))} 秒没有新输出。`,
      confidence: "high",
      lanes: activePhaseLanes(phase, latest),
      latestIteration: latest,
    };
  }

  if (task.status === "running" && task.currentPhase) {
    return {
      phase: task.currentPhase,
      title: activePhaseTitle(task.currentPhase),
      detail: activePhaseDetail(task.currentPhase),
      confidence: "high",
      lanes: activePhaseLanes(task.currentPhase, latest),
      latestIteration: latest,
    };
  }

  if (task.status === "cancelled") {
    return {
      phase: "cancelled",
      title: "已停止",
      detail: "任务被手动停止，可以从记录继续或丢弃。",
      confidence: "high",
      lanes: {
        executor: "执行已停止。",
        judge: "验收未形成最终通过结论。",
        verifier: "审查未形成最终通过结论。",
      },
      latestIteration: latest,
    };
  }

  if (task.status === "completed" || task.status === "error") {
    return buildCompletedPhaseSnapshot(task.result, iterations);
  }

  if (!latest) {
    return {
      phase: "executor",
      title: "执行 agent 运行中",
      detail: "正在开始第一轮执行，等待产生验收和审查记录。",
      confidence: "medium",
      lanes: {
        executor: "正在修改隔离副本。",
        judge: "等待执行结束后运行验收命令。",
        verifier: "等待验收结果后开始审查。",
      },
      latestIteration: null,
    };
  }

  const verifier = latest.verifier ?? latest.verifierVerdict;
  const judgePassed = latest.judge?.passed === true;
  const verifierDone = verifier?.done === true;
  const nextInstruction = verifier?.nextInstruction || "等待下一轮执行 agent 处理审查意见。";

  if (judgePassed && verifierDone) {
    return {
      phase: "finalizing",
      title: "正在收尾",
      detail: "验收和审查都已经通过，正在生成最终结果。",
      confidence: "high",
      lanes: {
        executor: describeExecutorLane(latest),
        judge: "验收命令已通过。",
        verifier: "审查 agent 已确认完成。",
      },
      latestIteration: latest,
    };
  }

  return {
    phase: "review",
    title: `第 ${latest.index + 1} 轮复盘中`,
    detail: nextInstruction,
    confidence: "medium",
    lanes: {
      executor: describeExecutorLane(latest),
      judge: describeJudgeLane(latest),
      verifier: describeVerifierLane(latest),
    },
    latestIteration: latest,
  };
}

function activePhaseTitle(phase: RunAgentPhase): string {
  const titles: Record<RunAgentPhase, string> = {
    planning: "正在规划",
    reviewing: "正在只读审查代码",
    executor: "正在执行修改",
    judges: "正在运行验收",
    verifier: "正在审查验收结果",
    finalizing: "正在整理结果",
  };
  return titles[phase];
}

function activePhaseDetail(phase: RunAgentPhase): string {
  const details: Record<RunAgentPhase, string> = {
    planning: "先读取项目并形成执行方案，不会修改文件。",
    reviewing: "正在读取和分析项目，不会修改任何文件。",
    executor: "正在隔离副本中处理任务，原项目不会被直接修改。",
    judges: "正在运行你配置的验收命令。",
    verifier: "正在结合修改内容和验收结果形成结论。",
    finalizing: "已完成主要工作，正在保存结果和证据。",
  };
  return details[phase];
}

function activePhaseLanes(
  phase: RunAgentPhase,
  latest: IterationDigest | null,
): RunPhaseSnapshot["lanes"] {
  return {
    executor:
      phase === "executor"
        ? "执行 agent 正在处理隔离副本。"
        : latest
          ? describeExecutorLane(latest)
          : phase === "planning" || phase === "reviewing"
            ? "尚未修改文件。"
            : "执行阶段已经结束。",
    judge:
      phase === "judges"
        ? "验收命令正在运行。"
        : latest?.judge
          ? describeJudgeLane(latest)
          : phase === "verifier" || phase === "finalizing"
            ? "验收阶段已经结束。"
            : "等待执行阶段结束。",
    verifier:
      phase === "verifier"
        ? "审查 agent 正在结合验收结果形成结论。"
        : latest
          ? describeVerifierLane(latest)
          : phase === "finalizing"
            ? "审查阶段已经结束。"
            : "等待验收结果。",
  };
}

function buildCompletedPhaseSnapshot(
  resultOrSummary: unknown,
  iterations: IterationDigest[],
): RunPhaseSnapshot {
  const latest = iterations[iterations.length - 1] ?? null;
  const stopReason = isRecord(resultOrSummary)
    ? textValue(resultOrSummary.stopReason, textValue(resultOrSummary.reason, "unknown"))
    : "unknown";
  const passed =
    stopReason === "passed" || (isRecord(resultOrSummary) && resultOrSummary.passed === true);
  const providerError =
    isRecord(resultOrSummary) && isRecord(resultOrSummary.providerError)
      ? resultOrSummary.providerError
      : null;

  // Read-only review runs are a completed REVIEW, not a failed implementation.
  // Without this branch they rendered as "任务未通过" with a raw English reason.
  const reviewOnly = isRecord(resultOrSummary) && resultOrSummary.reviewOnly === true;
  if (reviewOnly || stopReason === "review_completed" || stopReason === "review_incomplete") {
    const report =
      isRecord(resultOrSummary) && isRecord(resultOrSummary.reviewReport)
        ? resultOrSummary.reviewReport
        : null;
    const findings = report && Array.isArray(report.findings) ? report.findings.length : 0;
    const incomplete = stopReason === "review_incomplete" || report?.verdict === "incomplete";
    return {
      phase: incomplete ? "review_incomplete" : "review_completed",
      title: incomplete
        ? "审查未完成"
        : findings > 0
          ? `审查完成：发现 ${findings} 个问题`
          : "审查完成：未发现明确问题",
      detail: textValue(
        report?.summary,
        incomplete
          ? "没有形成可用的审查结论，可以调整目标后重新运行。"
          : "查看下方审查报告，确认后可以创建修改任务。",
      ),
      confidence: "high",
      lanes: {
        executor: "只读审查，没有修改任何文件。",
        judge: "验收命令仅用于辅助审查结论。",
        verifier: "审查报告已生成。",
      },
      latestIteration: latest,
    };
  }

  if (stopReason === "provider_error") {
    const category = textValue(providerError?.category, "unknown");
    return {
      phase: "failed",
      title: providerPhaseTitle(category),
      detail: providerPhaseDetail(category),
      confidence: "high",
      lanes: {
        executor:
          "provider \u8bf7\u6c42\u672a\u5b8c\u6210\uff0c\u7b49\u5f85\u4f60\u4fee\u590d\u914d\u7f6e\u540e\u7ee7\u7eed\u3002",
        judge: "provider \u5931\u8d25\u540e\u6ca1\u6709\u542f\u52a8\u9a8c\u6536\u547d\u4ee4\u3002",
        verifier: "provider \u5931\u8d25\u540e\u6ca1\u6709\u542f\u52a8\u5ba1\u67e5 agent\u3002",
      },
      latestIteration: latest,
    };
  }

  return {
    phase: passed ? "passed" : "failed",
    title: passed ? "任务已通过" : "任务未通过",
    detail: passed ? "等待你审查并决定是否应用补丁。" : `停止原因：${stopReason}。`,
    confidence: "high",
    lanes: {
      executor: latest ? describeExecutorLane(latest) : "没有可展示的执行轮次。",
      judge: latest ? describeJudgeLane(latest) : "没有可展示的验收记录。",
      verifier: latest ? describeVerifierLane(latest) : "没有可展示的审查记录。",
    },
    latestIteration: latest,
  };
}

function providerPhaseTitle(category: string): string {
  switch (category) {
    case "insufficient_credit":
      return "Claude \u4f59\u989d\u4e0d\u8db3";
    case "authentication":
      return "Claude \u767b\u5f55\u4e0d\u53ef\u7528";
    case "rate_limited":
      return "Claude \u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41";
    case "service_unavailable":
      return "Claude \u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528";
    default:
      return "Claude provider \u65e0\u6cd5\u5b8c\u6210\u8bf7\u6c42";
  }
}

function providerPhaseDetail(category: string): string {
  switch (category) {
    case "insufficient_credit":
      return "\u8fd0\u884c\u5df2\u6682\u505c\uff0c\u8865\u5145\u4f59\u989d\u540e\u53ef\u4ee5\u7ee7\u7eed\u3002";
    case "authentication":
      return "\u8fd0\u884c\u5df2\u6682\u505c\uff0c\u91cd\u65b0\u767b\u5f55\u540e\u53ef\u4ee5\u7ee7\u7eed\u3002";
    case "rate_limited":
      return "\u8fd0\u884c\u5df2\u6682\u505c\uff0c\u7a0d\u540e\u53ef\u4ee5\u7ee7\u7eed\u3002";
    case "service_unavailable":
      return "\u8fd0\u884c\u5df2\u6682\u505c\uff0c\u7b49\u5f85 provider \u6062\u590d\u540e\u53ef\u4ee5\u7ee7\u7eed\u3002";
    default:
      return "\u68c0\u67e5 Claude \u767b\u5f55\u3001\u4f59\u989d\u548c\u6a21\u578b\u914d\u7f6e\u540e\u53ef\u4ee5\u7ee7\u7eed\u3002";
  }
}

function toIterationDigest(value: unknown): IterationDigest {
  if (!isRecord(value)) return { index: 0 };
  const verifier = isRecord(value.verifier) ? value.verifier : null;
  const verifierVerdict = isRecord(value.verifierVerdict) ? value.verifierVerdict : null;
  const judge = isRecord(value.judge) ? value.judge : null;
  const patch = isRecord(value.patch) ? value.patch : null;
  return {
    index: typeof value.index === "number" ? value.index : 0,
    stageId: typeof value.stageId === "string" ? value.stageId : null,
    stageIteration: typeof value.stageIteration === "number" ? value.stageIteration : undefined,
    judge: judge
      ? {
          passed: typeof judge.passed === "boolean" ? judge.passed : undefined,
          failedChecks: Array.isArray(judge.failedChecks)
            ? judge.failedChecks.map(String)
            : Array.isArray(judge.checks)
              ? judge.checks
                  .filter((check) => isRecord(check) && check.passed === false)
                  .map((check) => textValue(check.name, "check"))
              : undefined,
          summary: textValue(judge.summary, ""),
        }
      : undefined,
    verifier: verifier
      ? {
          done: typeof verifier.done === "boolean" ? verifier.done : undefined,
          problems: Array.isArray(verifier.problems) ? verifier.problems.map(String) : undefined,
          nextInstruction: textValue(verifier.nextInstruction, ""),
        }
      : undefined,
    verifierVerdict: verifierVerdict
      ? {
          done: typeof verifierVerdict.done === "boolean" ? verifierVerdict.done : undefined,
          problems: Array.isArray(verifierVerdict.problems)
            ? verifierVerdict.problems.map(String)
            : undefined,
          nextInstruction: textValue(verifierVerdict.nextInstruction, ""),
        }
      : undefined,
    patch: patch
      ? {
          filesChanged: Array.isArray(patch.filesChanged)
            ? patch.filesChanged.map(String)
            : undefined,
        }
      : undefined,
    changedFiles: Array.isArray(value.changedFiles) ? value.changedFiles.map(String) : undefined,
    costUsd: typeof value.costUsd === "number" ? value.costUsd : undefined,
    usageStatus: typeof value.usageStatus === "string" ? value.usageStatus : undefined,
  };
}

function describeExecutorLane(iteration: IterationDigest): string {
  const files = iteration.patch?.filesChanged ?? iteration.changedFiles ?? [];
  if (files.length === 0) return `第 ${iteration.index + 1} 轮已执行，未识别到文件改动摘要。`;
  return `第 ${iteration.index + 1} 轮改动 ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` 等 ${files.length} 个文件` : ""}。`;
}

function describeJudgeLane(iteration: IterationDigest): string {
  if (!iteration.judge) return "验收命令记录尚未写入。";
  if (iteration.judge.passed) return "验收命令已通过。";
  const failed = iteration.judge.failedChecks ?? [];
  if (failed.length > 0) return `未通过：${failed.join(", ")}。`;
  return iteration.judge.summary || "验收命令未通过。";
}

function describeVerifierLane(iteration: IterationDigest): string {
  const verifier = iteration.verifier ?? iteration.verifierVerdict;
  if (!verifier) return "审查 agent 记录尚未写入。";
  if (verifier.done) return "审查 agent 已确认完成。";
  const problems = verifier.problems ?? [];
  if (problems.length > 0) return problems.slice(0, 2).join("；");
  return verifier.nextInstruction || "审查 agent 要求继续修复。";
}

function isRunAgentPhase(value: unknown): value is RunAgentPhase {
  return ["planning", "reviewing", "executor", "judges", "verifier", "finalizing"].includes(
    String(value),
  );
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

async function enqueueRun(options: {
  runningTasks: Map<string, LiveRunTask>;
  queueState: RunQueueState;
  stateDir: string;
  terminalRunTtlMs: number;
  persist: PersistQueue;
  runId: string;
  task: TaskSpec;
  mode: "new" | "resume";
  resumeRunDir?: string;
}): Promise<number> {
  const controller = new AbortController();
  const queuedAt = new Date().toISOString();
  const runLabel = options.mode === "resume" ? "Resuming" : "Queued";
  options.runningTasks.set(options.runId, {
    process: Promise.resolve(),
    controller,
    log: `${runLabel} run ${options.runId}
Task: ${options.task.goal}
Repo: ${options.task.repoPath}

`,
    status: "queued",
    result: null,
    task: options.task,
    mode: options.mode,
    queuedAt,
    resumeRunDir: options.resumeRunDir,
  });
  options.queueState.queue.push(options.runId);
  const queuePosition = options.queueState.queue.findIndex((id) => id === options.runId) + 1;
  await options.persist();
  void pumpRunQueue(
    options.runningTasks,
    options.queueState,
    options.stateDir,
    options.terminalRunTtlMs,
    options.persist,
  );
  return queuePosition;
}

async function pumpRunQueue(
  runningTasks: Map<string, LiveRunTask>,
  queueState: RunQueueState,
  stateDir: string,
  terminalRunTtlMs: number,
  persist: PersistQueue,
): Promise<void> {
  if (queueState.stopped || queueState.activeRunId) return;

  const nextRunId = queueState.queue.shift();
  if (!nextRunId) return;

  const queuedTask = runningTasks.get(nextRunId);
  if (!queuedTask || queuedTask.status !== "queued") {
    await persist();
    await pumpRunQueue(runningTasks, queueState, stateDir, terminalRunTtlMs, persist);
    return;
  }

  queueState.activeRunId = nextRunId;
  const startedAt = new Date().toISOString();
  runningTasks.set(nextRunId, {
    ...queuedTask,
    status: "running",
    startedAt,
    heartbeatAt: startedAt,
    ownerPid: process.pid,
    log: `${queuedTask.log}Starting run ${nextRunId}...
`,
  });

  const runPromise = (async () => {
    await persist();
    startRunHeartbeat(runningTasks, nextRunId, persist);
    await runQueuedTask(nextRunId, runningTasks, stateDir, terminalRunTtlMs, persist);
  })()
    .catch(() => {
      // runQueuedTask records user-visible errors itself.
    })
    .finally(async () => {
      stopRunHeartbeat(runningTasks, nextRunId);
      if (queueState.activeRunId === nextRunId) {
        queueState.activeRunId = null;
      }
      await persist();
      await pumpRunQueue(runningTasks, queueState, stateDir, terminalRunTtlMs, persist);
    });

  const currentTask = runningTasks.get(nextRunId);
  if (currentTask) {
    runningTasks.set(nextRunId, { ...currentTask, process: runPromise });
  }
}

async function runQueuedTask(
  runId: string,
  runningTasks: Map<string, LiveRunTask>,
  stateDir: string,
  terminalRunTtlMs: number,
  persist: PersistQueue,
): Promise<void> {
  const task = runningTasks.get(runId);
  if (!task) return;

  try {
    const result =
      task.mode === "resume" && task.resumeRunDir
        ? await runResumeTask(
            task.resumeRunDir,
            task.controller.signal,
            (message) => appendRunLog(runningTasks, runId, message, persist),
            (stall) => recordRunStall(runningTasks, runId, stall, persist),
            (phase) => recordRunPhase(runningTasks, runId, phase, persist),
          )
        : await runNewTask(
            task.task,
            runId,
            task.controller.signal,
            (message) => appendRunLog(runningTasks, runId, message, persist),
            (stall) => recordRunStall(runningTasks, runId, stall, persist),
            (phase) => recordRunPhase(runningTasks, runId, phase, persist),
          );

    const currentTask = runningTasks.get(runId);
    if (!currentTask) return;

    const savedStateExists = existsSync(join(stateDir, runId, "state.json"));
    const resumable =
      result.resumable === true ||
      result.reason === "interrupted" ||
      (result.reason === "cancelled" && savedStateExists);
    const waitingApproval = result.reason === "approval_required";
    const status =
      result.reason === "cancelled"
        ? "cancelled"
        : resumable
          ? "resumable"
          : waitingApproval
            ? "waiting_approval"
            : "completed";
    const resumeRunDir = savedStateExists ? join(stateDir, runId) : currentTask.resumeRunDir;

    stopRunHeartbeat(runningTasks, runId);
    runningTasks.set(runId, {
      ...currentTask,
      status,
      mode:
        resumable || waitingApproval
          ? savedStateExists
            ? "resume"
            : currentTask.mode
          : currentTask.mode,
      resumeRunDir,
      recoveryReason: resumable
        ? result.reason === "cancelled"
          ? "\u4efb\u52a1\u5df2\u505c\u6b62\uff0c\u73b0\u573a\u548c\u5df2\u5b8c\u6210\u7ed3\u679c\u5747\u5df2\u4fdd\u7559\u3002"
          : result.reason === "provider_error"
            ? providerRecoveryReason(result.providerError)
            : "App stopped before the run completed"
        : currentTask.recoveryReason,
      currentPhase: result.currentPhase ?? currentTask.currentPhase,
      stall: undefined,
      approvalRequest: waitingApproval
        ? result.approvalRequest
          ? {
              categories: result.approvalRequest.categories,
              reason: result.approvalRequest.reason,
              stageId: result.approvalRequest.stageId,
              action: result.approvalRequest.action,
            }
          : currentTask.approvalRequest
        : undefined,
      result: {
        passed: result.reason === "passed" || result.reason === "review_completed",
        stopReason: result.reason,
        iterations: result.iterations.length,
        totalCostUsd: result.totalCostUsd,
        usageStatus: result.usageStatus ?? result.usage?.status ?? "unknown",
        totalDurationMs: result.totalDurationMs,
        applyStatus: result.applyStatus ?? "pending",
        runId: result.runId ?? runId,
        approvalRequest: result.approvalRequest,
        evidenceManifestPath: result.evidenceManifestPath,
        stageProgress: result.stageProgress,
        reviewOnly: result.reviewOnly,
        reviewReport: result.reviewReport,
        partialIteration: result.partialIteration,
        providerError: result.providerError,
        resumable,
        currentPhase: result.currentPhase,
        patch: result.patch,
        advice: buildRunAdvice({
          stopReason: result.reason,
          applyStatus: result.applyStatus ?? "pending",
          totalIterations: result.iterations.length,
          totalCostUsd: result.totalCostUsd,
          usageStatus: result.usageStatus ?? result.usage?.status ?? "unknown",
          totalDurationMs: result.totalDurationMs,
          reviewOnly: result.reviewOnly,
          reviewReport: result.reviewReport,
          providerError: result.providerError,
          iterations: result.iterations.map((iter) => ({
            judge: {
              passed: iter.judge.passed,
              failedChecks: iter.judge.checks
                .filter((check) => !check.passed)
                .map((check) => check.name),
              summary: iter.judge.passed ? "passed" : "failed",
            },
            verifier: {
              done: iter.verifierVerdict.done,
              problems: iter.verifierVerdict.problems,
              nextInstruction: iter.verifierVerdict.nextInstruction,
            },
            integrity: iter.integrity,
          })),
        }),
      },
    });
    await persist();
    if (!resumable && !waitingApproval) {
      scheduleTerminalTaskCleanup(runningTasks, runId, terminalRunTtlMs, persist);
    }
  } catch (err) {
    const existingTask = runningTasks.get(runId);
    if (!existingTask) return;

    const interrupted = existingTask.controller.signal.reason === "app_shutdown";
    const cancelled = existingTask.controller.signal.aborted && !interrupted;
    const savedStateExists = existsSync(join(stateDir, runId, "state.json"));
    stopRunHeartbeat(runningTasks, runId);
    runningTasks.set(runId, {
      ...existingTask,
      status: interrupted ? "resumable" : cancelled ? "cancelled" : "error",
      mode: (interrupted || cancelled) && savedStateExists ? "resume" : existingTask.mode,
      resumeRunDir:
        (interrupted || cancelled) && savedStateExists
          ? join(stateDir, runId)
          : existingTask.resumeRunDir,
      recoveryReason: interrupted
        ? "App stopped before the run completed"
        : existingTask.recoveryReason,
      result: interrupted
        ? interruptedResult(runId)
        : cancelled
          ? cancelledResult(runId, savedStateExists)
          : { error: err instanceof Error ? err.message : String(err), runId },
    });
    await persist();
    if (!interrupted) {
      scheduleTerminalTaskCleanup(runningTasks, runId, terminalRunTtlMs, persist);
    }
  }
}

async function runNewTask(
  task: TaskSpec,
  runId: string,
  signal: AbortSignal,
  onLog: (message: string) => void,
  onStall: (info: LiveRunStall) => void,
  onPhase: (update: RunPhaseUpdate) => void,
) {
  const { runSupervisorLoop } = await import("../loop/supervisor.js");
  return runSupervisorLoop(task, {
    runId,
    skipWorktree: false,
    skipIntegrity: false,
    autoApply: false,
    stream: false,
    signal,
    onLog,
    onStall,
    onPhase,
  });
}

async function runResumeTask(
  runDir: string,
  signal: AbortSignal,
  onLog: (message: string) => void,
  onStall: (info: LiveRunStall) => void,
  onPhase: (update: RunPhaseUpdate) => void,
) {
  const { resumeSupervisorLoop } = await import("../loop/supervisor.js");
  return resumeSupervisorLoop(runDir, {
    stream: false,
    signal,
    onLog,
    onStall,
    onPhase,
  });
}

function providerRecoveryReason(
  providerError: import("../types.js").ProviderErrorSummary | undefined,
): string {
  switch (providerError?.category) {
    case "insufficient_credit":
      return "Claude \u4f59\u989d\u4e0d\u8db3\uff0c\u8fd0\u884c\u5df2\u6682\u505c\uff1b\u8865\u5145\u4f59\u989d\u540e\u53ef\u4ee5\u7ee7\u7eed\u3002";
    case "authentication":
      return "Claude \u767b\u5f55\u72b6\u6001\u4e0d\u53ef\u7528\uff0c\u8fd0\u884c\u5df2\u6682\u505c\uff1b\u91cd\u65b0\u767b\u5f55\u540e\u53ef\u4ee5\u7ee7\u7eed\u3002";
    case "rate_limited":
      return "Claude \u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41\uff0c\u8fd0\u884c\u5df2\u6682\u505c\uff1b\u7a0d\u540e\u53ef\u4ee5\u7ee7\u7eed\u3002";
    case "service_unavailable":
      return "Claude \u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u8fd0\u884c\u5df2\u6682\u505c\uff1b\u7a0d\u540e\u53ef\u4ee5\u7ee7\u7eed\u3002";
    default:
      return "Claude provider \u672a\u80fd\u5b8c\u6210\u8bf7\u6c42\uff0c\u8fd0\u884c\u5df2\u6682\u505c\uff1b\u68c0\u67e5\u914d\u7f6e\u540e\u53ef\u4ee5\u7ee7\u7eed\u3002";
  }
}

function liveTaskListItem(runId: string, task: LiveRunTask, queueState: RunQueueState) {
  return {
    runId,
    taskId: task.task.id,
    goal: task.task.goal,
    repoPath: task.task.repoPath,
    taskMode: task.task.taskMode ?? "implement",
    runSource: task.task.runSource ?? "unknown",
    status: task.status,
    mode: task.mode,
    queuedAt: task.queuedAt,
    startedAt: task.startedAt,
    queuePosition:
      task.status === "queued" ? queueState.queue.findIndex((id) => id === runId) + 1 : 0,
    heartbeatAt: task.heartbeatAt,
    recoveryReason: task.recoveryReason,
    approvalRequest: task.approvalRequest,
    stall: task.stall,
    currentStageId:
      isRecord(task.result) &&
      isRecord(task.result.stageProgress) &&
      typeof task.result.stageProgress.currentStageId === "string"
        ? task.result.stageProgress.currentStageId
        : undefined,
    resumable:
      task.status === "resumable" || (isRecord(task.result) && task.result.resumable === true),
    result: task.result,
  };
}

function queueProgress(runId: string, queueState: RunQueueState): number {
  const index = queueState.queue.findIndex((id) => id === runId);
  if (index < 0) return 10;
  return Math.max(10, Math.min(40, 40 - index * 5));
}

function cancelledResult(runId: string, resumable = false) {
  return {
    passed: false,
    stopReason: "cancelled",
    iterations: 0,
    totalCostUsd: 0,
    usageStatus: "unknown",
    totalDurationMs: 0,
    applyStatus: "pending",
    resumable,
    runId,
    advice: buildRunAdvice({ stopReason: "cancelled", applyStatus: "pending", iterations: [] }),
  };
}

function interruptedResult(runId: string) {
  return {
    passed: false,
    stopReason: "interrupted",
    iterations: 0,
    totalCostUsd: 0,
    usageStatus: "unknown",
    totalDurationMs: 0,
    applyStatus: "pending",
    runId,
    advice: buildRunAdvice({ stopReason: "interrupted", applyStatus: "pending", iterations: [] }),
  };
}

async function readTaskForRun(stateDir: string, runId: string): Promise<TaskSpec | null> {
  const runDir = resolve(stateDir, runId);
  if (!isValidRunId(runId) || !isPathInside(stateDir, runDir)) return null;

  for (const fileName of ["task.json", "normalizedTask.json"]) {
    const taskPath = join(runDir, fileName);
    if (!existsSync(taskPath)) continue;
    try {
      return JSON.parse(await readFile(taskPath, "utf-8")) as TaskSpec;
    } catch {
      return null;
    }
  }

  const statePath = join(runDir, "state.json");
  if (existsSync(statePath)) {
    try {
      const { loadRunState } = await import("../trace/recorder.js");
      const state = await loadRunState(runDir);
      return state?.task ?? null;
    } catch {
      return null;
    }
  }

  return null;
}

function buildPersistedQueueSnapshot(
  runningTasks: Map<string, LiveRunTask>,
  queueState: RunQueueState,
) {
  const now = new Date().toISOString();
  let snapshot = emptyPersistedRunQueue(new Date());
  for (const [runId, task] of runningTasks) {
    const result = isRecord(task.result) ? task.result : undefined;
    const stageProgress =
      result && isRecord(result.stageProgress) ? result.stageProgress : undefined;
    snapshot = upsertPersistedRun(snapshot, {
      runId,
      task: task.task,
      mode: task.mode,
      status: task.status,
      queuedAt: task.queuedAt,
      updatedAt: now,
      startedAt: task.startedAt,
      heartbeatAt: task.heartbeatAt,
      ownerPid: task.ownerPid,
      resumeRunDir: task.resumeRunDir,
      currentStageId:
        stageProgress && typeof stageProgress.currentStageId === "string"
          ? stageProgress.currentStageId
          : undefined,
      currentAction: task.currentPhase ?? task.status,
      // Persist only the tail: the full in-memory log (up to 200KB per task)
      // multiplied every queue.json rewrite for recovery data nobody needs.
      lastLog:
        task.log.length > MAX_PERSISTED_LOG_CHARS
          ? task.log.slice(-MAX_PERSISTED_LOG_CHARS)
          : task.log,
      recoveryReason: task.recoveryReason,
      approvalRequest: task.approvalRequest,
      error: result && typeof result.error === "string" ? result.error : undefined,
    });
  }
  return {
    ...snapshot,
    activeRunId: queueState.activeRunId,
    order: queueState.queue.filter((runId) => runningTasks.get(runId)?.status === "queued"),
    updatedAt: now,
  };
}

function actionApprovalRequest(action: {
  signature: string;
  command: string;
  tool: string;
  categories: import("../types.js").RiskCategory[];
  reason: string;
  cwd?: string;
}): ApprovalRequest {
  return {
    categories: action.categories,
    reason: action.reason,
    action: {
      signature: action.signature,
      command: action.command,
      tool: action.tool,
      cwd: action.cwd,
    },
  };
}

function recordRunStall(
  runningTasks: Map<string, LiveRunTask>,
  runId: string,
  stall: NonNullable<LiveRunTask["stall"]>,
  persist: PersistQueue,
): void {
  const task = runningTasks.get(runId);
  if (!task) return;
  runningTasks.set(runId, { ...task, stall });
  void persist();
}

function recordRunPhase(
  runningTasks: Map<string, LiveRunTask>,
  runId: string,
  update: RunPhaseUpdate,
  persist: PersistQueue,
): void {
  const task = runningTasks.get(runId);
  if (!task) return;
  runningTasks.set(runId, {
    ...task,
    currentPhase: update.phase,
    heartbeatAt: update.updatedAt,
    stall: update.status === "stalled" ? task.stall : undefined,
  });
  void persist().catch(() => undefined);
}

function appendRunLog(
  runningTasks: Map<string, LiveRunTask>,
  runId: string,
  message: string,
  persist: PersistQueue,
): void {
  const task = runningTasks.get(runId);
  if (!task) return;

  const nextLog = `${task.log}${message.endsWith("\n") ? message : `${message}\n`}`;
  runningTasks.set(runId, {
    ...task,
    heartbeatAt: new Date().toISOString(),
    ownerPid: process.pid,
    stall: undefined,
    log:
      nextLog.length > MAX_LIVE_LOG_CHARS
        ? `... earlier log trimmed ...\n${nextLog.slice(-MAX_LIVE_LOG_CHARS)}`
        : nextLog,
  });
  void persist().catch(() => undefined);
}

function startRunHeartbeat(
  runningTasks: Map<string, LiveRunTask>,
  runId: string,
  persist: PersistQueue,
): void {
  stopRunHeartbeat(runningTasks, runId);
  const heartbeatTimer = setInterval(() => {
    const task = runningTasks.get(runId);
    if (!task || task.status !== "running") return;
    runningTasks.set(runId, {
      ...task,
      heartbeatAt: new Date().toISOString(),
      ownerPid: process.pid,
    });
    void persist().catch(() => undefined);
  }, 30_000);
  heartbeatTimer.unref?.();
  const task = runningTasks.get(runId);
  if (task) runningTasks.set(runId, { ...task, heartbeatTimer });
}

function stopRunHeartbeat(runningTasks: Map<string, LiveRunTask>, runId: string): void {
  const task = runningTasks.get(runId);
  if (!task?.heartbeatTimer) return;
  clearInterval(task.heartbeatTimer);
  const { heartbeatTimer: _heartbeatTimer, ...rest } = task;
  runningTasks.set(runId, rest);
}

function scheduleTerminalTaskCleanup(
  runningTasks: Map<string, LiveRunTask>,
  runId: string,
  ttlMs: number,
  persist: PersistQueue,
): void {
  const task = runningTasks.get(runId);
  if (!task) return;

  if (task.cleanupTimer) {
    clearTimeout(task.cleanupTimer);
  }

  const cleanupTimer = setTimeout(
    () => {
      const currentTask = runningTasks.get(runId);
      if (!currentTask) return;
      if (currentTask.status === "running" || currentTask.status === "cancelling") return;
      runningTasks.delete(runId);
      void persist().catch(() => undefined);
    },
    Math.max(0, ttlMs),
  );
  cleanupTimer.unref?.();

  runningTasks.set(runId, { ...task, cleanupTimer });
}

function deleteRunTask(runningTasks: Map<string, LiveRunTask>, runId: string): void {
  const task = runningTasks.get(runId);
  if (task?.cleanupTimer) clearTimeout(task.cleanupTimer);
  if (task?.heartbeatTimer) clearInterval(task.heartbeatTimer);
  runningTasks.delete(runId);
}

function updateRunTaskApplyStatus(
  runningTasks: Map<string, LiveRunTask>,
  runId: string,
  applyStatus: "applied" | "discarded",
): void {
  const task = runningTasks.get(runId);
  if (!task || !isRecord(task.result)) return;

  runningTasks.set(runId, {
    ...task,
    result: {
      ...task.result,
      applyStatus,
    },
  });
}

function injectAppDefaults(html: string, sessionToken: string): string {
  const demoRepoPath = resolve(process.cwd(), "examples/demo-failing-test");
  return html
    .replace("__VERDIKT_DEMO_REPO_PATH__", escapeJsString(demoRepoPath))
    .replace("__VERDIKT_SESSION_TOKEN__", escapeJsString(sessionToken));
}

function escapeJsString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function statusForRunActionError(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes("already applied") ||
    message.includes("already discarded") ||
    message.includes("stopped with reason") ||
    message.includes("revalidation_required")
  ) {
    return 409;
  }
  if (message.includes("Run not found")) {
    return 404;
  }
  return 500;
}

function parseRequiredIteration(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10000 ? parsed : null;
}

function matchesRunQuery(value: unknown, query: string): boolean {
  if (!query) return true;
  if (!isRecord(value)) return false;
  const tags = Array.isArray(value.tags) ? value.tags.join(" ") : "";
  return [value.runId, value.taskId, value.goal, value.repoPath, tags]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLocaleLowerCase().includes(query));
}

function parseBoundedInteger(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTrustedOrigin(origin: string | string[] | undefined, expectedOrigin: string) {
  if (origin === undefined) return undefined;
  if (Array.isArray(origin)) return null;

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:") return null;
    return parsed.origin === expectedOrigin ? parsed.origin : null;
  } catch {
    return null;
  }
}

function isStateChangingMethod(method: string | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function matchesSessionToken(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

function denyRequest(res: ServerResponse, error: string): void {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

function formatAuthority(host: string, port: number): string {
  const authorityHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${authorityHost}:${port}`;
}

function isLocalAddress(address: string | undefined): boolean {
  return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}
