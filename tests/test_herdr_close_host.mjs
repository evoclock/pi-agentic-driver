import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { join, relative } from "node:path";
import * as lifecycle from "../scripts/enforcement/herdr_lifecycle_pi.js";

async function listener(t) {
  const root = process.cwd(); mkdirSync(join(root, "scratch"), { recursive: true });
  const home = realpathSync(mkdtempSync(join(root, "scratch/close-host-")));
  const socket = join(home, "herdr.sock");
  const binary = join(home, "herdr"); writeFileSync(binary, "fixture", { mode: 0o755 });
  const server = createServer();
  // Relative pathname stays below macOS sun_path's limit in a long Treehouse path.
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(relative(root, socket), resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  chmodSync(socket, 0o600);
  const expected = { host: hostname(), uid: process.getuid(), socket, binary };
  const state = { listing: `p1234\nn${socket}\n`, process: `${expected.uid} Fri Nov 13 23:00:00 2026 ${binary} server`,
    image: `p1234\nftxt\ni${statSync(binary).ino}\nn${binary}\n` };
  const calls = [];
  const options = { testCloseProbe: (executable, argv) => {
    calls.push({ executable, argv });
    if (executable === "/bin/ps") return state.process;
    return argv.includes("txt") ? state.image : state.listing;
  } };
  const observe = () => {
    assert.equal(typeof lifecycle.observeLocalCloseHost, "function");
    return lifecycle.observeLocalCloseHost(expected, options);
  };
  return { expected, state, calls, observe, home, socket };
}

// Why: locality needs a real Unix socket and a matching local process image, not host text alone.
test("local host verifier binds private socket, process image, uid and start identity", async t => {
  const f = await listener(t); const host = f.observe();
  assert.equal(host.pid, 1234); assert.equal(host.local, true); assert.equal(host.socket, f.socket);
  assert.equal(host.host, hostname()); assert.match(host.socketIdentity, /^[0-9]+:[0-9]+$/);
  assert.equal(host.startedAt, "Fri Nov 13 23:00:00 2026");
  assert.deepEqual(f.calls.map(c => c.executable), ["/usr/sbin/lsof", "/bin/ps", "/usr/sbin/lsof"]);
});

// Why: proxy listeners and forged command text cannot stand in for the trusted server image.
test("local host verifier rejects ambiguous listeners, ssh, wrong uid, and missing executable image", async t => {
  const f = await listener(t); const initial = { ...f.state };
  for (const change of [
    { listing: `p1234\nn${f.socket}\np5678\nn${f.socket}\n` },
    { listing: "p1234\nn/foreign/socket\n" },
    { process: `${f.expected.uid} Fri Nov 13 23:00:00 2026 /usr/bin/ssh -L proxy` },
    { process: `${f.expected.uid + 1} Fri Nov 13 23:00:00 2026 ${f.expected.binary} server` },
    { image: `p1234\nftxt\ni1\nn${f.expected.binary}\n` },
    { image: `p1234\nftxt\ni${statSync(f.expected.binary).ino}\nn/foreign/herdr\n` },
    { process: `${f.expected.uid} Fri Nov 13 23:00:00 2026 ${f.expected.binary} --remote macbook` },
  ]) {
    Object.assign(f.state, initial, change);
    assert.throws(f.observe, { code: "local_server_unverified" });
  }
});

// Why: pathname aliases, regular files and public sockets must not be trusted as a private server endpoint.
test("local host verifier rejects insecure socket modes and non-socket aliases", async t => {
  const f = await listener(t);
  chmodSync(f.socket, 0o666); assert.throws(f.observe, { code: "local_server_unverified" });
  chmodSync(f.socket, 0o600);
  const alias = join(f.home, "alias.sock"); symlinkSync(f.socket, alias); f.expected.socket = alias;
  assert.throws(f.observe, { code: "local_server_unverified" });
  f.expected.socket = f.expected.binary; assert.throws(f.observe, { code: "local_server_unverified" });
});
