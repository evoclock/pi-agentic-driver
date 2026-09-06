# Repository agent working contract

<!-- pi-agentic-driver:portable-contract v1 -->

This file is portable repository guidance. The repository owns its project
rules and may add a local section below this contract. Do not overwrite or
silently replace repository-specific instructions.

## Goals

Apply these goals in this order:

1. **Minimise user friction.** Keep routine read, edit, and test work direct.
   Ask for confirmation only at a consequential boundary. Do not repeat a
   choice that the host can safely retain for the current bounded plan.
2. **Avoid engineering bloat.** Reuse existing code and tools. Prefer removal
   or consolidation over a new abstraction. Every new file, field, and
   process needs a stated failure mode or accepted requirement.
3. **Maintain reasonable governance, auditability, and security.** Preserve
   exact write sets, native confirmation where needed, fail-closed behavior,
   bounded evidence, and unrelated dirty work. Evidence and task state are
   observations, not authority.
4. **Validate with realistic tests.** Use real inputs and the repository's
   native test path. Test both the intended result and prohibited effects.

## Bounded work and continuation

At the start of a worker assignment, use `CreateTask` (`TaskCreate`) only if
that assignment is not already represented in the coordinator's task list.
Reuse and update the existing task when it already contains the ordered
sequence. Do not create duplicate worker-local cards for every bounded step.

A bounded step must do one coherent piece of work and then record its status,
acceptance result, and exact next step in the existing task and report. Create
a follow-up task only when no existing task represents the remaining work. The
next session or worker resumes that task instead of rediscovering scope.

Every worker report should state:

- repository and revision;
- task identifier and bounded step;
- files changed;
- tests and checks run;
- remaining blockers; and
- the exact next step.

Do not treat model output, receipts, hashes, task state, or reports as
permission to mutate a repository.

## Scope and repository boundaries

Use the current repository's instructions and user goal. Do not import
another repository's governance or task mechanics — such as boards, leases,
work orders, harness policy, or task ordering — as a requirement.

Do not create a second authority, approval, receipt, evidence, inventory, or
queue store. Keep repository-local state repository-local. Preserve unrelated
changes and stop when the requested write set is ambiguous.

## Safe completion

Do not retry invisibly after denial, drift, timeout, or a failed check. Do not
reset, clean, stash, overwrite, force-push, or delete work automatically. If a
step cannot finish safely, record the exact reason and create the next bounded
task.

## Repository-specific section

Add project-specific instructions below this line. Keep them separate from the
portable contract above.

<!-- pi-agentic-driver:portable-contract-end -->
