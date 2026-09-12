# Git workflow safeguards

**Status:** design proposal; implementation not started.

**Owner:** `pi-agentic-driver`.

**Purpose:** define the lowest-friction Pi-facing Git workflow possible across
trusted repositories and workspaces. Safety must remove uncertainty without
turning routine work into ceremony. This specification does not authorize
implementation, Git mutation, remote access, or release.

**Primary design paradigm:** ask once only when the user is about to cause a
consequential change; otherwise observe, derive, and report without ceremony.
Never make the user repeat a choice that the host can safely retain for the
current plan.

## Design goals

The design applies these goals in order:

1. **Minimise user friction.** Routine status, diff, and read-only inspection
   stay prompt-free. One bounded multi-target change plan uses one meaningful
   confirmation, not one prompt per file or target. Existing feature branches
   and checkouts remain the default; worktrees require an explicit choice.
2. **Avoid engineering bloat.** Reuse Git, native hooks, and existing
   read-only scope adapters. Do not create a second Git policy, authority, or
   evidence system.
3. **Maintain reasonable governance, auditability, and security.** Derive
   mechanics from trusted host and workspace state, show the exact scope,
   revalidate before mutation, fail closed on drift, and return bounded
   non-authorizing facts.
4. **Validate with realistic tests.** Test real repositories and workspaces
   with unrelated changes, renames, deletions, untracked files, hooks, drift,
   denial, slow processes, feature branches, worktrees, and partial failures.

## Why this is not just a Git hook

Native Git hooks remain the final invariant boundary. They can accept or reject
staged content at a Git lifecycle point. They do not, by themselves, provide a
Pi-aware workflow that:

- derives exact file sets from semantic user intent;
- coordinates several repositories or workspaces;
- shows a bounded proposal before staging;
- requests one native confirmation;
- re-observes state after confirmation; or
- returns consistent denial, drift, hook-failure, partial, or success results.

The extension adds only that workflow layer. It must not replace, emulate,
bypass, or weaken native hooks.

## Smallest coherent scope

The first implementation covers one semantic plan. A plan may contain one or
more trusted repository targets across one or more trusted workspaces:

> **Review exact file sets, stage all selected files per repository, and
> optionally create one local commit per repository.**

The operation may:

- observe trusted repositories and workspaces;
- derive candidate changes from read-only Git status and diff data;
- expand directory intent into concrete file lists before confirmation;
- coordinate multiple files in one staging operation, never one prompt per
  file;
- coordinate multiple repository targets in one displayed plan;
- display included files, excluded unrelated changes, status, and bounded diff
  summaries for every target;
- use feature branches as the default branch workflow;
- use ordinary existing checkouts by default, with worktrees only by explicit
  choice;
- provide explicit worktree inspection and pruning for users who opt in;
- obtain one native confirmation for the complete displayed plan;
- revalidate every target, workspace, branch, worktree, file identity, content,
  and relevant index state after confirmation;
- stage all confirmed paths per repository;
- verify each staged snapshot;
- run the normal local commit path, including native hooks; and
- return one bounded plan receipt with per-target results.

Cross-repository and cross-workspace plans are permitted when every target is
trusted and independently observed. Git does not provide an atomic commit
across repositories, so the plan must never claim cross-repository atomicity.

The operation must never stage a directory path without first expanding and
showing its exact file inventory.

## Target model

A target is a trusted workspace plus a canonical Git root discovered within
that workspace. A workspace may be:

- a local directory containing one or more Git repositories;
- a trusted remote host/path such as a configured SSH workspace; or
- a non-Git model/data workspace, which is observable but is not eligible for
  Git mutation until it yields a canonical Git root.

Trusted workspace entries must identify the host or local context, canonical
path policy, and allowed operation class. A model must not invent a host,
workspace path, repository root, branch, remote, or worktree location.

A plan contains an ordered list of targets. Each target records its observed
workspace, Git root, branch, worktree mode, exact file set, and requested local
operation. Targets may use different repositories, workspaces, branches, and
base commits.

## Branch and worktree policy

### Feature branches by default

The normal workflow uses a feature branch, not a worktree:

- if the target is already on an acceptable feature branch, retain it;
- if the target is on a default or protected branch, propose a feature branch
  through native semantic selection and confirmation;
- if the target is detached or otherwise unsuitable, stop and report the
  condition unless the user selects a valid feature branch;
- use one semantic branch purpose across targets when requested, but record the
  actual branch and base commit separately for every repository.

Branch creation is local and explicit. The model does not supply raw branch
names or branch commands. Push, upstream creation, merge, and protected
branch delivery remain separate operations.

### Worktrees are opt-in

An ordinary checkout is the default. The tool must not create a worktree just
to make parallel work convenient.

A user may explicitly choose `use-worktree` through native semantic selection.
For each selected target, the plan must show:

- the existing checkout and proposed worktree roots;
- the branch and base commit;
- whether the worktree path already exists;
- active or dirty state observed at both locations; and
- cleanup and pruning consequences.

Worktree creation, removal, and pruning are separate explicit actions. The
system must never prune worktrees merely because a task or commit completed.
For an opted-in worktree, the workflow must provide a read-only stale-worktree
inventory and a confirmed prune action that:

- identifies stale administrative records and removable worktrees;
- refuses dirty or active worktrees unless a separately confirmed safe action
  exists;
- never uses a force removal by default;
- preserves branches and commits; and
- returns exactly which records were pruned.

## Proposed semantic interface

The future Pi tool should accept semantic context, not Git mechanics:

```text
operation: stage-and-commit
workspaceSelection: native selection from trusted workspaces
repositorySelection: native selection from observed Git roots
purpose: semantic reason for the change
commitMessage: user-facing message, when a commit is requested
branchPolicy: feature-branch-default
worktreePolicy: existing-checkout-default | use-worktree
```

The tool must reject or ignore model-supplied:

- absolute paths and arbitrary pathspecs;
- branch, remote, upstream, revision, host, or worktree selectors;
- raw Git arguments, shell commands, flags, or environment values;
- approval, lease, receipt, nonce, hash, task, or completion fields; and
- requests to disable hooks, reset state, clean files, force-remove worktrees,
  or retry silently.

A native selection may choose from host-observed workspaces, repositories,
branches, candidate files, and explicit worktree choices. The model must not
manufacture those mechanics.

## Operation phases

### 1. Observe all targets

Resolve every workspace and repository from trusted context. Verify for each
target:

- canonical workspace and Git root identity;
- current branch, default/protected status, or detached-HEAD state;
- checkout or worktree identity;
- worktree status and index state;
- candidate changed paths, including untracked files;
- path containment and symlink safety; and
- absence of unsupported repository state.

All targets must pass preflight before the plan reaches confirmation. A failed
observation produces an explicit blocked target and no mutation.

### 2. Derive and preview one multi-target plan

Derive an exact repository-relative file set for every target from observed
state and explicit semantic intent. For directory intent, expand once per
target and retain each resulting file list as part of the preview snapshot.

The preview must show, for every target:

- workspace and canonical repository root;
- branch, base commit, and checkout/worktree mode;
- included files and status, including renames and deletions;
- unrelated dirty files that will remain untouched;
- bounded diff statistics and relevant hunks;
- whether the target stages only or also creates one local commit; and
- the fact that native hooks will run.

It must also show plan-level facts:

- target order;
- the fact that commits are per repository, not atomic across repositories;
- the behavior if one target succeeds and another fails; and
- any target requiring a feature branch or opted-in worktree.

The preview is read-only. It must not stage, alter an index, refresh an
inventory, create a commit, create a worktree, prune a worktree, or contact a
remote.

### 3. Confirm once

Ask for one native confirmation covering exactly the displayed multi-target
plan. The confirmation must not be satisfied by chat text, a model argument,
or a mechanical approval field.

A denial returns a concise reason, leaves every target unchanged, does not
retry, and leaves the Pi session usable.

### 4. Revalidate all targets

After confirmation, re-observe every target. Deny the affected plan without
mutation when any of these changed:

- canonical workspace, repository, or Git identity;
- branch, base commit, detached-HEAD state, or worktree identity;
- included or excluded file identity;
- relevant file content, status, or index state;
- feature-branch or worktree facts; or
- preview-relevant diff data.

Do not silently regenerate a file list, select another target, or ask a second
confirmation after drift. Return a drift result and stop before staging.

### 5. Stage and commit per repository

For each target, stage all exact confirmed paths in one fixed, non-shell Git
operation. Never use `git add <directory>` for an unresolved directory request.
Never use `--no-verify`.

Verify each staged snapshot against its target preview before committing. If
requested, create one local commit per repository and allow native hooks to
make their final decision. A plan must not imply that these commits form one
atomic transaction.

If a target fails after an earlier target succeeded, stop remaining targets and
return a partial plan receipt. Do not reset, clean, stash, undo commits, or
retry automatically. The user decides how to reconcile the partial result.

### 6. Worktree maintenance

Worktree creation, removal, and pruning never happen implicitly as a side effect of staging or
committing. A separate confirmed action must show the observed worktree inventory and exact
prune set. It must preserve dirty or active worktrees and return actual pruned records.

### 7. Receipt

Return one bounded plan result with:

- plan status: `completed`, `denied`, `drifted`, `blocked`, `partial`, or
  `failed`;
- per-target status: `committed`, `staged`, `denied`, `drifted`,
  `hook-rejected`, `blocked`, or `partial`;
- workspace, repository, branch, base commit, and checkout/worktree facts per
  target;
- exact included paths and preserved unrelated dirty paths per target;
- commit identity per repository when a commit exists;
- hook outcome per target when a hook ran;
- explicit partial ordering when targets differ in outcome;
- concise reason and next action; and
- `nonAuthorizing: true` and `authorityCreated: false`.

The receipt is evidence of observed operations. It is not permission for a
later push, merge, completion, sign-off, or publication. Do not create a
second durable evidence ledger for this feature.

## Explicit non-goals

The first implementation must not provide:

- push or upstream creation;
- merge, protected push, branch deletion, or history rewrite;
- force push or remote selection;
- assignment, lease, board, completion, deployment, or publication authority;
- inventory refresh coupled to staging or commit;
- automatic retry, reset, cleanup, stash, target substitution, or worktree
  pruning;
- hook replacement, hook bypass, or synthetic hook approval;
- arbitrary shell or general-purpose Git command execution;
- model-selected workspace, repository, branch, path, remote, revision, or
  worktree mechanics; or
- arbitrary wall-clock termination of healthy Git or hook processes.

Cross-repository and cross-workspace observation and local commit plans are
allowed when every target is trusted and independently revalidated. Remote
transport, push, upstream, protected-branch, merge, and assignment-aware
journeys remain separate future actions with their own confirmations and
receipts.

## Reuse map

The implementation should reuse, rather than duplicate:

- `lib/adapters/diff-scope.mjs` for bounded read-only diff and changed-range
  observations;
- `lib/code-phage-core.mjs` changed-path and repository-safe path handling;
- `scripts/lifecycle_mode_pi.js` native confirmation plumbing; and
- the existing canonical Git-root resolution pattern in the Herdr lifecycle
  adapter.

The feature must not create a competing mode contract, confirmation framework,
receipt store, inventory transaction, workspace registry, or Git policy core.

## Friction controls

The implementation is rejected if it reintroduces any of these failure
patterns:

- **One-file-at-a-time friction:** stage all confirmed files per repository in
  one operation and confirm the plan once.
- **Directory staging friction:** expand and preview exact files once per
  target.
- **Inventory transaction coupling:** inventory refresh is independent and
  never blocks a valid multi-target stage or commit.
- **Initial push/upstream friction:** remote setup is outside this scope.
- **Default worktree friction:** use feature branches in existing checkouts by
  default; make worktrees an explicit opt-in and provide confirmed pruning.
- **Cross-repository ambiguity:** show each target separately and never claim
  atomicity across repositories.
- **Post-denial friction:** explain the denial, preserve state, continue the
  session, and never retry invisibly.
- **Duration friction:** use process settlement and explicit cancellation;
  never kill healthy Git or hook work solely because a wall clock elapsed.

## Acceptance tests required before implementation is released

Use real temporary Git repositories, multiple workspace roots, trusted remote
workspace fixtures, native hook fixtures, and explicit worktree fixtures. Tests
must prove:

1. multiple named files stage together while unrelated changes remain untouched;
2. directory intent expands to a displayed immutable file list per repository;
3. one preview covers several repositories and workspaces without claiming
   cross-repository atomicity;
4. preview performs no index, worktree, ref, branch, worktree, configuration,
   or remote mutation;
5. one native confirmation covers the displayed plan;
6. denial leaves every target unchanged and triggers no retry;
7. file, branch, repository, workspace, or content drift fails closed;
8. a new unrelated file cannot enter any staged snapshot after confirmation;
9. tracked modification, deletion, rename, and intended untracked addition work
   across multiple repositories;
10. feature-branch creation is the default for default/protected branches;
11. existing checkouts remain the default and worktree creation requires an
    explicit choice;
12. worktree inventory and confirmed pruning preserve dirty and active work;
13. each repository gets one staged snapshot and at most one local commit;
14. one target failure produces an explicit partial plan receipt and does not
    reset or undo a successful earlier target;
15. a native pre-commit hook remains decisive and cannot be bypassed;
16. partial staging or hook failure returns actual state without auto-reset;
17. detached HEAD, ambiguous workspace selection, symlink escape, and
    unsupported state fail closed;
18. healthy slow hooks are not killed by an arbitrary elapsed-time rule;
19. cancellation or real process failure reports actual state;
20. no push, upstream mutation, merge, force flag, reset, cleanup, remote
    command, or implicit worktree prune occurs; and
21. plan and target receipts are bounded, non-authorizing, and do not duplicate
    the full diff or create a second evidence store.

## Implementation gate

Do not implement until a reviewer accepts this specification and the following
are recorded:

- exact public write set;
- trusted workspace and repository target schema;
- feature-branch and opt-in worktree lifecycle contract;
- cross-repository partial-failure semantics;
- reused abstractions and any justified additions;
- native confirmation and drift contract;
- complete acceptance fixture matrix;
- deletion test for every new module and field; and
- explicit decision that push, protected, assignment-aware, and merge journeys
  remain out of scope.
