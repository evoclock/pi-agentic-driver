#!/usr/bin/env bash
set -euo pipefail
: "${RUNNER_TEMP:?hosted CI only}"
: "${GITHUB_RUN_ID:?hosted CI only}"
# Reuses the inspected containment design in ci-contained.sh at 77b97bac.
root=$(git rev-parse --show-toplevel)
area="$root/.ci-observability"
mkdir -p "$area/source" "$area/home" "$area/image/etc" "$area/image/source" "$area/image/deps" "$area/image/sdk" "$area/image/tooling" "$area/image/opt" "$area/image/usr" "$area/image/cache" "$area/image/scratch"
head=$(git rev-parse HEAD)
git archive "$head" | tar -xf - -C "$area/source"
env -i PATH="$PATH" HOME="$area/home" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git init --template= "$area/source"
git pack-objects --all --stdout | git -C "$area/source" index-pack --stdin
git -C "$area/source" symbolic-ref HEAD refs/heads/feat/task-skill-observability
git -C "$area/source" update-ref HEAD "$head"
git -C "$area/source" update-ref refs/heads/main f05e97b09b748e9e69d1ae421c6026b80e2f3ecb
git -C "$area/source" read-tree "$head"
printf 'fixture:x:65534:65534::/scratch/home:/bin/bash\n' > "$area/image/etc/passwd"
printf 'fixture:x:65534:\n' > "$area/image/etc/group"
for name in bin sbin lib lib64; do ln -s "usr/$name" "$area/image/$name"; done
mkdir -p "$area/image/etc/alternatives" "$area/image/etc/ssl"
printf '' > "$area/image/etc/ld.so.cache"
tar -C "$area/image" -cf "$area/rootfs.tar" .
image=$(docker import "$area/rootfs.tar")
name="observer-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
nodebin=$(dirname "$(readlink -f "$(command -v node)")")
path="$nodebin:/tooling:/usr/local/bin:/usr/bin:/bin"
stop() { docker stop --time 5 "$name" >/dev/null 2>&1 || true; }
trap stop EXIT INT TERM
id=$(docker create --name "$name" --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user 65534:65534 --pids-limit 128 --memory 2g --memory-swap 2g --cpus 2 \
  --ulimit fsize=134217728:134217728 --ulimit nofile=1024:1024 \
  --tmpfs /scratch:rw,exec,nosuid,nodev,size=3g,mode=1777 \
  --mount "type=bind,src=$area/source,dst=/source,readonly" \
  --mount "type=bind,src=$root/node_modules,dst=/deps/node_modules,readonly" \
  --mount "type=bind,src=$root/.ci-sdk/node_modules,dst=/sdk/node_modules,readonly" \
  --mount "type=bind,src=$HOME/.npm/_cacache,dst=/cache/_cacache,readonly" \
  --mount "type=bind,src=$RUNNER_TEMP/sfw,dst=/tooling/sfw,readonly" \
  --mount type=bind,src=/usr,dst=/usr,readonly --mount type=bind,src=/opt,dst=/opt,readonly \
  --mount type=bind,src=/etc/alternatives,dst=/etc/alternatives,readonly \
  --mount type=bind,src=/etc/ssl,dst=/etc/ssl,readonly \
  --mount type=bind,src=/etc/ld.so.cache,dst=/etc/ld.so.cache,readonly \
  "$image" /usr/bin/env -i "PATH=$path" HOME=/scratch/home TMPDIR=/scratch/tmp \
  npm_config_cache=/scratch/npm npm_config_offline=true PI_PACKED_NPM_CACHE=/scratch/npm \
  npm_config_userconfig=/scratch/user-npmrc npm_config_globalconfig=/scratch/global-npmrc \
  PI_POTETO_SKILLS_ROOT=/scratch/observer-skills PI_OBSERVABILITY_SDK_MODULES=/sdk/node_modules \
  PYTHONDONTWRITEBYTECODE=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid \
  GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid \
  /bin/bash -euo pipefail -c '
mkdir -p /scratch/home /scratch/tmp /scratch/npm /scratch/evidence
touch /scratch/user-npmrc /scratch/global-npmrc
preserve() {
  status=$?
  cp -a /scratch/work/.driver/test-gate-evidence /scratch/evidence/gate 2>/dev/null || true
  python3 - <<'"'"'PY'"'"'
import base64, io, pathlib, zipfile
area=pathlib.Path("/scratch/evidence")
b=io.BytesIO()
with zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED) as z:
 for p in area.rglob("*"):
  if p.is_file():
   assert p.stat().st_size < 8*1024*1024
   z.writestr(str(p.relative_to(area)),p.read_bytes())
assert len(b.getvalue()) < 8*1024*1024
print("OBSERVABILITY_EVIDENCE_BASE64 "+base64.b64encode(b.getvalue()).decode(),flush=True)
PY
  exit "$status"
}
trap preserve EXIT
python3 - <<'"'"'PY'"'"' | tee /scratch/evidence/canaries.log
import errno,json,os,pathlib,resource,socket
assert os.getuid()==65534
status=pathlib.Path("/proc/self/status").read_text()
assert "NoNewPrivs:\t1" in status and "CapEff:\t0000000000000000" in status
assert not pathlib.Path("/var/run/docker.sock").exists() and not pathlib.Path("/home").exists()
assert not any("TOKEN" in k or "SECRET" in k or k.startswith("ACTIONS_") for k in os.environ)
assert "extraheader" not in pathlib.Path("/source/.git/config").read_text().lower()
for p in ("/source/package.json","/deps/node_modules","/sdk/node_modules","/usr"):
 assert os.statvfs(p).f_flag & os.ST_RDONLY
assert {n for _,n in socket.if_nameindex()}=={"lo"}
try: socket.create_connection(("192.0.2.1",80),timeout=1)
except OSError as e: assert e.errno in (errno.ENETUNREACH,errno.EHOSTUNREACH)
else: raise AssertionError("network unexpectedly reachable")
c=pathlib.Path("/sys/fs/cgroup")
assert (c/"memory.max").read_text().strip()=="2147483648"
assert (c/"pids.max").read_text().strip()=="128"
assert (c/"cpu.max").read_text().split()==["200000","100000"]
assert resource.getrlimit(resource.RLIMIT_FSIZE)==(134217728,134217728)
assert os.statvfs("/scratch").f_blocks*os.statvfs("/scratch").f_frsize<=3221225472
print(json.dumps({"containment":"passed","uid":os.getuid(),"network":"none","cpus":2,"memory":2147483648,"pids":128}),flush=True)
PY
cp -a /source/. /scratch/work
ln -s /deps/node_modules /scratch/work/node_modules
cp -a /cache/_cacache /scratch/npm/_cacache
cd /scratch/work
# The trusted supervisor materializes exactly one neutral fixture. The frozen source is not hand-edited.
python3 - <<'"'"'PY'"'"' | tee /scratch/evidence/fixture-refresh.log
from pathlib import Path
import hashlib,re,subprocess
base="fed22542c7a5a0839f3bcca4024df80874ee27a7"
p="tests/test_task_skill_observability.mjs"
original=subprocess.check_output(["git","show",base+":"+p])
assert hashlib.sha256(original).hexdigest()=="1d5bb3a59a20444a7e2a0ae7233a932a53b5c352f55621c8b22cab8100a83282"
text=original.decode()
neutral,count=re.subn(r"/(?:Users|home)/[^\s\x27]+/pi-poteto-mode/skills/how-pi/SKILL\.md", "/scratch/observer-skills/how-pi/SKILL.md", text)
assert count==1
expected=neutral.encode()
current=Path(p).read_bytes()
assert current in (original,expected),"fixture differs beyond the exact approved path change"
Path(p).write_bytes(expected)
Path("/scratch/evidence/test_task_skill_observability.mjs").write_bytes(expected)
print("trusted-fixture-sha256="+hashlib.sha256(expected).hexdigest())
if current!=expected:
 subprocess.run(["git","add",p],check=True)
 subprocess.run(["git","-c","core.hooksPath=/dev/null","commit","-m","Materialize exact neutral fixture through CI supervisor"],check=True)
PY
python3 scripts/codebase_inventory.py --source-root /scratch/work
cp pipeline_output/codebase_inventory.jsonl /scratch/evidence/codebase_inventory.jsonl
sha256sum tests/test_task_skill_observability.mjs tests/test_task_skill_observability_qa.mjs tests/test_public_extension_set.mjs tests/fixtures/observability-* > /scratch/evidence/tests.before
python3 scripts/test_gate_runner.py --phase baseline --base fed22542c7a5a0839f3bcca4024df80874ee27a7 2>&1 | tee /scratch/evidence/baseline.log
python3 scripts/test_gate_runner.py --phase check --base fed22542c7a5a0839f3bcca4024df80874ee27a7 2>&1 | tee /scratch/evidence/current-gate.log
node --test --test-reporter=tap tests/test_task_skill_observability.mjs tests/test_task_skill_observability_qa.mjs tests/test_public_extension_set.mjs 2>&1 | tee /scratch/evidence/node.log
node tests/fixtures/observability-sdk.mjs 2>&1 | tee /scratch/evidence/sdk.log
python3 tests/fixtures/observability-public-dry-run.py 2>&1 | tee /scratch/evidence/public-dry-run.log
sha256sum tests/test_task_skill_observability.mjs tests/test_task_skill_observability_qa.mjs tests/test_public_extension_set.mjs tests/fixtures/observability-* > /scratch/evidence/tests.after
cmp /scratch/evidence/tests.before /scratch/evidence/tests.after
printf "PASS exact baseline/current/mutation, node tests, offline SDK fresh Pi, scoped private dry-run, immutable tests\n" | tee /scratch/evidence/result.txt
')
docker inspect "$id" --format '{{json .HostConfig}}' > "$area/host-controls.json"
set +e
timeout --signal=TERM --kill-after=10s 900 docker start --attach "$id" | head -c 16777216 | tee "$area/target.log"
client=${PIPESTATUS[0]}
set -e
stop
status=$(docker inspect "$id" --format '{{.State.ExitCode}}')
python3 - "$area" <<'PY'
import base64,io,pathlib,sys,zipfile
area=pathlib.Path(sys.argv[1]); prefix=b"OBSERVABILITY_EVIDENCE_BASE64 "
rows=[line[len(prefix):] for line in (area/"target.log").read_bytes().splitlines() if line.startswith(prefix)]
assert len(rows)==1,"missing single bounded evidence envelope"
data=base64.b64decode(rows[0],validate=True)
with zipfile.ZipFile(io.BytesIO(data)) as z:
 for n in z.namelist(): assert not pathlib.PurePosixPath(n).is_absolute() and ".." not in pathlib.PurePosixPath(n).parts
 z.extractall(area/"evidence")
PY
test "$client" -eq 0
test "$status" -eq 0
