import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { startVizServer } from "../../src/viz/server.js";
import type { VizDataProvider } from "../../src/viz/provider.js";
import type { GraphResponse, StatsResponse } from "../../src/viz/api.js";

function makeProvider(): VizDataProvider {
  const graph: GraphResponse = { nodes: [], edges: [], communities: [] };
  const stats: StatsResponse = {
    entities: 0,
    relations: 0,
    communities: 0,
    commits: 0,
    lastIndexedAt: null,
  };
  return {
    getGraph: () => graph,
    getStats: () => stats,
    getEntity: () => null,
    getCommunity: () => null,
    close: () => {},
  };
}

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => {
      s.removeListener("error", reject);
      resolve(s);
    });
  });
}

describe("startVizServer — port exhaustion", () => {
  let blockers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      blockers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    blockers = [];
  });

  it("throws a clear error when every port in the range is taken", async () => {
    // Occupy the full 10-port window the server scans (basePort..basePort+9).
    const basePort = 39_500;
    for (let p = basePort; p < basePort + 10; p++) {
      blockers.push(await listenOn(p));
    }

    await expect(
      startVizServer({ provider: makeProvider(), port: basePort, open: false }),
    ).rejects.toThrow(/No free port in range 39500\.\.39509/);
  });
});
