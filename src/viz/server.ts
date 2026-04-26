import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import type { GraphResponse, StatsResponse } from "./api.js";
import type { VizDataProvider } from "./provider.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// Resolve public dir. Tries two candidates so we work both from the
// compiled bundle (dist/<chunk>.js) and from the TypeScript source
// (vitest, dev). First match wins.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = (() => {
  const candidates = [
    join(__dirname, "..", "src", "viz", "public"), // when in dist/<chunk>.js
    join(__dirname, "public"), // when in src/viz/server.ts (vitest)
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return candidates[0];
})();

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(JSON.stringify(data));
}

function send404(res: ServerResponse, message = "Not found"): void {
  sendJson(res, { error: message }, 404);
}

export interface VizServerOptions {
  provider: VizDataProvider;
  port: number;
  open?: boolean;
}

export async function startVizServer(options: VizServerOptions): Promise<void> {
  const { provider, open = true } = options;

  // Pre-compute graph data and stats at startup (data is static)
  const graphData: GraphResponse = provider.getGraph();
  const statsData: StatsResponse = provider.getStats();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    try {
      // --- API routes ---
      if (pathname === "/api/graph") {
        return sendJson(res, graphData);
      }

      if (pathname === "/api/stats") {
        return sendJson(res, statsData);
      }

      const entityMatch = pathname.match(/^\/api\/entity\/(.+)$/);
      if (entityMatch) {
        const entityId = decodeURIComponent(entityMatch[1]);
        const detail = provider.getEntity(entityId);
        if (!detail) return send404(res, `Entity "${entityId}" not found`);
        return sendJson(res, detail);
      }

      const communityMatch = pathname.match(/^\/api\/community\/(.+)$/);
      if (communityMatch) {
        const communityId = decodeURIComponent(communityMatch[1]);
        const detail = provider.getCommunity(communityId);
        if (!detail) return send404(res, `Community "${communityId}" not found`);
        return sendJson(res, detail);
      }

      // --- Static files ---
      let filePath: string;
      if (pathname === "/") {
        filePath = join(PUBLIC_DIR, "index.html");
      } else if (pathname.startsWith("/assets/")) {
        filePath = join(PUBLIC_DIR, pathname.slice("/assets/".length));
      } else {
        return send404(res);
      }

      // Prevent path traversal
      if (!filePath.startsWith(PUBLIC_DIR)) {
        return send404(res);
      }

      const ext = extname(filePath);
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

      const content = await readFile(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return send404(res);
      }
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  });

  // Find available port
  let port = options.port;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        port++;
        continue;
      }
      throw err;
    }
  }

  const url = `http://localhost:${port}`;
  console.log(`\n  Hald Graph Viewer`);
  console.log(`  ${url}`);
  console.log(`  Press Ctrl+C to stop\n`);

  // Auto-open browser
  if (open) {
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} ${url}`);
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n  Shutting down...");
    server.close();
    provider.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
