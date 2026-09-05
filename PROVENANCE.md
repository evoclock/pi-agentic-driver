# Provenance

This repository is the public package source for `@evoclock/pi-agentic-driver`.

- Release 0.1.1 content originates from the reviewed private development
  repository, qualified through the acceptance environment (fixtures,
  native tests, live-session checks, and independent model review) before
  publication. Tarball sha256 for the qualified 0.1.1 artifact:
  `5ac35b7873d7fa8cd45e718d900d562302f9fbe0fd4bdcbe067718a637f9c946`.
- This initial public commit adds SPDX headers, the project README, this
  provenance note, and the package licence metadata; behaviour is unchanged
  from the qualified artifact. Future releases are built from this
  repository so each tag matches its tarball exactly.
- No third-party code is bundled. Concept credit for the cognitive-
  complexity signals is recorded in the README and the extension
  description; no code was copied from credited sources.
- Release 0.2.0 adds the existing reviewed Linux microVM closure. Native
  qualification on 5 September 2026 used fixture
  `microvm-220fc33307638cda1d9fd4c6` on `ubuntu-backend` and returned
  `VERIFIED`. The retained probe marker hash is
  `043d2846707b67eb4a1e4e577ff070346da881d713b91d0f905da96ea68b4844`;
  the fixture script hash is
  `05e9071c027a128c7cd2e20d126fbdd7915d093c9f91047d6fe67d26e01849b1`;
  and the initramfs hash is
  `721de3392f8d975cd0c1f46190ee266c7e0cb3c50e93c4af3bc5d411bc8ab523`.
  The transient domain was checked absent, the initramfs entry was removed,
  and ACL before/after hashes were equal
  (`31de5110ae73bbece4c86ea49b0338c2f933ed372a409abc9d8108b3d0f61ebd`).
  No disk, host share, credentials, GPU, network, authority, or persistent
  runtime was created. The native macOS Container runtime was separately
  qualified with local image digest
  `sha256:0019eef4a42554b1ad94d7c42203a1c58f964714eac60e7d9559742ee3ad494f`;
  its fixed read-only `/workspace`, no-network `/bin/pwd` probe returned
  `/workspace` and `--rm` removal was verified. A native macOS Pi adapter is
  not claimed by this release yet.
- Release 0.2.1 corrects the isolation mode boundary: microVM/container
  runtime activation is reserved for planned or automated execution paths and
  is not ordinary ad-hoc work. The shipped microVM closure remains qualified
  but activation is deferred until the planned isolation execution path is
  enabled; the adapter now fails closed when that activation flag is absent.
- Release 0.3.0 adds AI;DR, a read-only writing-review extension. Its profile
  is based on the four stated principles of clarity, simplicity, brevity, and
  humanity, with optional plain-language, analogy, and bullet-structure
  guidance. It captures the last assistant response for review, preserves
  code/frontmatter by excluding fenced prose from analysis, and never edits a
  file automatically; normal confirmed Pi editing remains the write boundary.
