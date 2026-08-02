import type { Server } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";

export interface LocalServerHandle {
  server: Server;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function isPathInside(basePath: string, targetPath: string): boolean {
  const normalBase = resolve(basePath);
  const normalTarget = resolve(targetPath);
  const relativePath = relative(normalBase, normalTarget);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function isValidRunId(runId: string): boolean {
  return /^[a-zA-Z0-9\-_]{1,64}$/.test(runId);
}

export function isAllowedDataFile(fileName: string): boolean {
  return [
    "summary.json",
    "verdict.json",
    "iterations.jsonl",
    "benchmark.json",
    "benchmark.md",
  ].includes(fileName);
}

export function dataContentType(fileName: string): string {
  if (fileName.endsWith(".json") || fileName.endsWith(".jsonl")) {
    return "application/json; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

export function injectDefaultDataDir(html: string, dataDir: string, verdictPath = ""): string {
  return html
    .replace(
      "let basePath = params.get('dir') || '';",
      `let basePath = params.get('dir') || '${dataDir}';`,
    )
    .replace(
      "let verdictPath = params.get('verdict') || '';",
      `let verdictPath = params.get('verdict') || '${verdictPath}';`,
    );
}

export async function listenLocal(
  server: Server,
  options: { port: number; host?: string },
): Promise<LocalServerHandle> {
  const host = options.host ?? "127.0.0.1";

  await listenWithPortFallback(server, options.port, host);

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : options.port;
  const url = `http://${host}:${actualPort}`;

  return {
    server,
    host,
    port: actualPort,
    url,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

async function listenWithPortFallback(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const attemptListen = (nextPort: number, canFallback: boolean) => {
      const onListening = () => {
        server.off("error", onError);
        resolveListen();
      };
      const onError = (err: Error & { code?: string }) => {
        server.off("listening", onListening);
        if (canFallback && err.code === "EADDRINUSE") {
          attemptListen(0, false);
          return;
        }
        rejectListen(err);
      };

      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(nextPort, host);
    };

    attemptListen(port, port !== 0);
  });
}
