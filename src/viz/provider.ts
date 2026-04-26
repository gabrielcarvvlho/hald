// Tiny abstraction over the viz data source. Lets us swap the live
// SQLite store for mock fixtures without touching the HTTP server.

import type {
  CommunityDetailResponse,
  EntityDetailResponse,
  GraphResponse,
  StatsResponse,
} from "./api.js";
import {
  getCommunityDetail,
  getEntityDetail,
  getGraphData,
  getStatsData,
} from "./api.js";
import type { Store } from "../store/queries.js";

export interface VizDataProvider {
  getGraph(): GraphResponse;
  getStats(): StatsResponse;
  getEntity(id: string): EntityDetailResponse | null;
  getCommunity(id: string): CommunityDetailResponse | null;
  close(): void;
}

export function createStoreProvider(store: Store): VizDataProvider {
  return {
    getGraph: () => getGraphData(store),
    getStats: () => getStatsData(store),
    getEntity: (id: string) => getEntityDetail(store, id),
    getCommunity: (id: string) => getCommunityDetail(store, id),
    close: () => store.close(),
  };
}
