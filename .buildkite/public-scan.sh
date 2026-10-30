#!/usr/bin/env bash
set -euo pipefail
if [[ -f scan-terms.local.json ]]; then
  export PUBLIC_SCAN_TERMS="$(node -e 'const fs=require("node:fs"); const a=JSON.parse(process.env.PUBLIC_SCAN_TERMS||"[]"), b=JSON.parse(fs.readFileSync("scan-terms.local.json","utf8")); if(!Array.isArray(a)||!Array.isArray(b)) process.exit(1); process.stdout.write(JSON.stringify([...a,...b]))')"
fi
node .github/tools/public_term_scan.mjs
