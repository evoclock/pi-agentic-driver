// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

function processStart(pid) {
  return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2000 }).trim();
}

export function claimSeamLock(directory) {
  const lock = join(directory, "owner.lock");
  const gate = join(directory, "owner-reclaim.lock");
  const owner = { pid: process.pid, hostname: hostname(), start: processStart(process.pid), token: randomUUID() };
  if (!owner.start || existsSync(gate)) throw new Error("storage ownership or reclamation unknown; reconcile manually");
  let heldGate = false;
  let stale;
  try {
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try { mkdirSync(gate, { mode: 0o700 }); }
      catch { throw new Error("storage reclamation in progress or uncertain; reconcile manually"); }
      heldGate = true;
      let previous;
      try { previous = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")); }
      catch { throw new Error("storage owner unknown; reconcile lock manually"); }
      if (previous.hostname !== owner.hostname || !Number.isSafeInteger(previous.pid) || previous.pid < 1 ||
          typeof previous.start !== "string" || !previous.start) throw new Error("storage owner unverified");
      let dead = false;
      try { process.kill(previous.pid, 0); }
      catch (failure) {
        if (failure.code !== "ESRCH") throw new Error("storage owner liveness unknown");
        dead = true;
      }
      if (!dead) {
        let observed;
        try { observed = processStart(previous.pid); }
        catch { throw new Error("storage owner start time unknown"); }
        if (!observed || observed === previous.start) throw new Error("storage owner is still active");
      }
      stale = join(directory, `owner-stale-${randomUUID()}`);
      try { renameSync(lock, stale); }
      catch { throw new Error("storage owner changed during reclamation; reconcile manually"); }
      mkdirSync(lock, { mode: 0o700 });
    }
    if (!heldGate && existsSync(gate)) throw new Error("storage reclamation raced admission; reconcile manually");
    writeFileSync(join(lock, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    if (stale) {
      unlinkSync(join(stale, "owner.json"));
      rmdirSync(stale);
    }
    return { path: lock, token: owner.token };
  } finally {
    if (heldGate) rmdirSync(gate);
  }
}

export function releaseSeamLock(lease) {
  const owner = JSON.parse(readFileSync(join(lease.path, "owner.json"), "utf8"));
  if (owner.token !== lease.token) throw new Error("storage owner changed; refusing to release another owner");
  unlinkSync(join(lease.path, "owner.json"));
  rmdirSync(lease.path);
}
