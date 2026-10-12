/**
 * Reconnect behaviour against the real node-roon-api and a mock Roon Core.
 * Scenario from the field: the Roon Core restarts and the Remote never finds it again.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import test from "ava";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import RoonApi from "node-roon-api";
import { applyRoonApiFixes, removeStaleConnections, RoonReconnector } from "../src/roon-connection.js";

const require = createRequire(import.meta.url);
applyRoonApiFixes(require("node-roon-api"), 1500);
const { WebSocketServer } = require("ws");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(pred: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) {
      return true;
    }
    await sleep(50);
  }
  return false;
}

function enc(verb: string, name: string, rid: string, body?: unknown): Buffer {
  const head = `MOO/1 ${verb} ${name}\nRequest-Id: ${rid}\n`;
  if (body === undefined) {
    return Buffer.from(head + "\n");
  }
  const b = Buffer.from(JSON.stringify(body));
  return Buffer.concat([Buffer.from(head + `Content-Length: ${b.length}\nContent-Type: application/json\n\n`), b]);
}

type MockCore = any;

function startCore(port: number): MockCore {
  const wss: MockCore = new WebSocketServer({ port, path: "/api" });
  wss.registers = 0;
  wss.on("connection", (ws: any) =>
    ws.on("message", (data: Buffer) => {
      const s = data.toString();
      const first = s.split("\n")[0] ?? "";
      const rid = /Request-Id: (\d+)/.exec(s)?.[1] ?? "0";
      if (first.includes("registry:1/info")) {
        ws.send(enc("COMPLETE", "Success", rid, { core_id: "C1", display_name: "Mock", display_version: "2" }));
      } else if (first.includes("registry:1/register")) {
        wss.registers++;
        ws.send(
          enc("CONTINUE", "Registered", rid, {
            core_id: "C1",
            display_name: "Mock",
            display_version: "2",
            token: "t",
            provided_services: [],
            http_port: port
          })
        );
      }
    })
  );
  return wss;
}

async function stopCore(core: MockCore) {
  for (const c of core.clients) {
    c.terminate();
  }
  await new Promise((resolve) => core.close(resolve));
}

function makeRoon() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roon-test"));
  const st = { paired: 0, unpaired: 0 };
  // eslint-disable-next-line prefer-const
  let rc: RoonReconnector;
  const roon: any = new (RoonApi as any)({
    extension_id: "t",
    display_name: "t",
    display_version: "1",
    publisher: "p",
    email: "e",
    configDir: dir,
    core_paired: (core: any) => {
      st.paired++;
      rc.onPaired(core);
    },
    core_unpaired: () => {
      st.unpaired++;
      rc.onUnpaired();
    }
  });
  roon.init_services({ provided_services: [] });
  rc = new RoonReconnector(roon, [0.2, 0.5, 1]);
  return { roon, rc, st };
}

function sood(roon: any, port: number) {
  roon._sood.emit("message", {
    from: { ip: "127.0.0.1", port: 9003 },
    props: { service_id: "00720724-5143-4a9b-abac-0e50cba674bb", unique_id: "core1", http_port: String(port) }
  });
}

test.serial("core restart: SOOD answer while its WebSocket is down doesn't block reconnects", async (t) => {
  const port = 19431;
  const { roon, rc, st } = makeRoon();
  roon.start_discovery();
  await sleep(200);
  let core = startCore(port);
  sood(roon, port);
  t.true(await until(() => st.paired === 1));
  await stopCore(core);
  t.true(await until(() => st.unpaired === 1));
  rc.stop(); // test fix 1 only
  sood(roon, port);
  await sleep(600);
  t.deepEqual(Object.keys(roon._sood_conns), [], "failed attempt must not leave an entry");
  core = startCore(port);
  sood(roon, port);
  t.true(await until(() => st.paired === 2), "next SOOD answer must reconnect");
  roon.stop_discovery();
  roon.disconnect_all();
  await stopCore(core);
});

test.serial("core restart without SOOD: direct reconnect with increasing delays, no duplicates", async (t) => {
  const port = 19432;
  const { roon, rc, st } = makeRoon();
  roon.start_discovery();
  await sleep(200);
  rc.start();
  let core = startCore(port);
  sood(roon, port);
  t.true(await until(() => st.paired === 1));
  t.is(rc.lastEndpoint?.port, port);
  await stopCore(core);
  await until(() => st.unpaired === 1);
  await sleep(1500);
  core = startCore(port);
  t.true(await until(() => st.paired === 2, 5000));
  t.is(core.registers, 1);
  rc.stop();
  roon.stop_discovery();
  roon.disconnect_all();
  await stopCore(core);
});

test.serial("hanging handshake is aborted by the connect timeout", async (t) => {
  const port = 19433;
  const { roon, rc } = makeRoon();
  const sockets: net.Socket[] = [];
  const hang = net.createServer((sock) => sockets.push(sock)).listen(port); // never answers the upgrade
  roon.start_discovery();
  await sleep(200);
  rc.stop();
  sood(roon, port);
  await sleep(300);
  t.is(Object.keys(roon._sood_conns).length, 1);
  t.true(await until(() => Object.keys(roon._sood_conns).length === 0, 4000));
  sockets.forEach((sock) => sock.destroy());
  hang.close();
  roon.stop_discovery();
});

test.serial("standby stops retrying, wake-up reconnects immediately", async (t) => {
  const port = 19434;
  const { roon, rc, st } = makeRoon();
  roon.start_discovery();
  await sleep(200);
  rc.start();
  const core = startCore(port);
  sood(roon, port);
  await until(() => st.paired === 1);
  rc.stop();
  roon.stop_discovery();
  roon.disconnect_all();
  await until(() => st.unpaired === 1);
  await sleep(800);
  t.is(core.registers, 1, "no attempts during standby");
  t.is(new RoonReconnector(roon).lastEndpoint?.port, port, "endpoint persisted");
  roon.start_discovery();
  rc.start();
  t.true(await until(() => st.paired === 2, 1500));
  rc.stop();
  roon.stop_discovery();
  roon.disconnect_all();
  await stopCore(core);
});

test.serial("SOOD keeps re-scanning network interfaces after standby / wake-up", async (t) => {
  const { roon } = makeRoon();
  roon.start_discovery();
  await sleep(300);
  roon.stop_discovery(); // enter standby
  roon.start_discovery(); // exit standby
  await sleep(300);
  const timer = roon._sood.interface_timer;
  t.truthy(timer, "interface timer exists");
  t.false(Boolean(timer?._destroyed), "interface timer is running again");
  roon.stop_discovery();
});

test.serial("stop right after start (wake up + sleep within 200 ms) doesn't break the next start", async (t) => {
  const { roon } = makeRoon();
  roon.start_discovery();
  roon.stop_discovery(); // immediately: scan interval is created 200 ms later
  await sleep(600);
  t.falsy(roon.scanIntervalId, "late scan interval cleared");
  roon.start_discovery();
  await sleep(400);
  t.truthy(roon.scanIntervalId, "next start runs discovery again");
  t.false(Boolean(roon._sood.interface_timer?._destroyed), "interface timer running");
  roon.stop_discovery();
  await sleep(500);
});

test("removeStaleConnections removes closed entries only", (t) => {
  const roon: any = { _sood_conns: { a: { transport: {} }, b: { transport: { ws: {} } } } };
  t.is(removeStaleConnections(roon), 1);
  t.deepEqual(Object.keys(roon._sood_conns), ["b"]);
});
