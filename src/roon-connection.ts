/**
 * Robust Roon Core (re)connection.
 *
 * Fixes and additions on top of node-roon-api (unfoldedcircle fork):
 *
 * 1. Stale connection entries: `WSTransport.close()` only calls `onclose` if the
 *    WebSocket was ever opened. If a connection attempt fails (e.g. the Roon Core
 *    answers the SOOD discovery while it is still restarting and its WebSocket
 *    port isn't open yet), the entry in `RoonApi._sood_conns` is never removed and
 *    every later SOOD answer of this core is ignored ("already connected") until
 *    the integration is restarted.
 *    -> `onclose` is now always called exactly once.
 * 2. No connect timeout: a connection attempt to an unreachable host can hang for
 *    minutes (OS TCP timeout). -> abort after `CONNECT_TIMEOUT_MS`.
 * 3. Reconnect only via SOOD (UDP multicast/broadcast), which is unreliable over
 *    WiFi. -> `RoonReconnector` additionally connects directly to the last known
 *    core address with increasing delays (2 s, 5 s, 10 s, 20 s, 30 s, 60 s, ...),
 *    and immediately after the Remote wakes up.
 * 4. Safety net: entries in `_sood_conns` whose transport is closed are removed
 *    before each reconnect attempt.
 * 5. SOOD dead after standby: `Sood.stop()` clears the 5 s network-interface timer
 *    but keeps the handle, so the next `start()` (Remote woke up) never creates it
 *    again. Interfaces are then never re-scanned - if WiFi wasn't fully up at
 *    wake-up, discovery stays broken. -> reset the handle in `stop_discovery()`.
 * 6. Race: `start_discovery()` creates its scan interval 200 ms later. A
 *    `stop_discovery()` within these 200 ms (Remote wakes up and sleeps again)
 *    can't clear it; the next `start_discovery()` then sees the interval and
 *    returns early - discovery stays stopped. -> clear such a late interval.
 *    Note: node-roon-api (re)assigns start/stop_discovery on the prototype in its
 *    constructor, so this one is patched per instance (`fixRoonInstance`, done by
 *    the RoonReconnector constructor).
 * 7. Crash on wake-up: SOOD joins the multicast group in a socket callback without
 *    error handling. If the WiFi interface isn't fully up yet (Remote just woke up),
 *    `addMembership` throws ENODEV/EADDRNOTAVAIL and the whole integration process
 *    crashes. -> the error is caught, the socket closed, and the next interface scan
 *    (every 5 s) creates it again.
 *
 * @copyright (c) 2026 by Unfolded Circle ApS.
 * @license Mozilla Public License Version 2.0, see LICENSE for more details.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import dgram from "node:dgram";
import { createRequire } from "module";
import type RoonApi from "node-roon-api";
import type { Core } from "node-roon-api";
import log from "./loggers.js";

const require = createRequire(import.meta.url);

export const ROON_SERVICE_ID = "00720724-5143-4a9b-abac-0e50cba674bb";
export const CONNECT_TIMEOUT_MS = 10_000;
/** Delays in seconds between direct reconnect attempts; the last value repeats. */
export const RECONNECT_DELAYS = [2, 5, 10, 20, 30, 60];

const LAST_CORE_KEY = "last_core";

let fixesApplied = false;

/**
 * Patch node-roon-api (prototype level, idempotent). Call once at startup.
 *
 * @param roonApiClass the RoonApi class (default export of node-roon-api)
 * @param connectTimeoutMs timeout for opening the WebSocket to the core
 */
export function applyRoonApiFixes(roonApiClass: any, connectTimeoutMs = CONNECT_TIMEOUT_MS): void {
  if (fixesApplied) {
    return;
  }
  fixesApplied = true;

  // --- 1. always run onclose (cleans _sood_conns), also if the socket never opened
  const WSTransport = require("node-roon-api/transport-websocket.js");
  const origClose = WSTransport.prototype.close;
  WSTransport.prototype.close = function (this: any) {
    if (!this._isonopencalled && !this._onclosecalled) {
      log.debug("Roon connection to %s:%s failed before it was opened", this.host, this.port);
      // let the original implementation call onclose()
      this._isonopencalled = true;
    }
    return origClose.call(this);
  };

  // --- 7. don't crash if a multicast group can't be joined (interface not ready yet)
  const origAddMembership = dgram.Socket.prototype.addMembership;
  dgram.Socket.prototype.addMembership = function (this: dgram.Socket, ...args: [string, string?]) {
    try {
      return origAddMembership.apply(this, args);
    } catch (e: any) {
      log.warn(
        "Could not join multicast group %s on %s: %s - retrying later",
        args[0],
        args[1] ?? "default",
        e?.code ?? e
      );
      try {
        // SOOD recreates closed sockets with its next interface scan
        this.close();
      } catch {
        // ignore
      }
    }
  };

  // --- 2. connect timeout + 4. no duplicate connections to the same core address
  const origWsConnect = roonApiClass.prototype.ws_connect;
  roonApiClass.prototype.ws_connect = function (
    this: any,
    opts: { host: string; port: number | string; onclose?: () => void }
  ) {
    const existing = findConnection(this, opts.host, opts.port);
    if (existing) {
      log.debug("Roon connection to %s:%s already exists, not opening a second one", opts.host, opts.port);
      // the caller stores the connection under its own key: clean that up, too
      if (opts.onclose) {
        (existing.__extraOnclose ??= []).push(opts.onclose);
      }
      return existing;
    }
    const moo = origWsConnect.call(this, opts);
    const transport = moo.transport;
    const timer = setTimeout(() => {
      if (!transport._isonopencalled && transport.ws) {
        log.warn("Roon connection to %s:%s timed out after %d ms", opts.host, opts.port, connectTimeoutMs);
        try {
          transport.ws.terminate?.();
        } catch {
          // ignore
        }
        transport.close();
      }
    }, connectTimeoutMs);
    const onopen = transport.onopen;
    transport.onopen = (...args: unknown[]) => {
      clearTimeout(timer);
      return onopen.apply(transport, args);
    };
    const onclose = transport.onclose;
    transport.onclose = (...args: unknown[]) => {
      clearTimeout(timer);
      const result = onclose.apply(transport, args);
      for (const cb of moo.__extraOnclose ?? []) {
        cb();
      }
      return result;
    };
    return moo;
  };
}

/**
 * Per-instance fixes (fix 5). Idempotent.
 */
export function fixRoonInstance(roon: any): void {
  if (roon.__ucFixed) {
    return;
  }
  roon.__ucFixed = true;
  roon.__discoveryStopped = false;
  const origStartDiscovery = roon.start_discovery;
  roon.start_discovery = function (this: any, ...args: unknown[]) {
    this.__discoveryStopped = false;
    return origStartDiscovery.apply(this, args);
  };
  const origStopDiscovery = roon.stop_discovery;
  roon.stop_discovery = function (this: any, ...args: unknown[]) {
    this.__discoveryStopped = true;
    const result = origStopDiscovery.apply(this, args);
    if (this._sood) {
      // fix 5: Sood.stop() cleared the timer but kept the handle: start() wouldn't recreate it
      this._sood.interface_timer = undefined;
    }
    // fix 6: the scan interval of a start_discovery() < 200 ms ago is created after this stop
    setTimeout(() => {
      if (this.__discoveryStopped && this.scanIntervalId) {
        log.debug("Clearing Roon scan interval created after stop_discovery()");
        clearInterval(this.scanIntervalId);
        this.scanIntervalId = 0;
      }
    }, 400);
    return result;
  };
}

/** An open or connecting connection to host:port, if any. */
function findConnection(roon: any, host: string, port: number | string): any {
  for (const conn of Object.values(roon._sood_conns ?? {}) as any[]) {
    const t = conn?.transport;
    if (t?.ws && t.host === host && String(t.port) === String(port)) {
      return conn;
    }
  }
  return undefined;
}

/** Remove entries whose transport is already closed (safety net). */
export function removeStaleConnections(roon: any): number {
  let removed = 0;
  for (const [key, conn] of Object.entries(roon._sood_conns ?? {}) as [string, any][]) {
    if (!conn?.transport?.ws) {
      delete roon._sood_conns[key];
      removed++;
    }
  }
  if (removed) {
    log.info("Removed %d stale Roon connection entr%s", removed, removed === 1 ? "y" : "ies");
  }
  return removed;
}

export interface CoreEndpoint {
  host: string;
  port: number;
}

/**
 * Reconnects to the last known Roon Core with increasing delays while not paired.
 *
 * Works in addition to the SOOD discovery of node-roon-api, so a restart of the
 * Roon Core (or lost multicast packets) doesn't leave the Remote without Roon.
 */
export class RoonReconnector {
  private readonly roon: any;
  private readonly delays: number[];
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  private enabled = false;
  private endpoint: CoreEndpoint | undefined;

  constructor(roon: RoonApi, delays: number[] = RECONNECT_DELAYS) {
    this.roon = roon;
    this.delays = delays;
    fixRoonInstance(roon);
    const saved = this.roon.load_config?.(LAST_CORE_KEY);
    if (saved?.host && saved?.port) {
      this.endpoint = { host: saved.host, port: Number(saved.port) };
    }
  }

  get lastEndpoint(): CoreEndpoint | undefined {
    return this.endpoint;
  }

  /** Start reconnecting (startup, Remote woke up): first attempt right away. */
  start(): void {
    this.enabled = true;
    this.attempt = 0;
    this.clearTimer();
    if (!this.roon.is_paired) {
      this.tryNow();
    }
  }

  /** Stop all reconnect attempts (Remote goes to standby). */
  stop(): void {
    this.enabled = false;
    this.clearTimer();
  }

  /** Paired with a core: remember its address, stop retrying. */
  onPaired(core: Core): void {
    this.attempt = 0;
    this.clearTimer();
    const transport = (core as any)?.moo?.transport;
    if (transport?.host && transport?.port) {
      const host = String(transport.host);
      const port = Number(transport.port);
      if (host !== "127.0.0.1" || !this.endpoint) {
        this.endpoint = { host, port };
        this.roon.save_config?.(LAST_CORE_KEY, this.endpoint);
      }
      log.info("Roon Core endpoint: %s:%d", host, port);
    }
  }

  /** Lost the core: start retrying with increasing delays. */
  onUnpaired(): void {
    this.attempt = 0;
    this.schedule();
  }

  private clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule() {
    if (!this.enabled || this.timer || this.roon.is_paired) {
      return;
    }
    const delay = this.delays[Math.min(this.attempt, this.delays.length - 1)] ?? 60;
    log.debug("Next Roon reconnect attempt in %d s", delay);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tryNow();
    }, delay * 1000);
  }

  private tryNow() {
    if (!this.enabled || this.roon.is_paired) {
      return;
    }
    this.attempt++;
    removeStaleConnections(this.roon);

    // ask the network again (SOOD) - cheap and finds a core with a new address
    try {
      this.roon._sood?.query({ query_service_id: ROON_SERVICE_ID });
    } catch (e) {
      log.debug("SOOD query failed: %s", e);
    }

    // and connect directly to the last known address
    if (this.endpoint && this.roon._sood_conns && !findConnection(this.roon, this.endpoint.host, this.endpoint.port)) {
      const { host, port } = this.endpoint;
      const key = `direct:${host}:${port}`;
      log.info("Reconnecting to Roon Core %s:%d (attempt %d)", host, port, this.attempt);
      this.roon._sood_conns[key] = this.roon.ws_connect({
        host,
        port,
        onclose: () => {
          delete this.roon._sood_conns[key];
        }
      });
    }
    this.schedule();
  }
}
