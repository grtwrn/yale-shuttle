import type { TransitNetwork } from "./TransitNetwork.js";

/**
 * Mutable holder for the active TransitNetwork.
 *
 * The static topology (stops, routes, edges, walking transfers) refreshes
 * every ~6 h from upstream, and we want consumers — the HTTP server, the
 * trip planner — to see the new graph without having to be re-wired.
 * They hold a NetworkRef and call `.get()` per request; the collector
 * calls `.replace()` after each refresh. One pointer swap, no locking
 * required since JS is single-threaded per event loop.
 */
export class NetworkRef {
  private current: TransitNetwork;

  constructor(initial: TransitNetwork) {
    this.current = initial;
  }

  get(): TransitNetwork {
    return this.current;
  }

  replace(next: TransitNetwork): void {
    this.current = next;
  }
}
