# Local progress diagram

Standalone visual aid, not a driver extension or live status feed. The authored source is `output/progress.architecture.json`. It is a manual 2026-10-05 snapshot: its adapter status predates completed offline integration and must not be read as current deployment state. Durable remains unactivated live; OpenDots supervision remains undeployed.

Archify by tt-a1i, MIT, v3.0.1: https://github.com/tt-a1i/archify. Release tag commit: `679f195584e4216fd582c073d8964b3a9f59107e`. Trial release ZIP SHA-256: `b0b23bd28db314f04ca8ab9620fe20f8c1ac6474a3546bd8fe4679508aa1b7f5`. No upstream source is redistributed here. Downloaded renderer, browser state, captures and generated HTML remain local and excluded from commits.

To reproduce, obtain and verify that pinned release through Socket Firewall (`sfw`), inspect archive paths before extraction into `scratch/archify-trial/archify`, and create private `scratch/archify-trial/tmp` and `output` directories in the approved workspace. Do not use OS temporary directories. No global install is required. From the repository root, with Chrome available:

```sh
TMPDIR="$PWD/scratch/archify-trial/tmp" \
ARCHIFY_UPDATE_CHECK_DISABLED=1 \
ARCHIFY_CHROME_NO_SANDBOX=0 \
ARCHIFY_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node scratch/archify-trial/archify/bin/archify.mjs finalize architecture \
  scratch/archify-trial/output/progress.architecture.json \
  scratch/archify-trial/output/where-we-are.html \
  --repo-root "$PWD" --quality showcase --json
```

Open the resulting local HTML. The trial passed validation, artifact and automated browser checks; light/dark browser captures were generated and the light screenshot inspected. The first workflow layout failed readability/routing checks; the retained authored architecture view replaced that failed layout without changing the intended responsibilities. This does not prove installation on another machine or continuous synchronization. Source links are local-only and pinned to the diagram's recorded repository commit.

Before updating, distinguish existing tools, tested offline prototypes, planned integration and unproved deployment. Keep the driver as the single claim/dispatch authority. Pi Durable is the persistence library behind our adapter; Treehouse manages workspaces; proposed OpenDots app and services require VM containment. A reviewed report does not mean owner acceptance or deployment.
