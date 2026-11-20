// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = process.env.PAD_CODEX_BINARY_SOURCE
  ? pathToFileURL(process.env.PAD_CODEX_BINARY_SOURCE).href
  : new URL('../scripts/enforcement/codex_spawn_pi.js', import.meta.url).href;
const { verifyCodexProcess, codexLaunch } = await import(source);

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pad-r53-identity-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, 'installed');
  mkdirSync(installed);
  const expected = join(installed, 'codex');
  writeFileSync(expected, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), { mode: 0o700 });
  const launch = { home: '/fixture/account', binaryRealPath: expected, argv: ['-m', 'gpt-6-sol', '-c', 'daybreak=true'] };
  const observe = (candidate, chosen = launch) => verifyCodexProcess({ pid: 99 }, chosen, {
    readCodexProcess: () => ({ args: `${candidate} -m gpt-6-sol -c daybreak=true`, home: chosen.home }),
  });
  return { root, expected, launch, observe };
}

// Why: a configured canonical native binary must still certify with fake process facts.
test('owner-configured canonical native binary is accepted', t => {
  const f = fixture(t);
  assert.equal(f.observe(f.expected), true);
});

// Why: an executable with the right name in a different directory is not the configured binary.
test('unexpected directory cannot pass by basename', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'other'));
  const candidate = join(f.root, 'other', 'codex');
  writeFileSync(candidate, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), { mode: 0o700 });
  assert.throws(() => f.observe(candidate), /mismatch/);
});

// Why: following a symlink outside the owner-configured target must refuse even with the right name.
test('symlink to an outside binary is refused', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'other'));
  const outside = join(f.root, 'other', 'codex');
  writeFileSync(outside, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), { mode: 0o700 });
  const shadow = join(f.root, 'codex');
  symlinkSync(outside, shadow);
  assert.throws(() => f.observe(shadow), /mismatch/);
});

// Why: even a symlink to the trusted binary needs an owner-configured launch path, not an arbitrary alias.
test('unconfigured symlink alias is refused but an explicit owner alias is accepted', t => {
  const f = fixture(t);
  const alias = join(f.root, 'codex');
  symlinkSync(f.expected, alias);
  assert.throws(() => f.observe(alias), /mismatch/);
  assert.equal(f.observe(alias, { ...f.launch, binaryLaunchPath: alias }), true);
});

// Why: a PATH-resolved name can be shadowed; a bare argv0 provides no binary identity.
test('PATH-shadowed unqualified codex is refused', t => {
  const f = fixture(t);
  assert.throws(() => f.observe('codex'), /mismatch/);
});

// Why: an executable shell script named codex is not a native Codex binary.
test('codex-named shell script is refused', t => {
  const f = fixture(t);
  writeFileSync(f.expected, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.throws(() => f.observe(f.expected), /mismatch/);
});

// Why: regression guard for relative argv0 rejection, which already worked before R5-3; not a fail-first proof.
test('relative codex path is refused', t => {
  const f = fixture(t);
  assert.throws(() => f.observe('./codex'), /mismatch/);
});

// Why: regression guard for non-executable file rejection, which already worked before R5-3; not a fail-first proof.
test('non-executable native file is refused', t => {
  const f = fixture(t);
  chmodSync(f.expected, 0o600);
  assert.throws(() => f.observe(f.expected), /mismatch/);
});

// Why: a configured release root must allow a new single release without editing a versioned target.
test('updated release directory is accepted through configured stable launcher', t => {
  const f = fixture(t);
  const releases = join(f.root, 'releases');
  mkdirSync(releases);
  const first = join(releases, 'first', 'bin');
  const next = join(releases, 'next', 'bin');
  mkdirSync(first, { recursive: true });
  mkdirSync(next, { recursive: true });
  for (const dir of [first, next]) writeFileSync(join(dir, 'codex'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), { mode: 0o700 });
  const alias = join(f.root, 'codex');
  symlinkSync(join(first, 'codex'), alias);
  const launch = { ...f.launch, binaryRealPath: undefined, binaryLaunchPath: alias, binaryRealRoot: releases };
  assert.equal(f.observe(alias, launch), true);
  rmSync(alias);
  symlinkSync(join(next, 'codex'), alias);
  assert.equal(f.observe(alias, launch), true);
});

// Why: root containment must reject even a configured native codex outside the owner release root.
test('configured native binary outside release root refuses', t => {
  const f = fixture(t);
  const releases = join(f.root, 'releases');
  const outside = join(f.root, 'outside', 'bin');
  mkdirSync(releases);
  mkdirSync(outside, { recursive: true });
  const candidate = join(outside, 'codex');
  writeFileSync(candidate, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), { mode: 0o700 });
  assert.throws(() => f.observe(candidate, { ...f.launch, binaryRealPath: candidate, binaryRealRoot: releases }), /mismatch/);
});

// Why: a configured spelling with dot-dot must not certify an otherwise matching native target.
test('configured traversal spelling refuses even when it resolves to a release', t => {
  const f = fixture(t);
  const releases = join(f.root, 'releases');
  const bin = join(releases, 'first', 'bin');
  mkdirSync(bin, { recursive: true });
  const target = join(bin, 'codex');
  writeFileSync(target, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), { mode: 0o700 });
  const spelling = `${bin}/../bin/codex`;
  const launch = { ...f.launch, binaryRealPath: target, binaryLaunchPath: spelling, binaryRealRoot: releases };
  assert.throws(() => f.observe(spelling, launch), /mismatch/);
});

// Why: the model and generated look-alike suite must agree on every binary-identity case.
test('binary identity model enumerates trusted and refused look-alikes', () => {
  const root = new URL('../docs/state-machines/codex-boundary/', import.meta.url);
  const model = JSON.parse(readFileSync(new URL('guard-model.v1.json', root), 'utf8')).binaryIdentityCases;
  const tla = readFileSync(new URL('BinaryIdentity.tla', root), 'utf8');
  const cases = tla.match(/Cases == \{([^}]+)\}/)?.[1].match(/"[^"]+"/g)?.map(s => JSON.parse(s));
  assert.deepEqual(new Set(cases), new Set([...model.accepted, ...model.refused]));
  assert.deepEqual(model.accepted, ['trusted', 'updated-release']);
  assert.deepEqual(model.refused, ['unexpected-directory', 'symlink-outside', 'unconfigured-alias', 'path-shadowed', 'shell-script', 'relative-path', 'non-executable', 'root-escape', 'traversal']);
});

// Why: the owner path-only schema must accept a stable launcher and release root across updates without a version pin.
test('owner config accepts stable launcher and canonical release root across updates', t => {
  const f = fixture(t);
  const home = join(f.root, 'home');
  const releases = join(f.root, 'releases');
  const alias = join(f.root, 'codex');
  const config = join(f.root, 'config.json');
  mkdirSync(home);
  for (const name of ['first', 'next']) {
    const bin = join(releases, name, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codex'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), { mode: 0o700 });
  }
  symlinkSync(join(releases, 'first', 'bin', 'codex'), alias);
  writeFileSync(config, JSON.stringify({ schema: 'pad.codex-accounts.v1', accounts: { 'acct-a': { home, model: 'gpt-6-sol', daybreak: true } }, binaryLaunchPath: alias, binaryRealRoot: releases }));
  assert.equal(codexLaunch('acct-a', 'gpt-6-sol', config).binaryRealRoot, releases);
  rmSync(alias);
  symlinkSync(join(releases, 'next', 'bin', 'codex'), alias);
  assert.equal(codexLaunch('acct-a', 'gpt-6-sol', config).binaryLaunchPath, alias);
});

// Why: the owner-supplied install target is mandatory, canonical and separate from PATH.
test('binary install target must be configured and canonical', t => {
  const f = fixture(t);
  const home = join(f.root, 'home');
  mkdirSync(home);
  const config = join(f.root, 'config.json');
  const save = (binaryRealPath) => writeFileSync(config, JSON.stringify({ schema: 'pad.codex-accounts.v1', accounts: { 'acct-a': { home, model: 'gpt-6-sol', daybreak: true } }, ...(binaryRealPath === undefined ? {} : { binaryRealPath }) }));
  save(undefined);
  assert.throws(() => codexLaunch('acct-a', 'gpt-6-sol', config), /binary configuration denied/);
  save('./codex');
  assert.throws(() => codexLaunch('acct-a', 'gpt-6-sol', config), /binary configuration denied/);
  const linked = join(f.root, 'codex');
  symlinkSync(f.expected, linked);
  save(linked);
  assert.throws(() => codexLaunch('acct-a', 'gpt-6-sol', config), /binary configuration denied/);
  save(f.expected);
  assert.equal(codexLaunch('acct-a', 'gpt-6-sol', config).binaryRealPath, f.expected);
  assert.equal(codexLaunch('acct-a', 'gpt-6-sol', config).binaryLaunchPath, f.expected);
  writeFileSync(config, JSON.stringify({ schema: 'pad.codex-accounts.v1', accounts: { 'acct-a': { home, model: 'gpt-6-sol', daybreak: true } }, binaryRealPath: f.expected, binaryLaunchPath: linked }));
  assert.equal(codexLaunch('acct-a', 'gpt-6-sol', config).binaryLaunchPath, linked);
});
