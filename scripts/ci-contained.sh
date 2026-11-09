#!/usr/bin/env bash
set -euo pipefail

# The parent owns mounts and limits; target code receives no Docker socket.
mode=${1:?expected gate, types, durable, or scan}
case "$mode" in gate|types|durable|scan) ;; *) exit 64;; esac
if [[ "$mode" == types ]]; then
  [[ $# == 5 && $2 == -- && $3 == python3 && $4 == scripts/check_readme_release_status.py && $5 == --if-release-branch ]] || exit 64
else
  [[ $# == 1 ]] || exit 64
fi
root=$(git rev-parse --show-toplevel)
area="$root/.ci-contained"
mkdir -p "$area/home" "$area/image/etc" "$area/image/scratch" "$area/image/source" "$area/image/deps/janus/node_modules" "$area/image/cache" "$area/image/tooling" "$area/image/usr" "$area/image/opt"
head=$(git rev-parse HEAD)
base=$(git rev-parse origin/main)
branch=${GITHUB_HEAD_REF:-$(git branch --show-current)}
branch=${branch:-ci-detached}
mkdir -p "$area/source"
git archive "$head" | tar -xf - -C "$area/source"
env -i PATH="$PATH" HOME="$area/home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git init --template= "$area/source"
git pack-objects --all --stdout | git -C "$area/source" index-pack --stdin
git -C "$area/source" symbolic-ref HEAD "refs/heads/$branch"
git -C "$area/source" update-ref HEAD "$head"
git -C "$area/source" update-ref refs/remotes/origin/main "$base"
git -C "$area/source" read-tree "$head"
printf 'fixture:x:65534:65534::/scratch/home:/bin/bash\n' > "$area/image/etc/passwd"
printf 'fixture:x:65534:\n' > "$area/image/etc/group"
for name in bin sbin lib lib64; do ln -s "usr/$name" "$area/image/$name"; done
mkdir -p "$area/image/etc/alternatives" "$area/image/etc/ssl"
printf '' > "$area/image/etc/ld.so.cache"
tar -C "$area/image" -cf "$area/rootfs.tar" .
image=$(docker import "$area/rootfs.tar")
name="ci-contained-${GITHUB_RUN_ID:-local}-${mode}-${GITHUB_RUN_ATTEMPT:-1}"
nodebin=$(dirname "$(readlink -f "$(command -v node)")")
pythonbin=$(dirname "$(readlink -f "$(command -v python3)")")
path="$nodebin:$pythonbin:/tooling:/usr/local/bin:/usr/bin:/bin"
cache="${HOME}/.npm/_cacache"
test -d "$cache"
test -x "${RUNNER_TEMP}/sfw"
args=(--name "$name" --network none --read-only --cap-drop ALL --security-opt no-new-privileges
  --user 65534:65534 --pids-limit 128 --memory 2g --memory-swap 2g --cpus 2
  --ulimit fsize=134217728:134217728 --ulimit nofile=1024:1024
  --tmpfs /scratch:rw,exec,nosuid,nodev,size=3g,mode=1777
  --mount "type=bind,src=$area/source,dst=/source,readonly"
  --mount "type=bind,src=$root/node_modules,dst=/deps/node_modules,readonly"
  --mount "type=bind,src=$root/janus/node_modules,dst=/deps/janus/node_modules,readonly"
  --mount "type=bind,src=$cache,dst=/cache/_cacache,readonly"
  --mount "type=bind,src=${RUNNER_TEMP}/sfw,dst=/tooling/sfw,readonly"
  --mount "type=bind,src=$root/scripts/ci-contained.sh,dst=/tooling/launcher,readonly"
  --mount type=bind,src=/usr,dst=/usr,readonly
  --mount type=bind,src=/opt,dst=/opt,readonly
  --mount type=bind,src=/etc/alternatives,dst=/etc/alternatives,readonly
  --mount type=bind,src=/etc/ssl,dst=/etc/ssl,readonly
  --mount type=bind,src=/etc/ld.so.cache,dst=/etc/ld.so.cache,readonly
  --env "PATH=$path" --env HOME=/scratch/home --env TMPDIR=/scratch/tmp
  --env npm_config_cache=/scratch/npm --env npm_config_offline=true --env PI_PACKED_NPM_CACHE=/scratch/npm
  --env npm_config_userconfig=/scratch/user-npmrc --env npm_config_globalconfig=/scratch/global-npmrc
  --env PYTHONDONTWRITEBYTECODE=1 --env GIT_CONFIG_NOSYSTEM=1 --env GIT_CONFIG_GLOBAL=/dev/null
  --env GIT_AUTHOR_NAME=fixture --env GIT_AUTHOR_EMAIL=fixture@example.invalid
  --env GIT_COMMITTER_NAME=fixture --env GIT_COMMITTER_EMAIL=fixture@example.invalid
  --env GIT_CONFIG_COUNT=1 --env GIT_CONFIG_KEY_0=init.defaultBranch --env GIT_CONFIG_VALUE_0=main)
stop() { docker stop --time 5 "$name" >/dev/null 2>&1 || true; }
trap stop EXIT INT TERM
command=(/usr/bin/env -i "PATH=$path" HOME=/scratch/home TMPDIR=/scratch/tmp
  npm_config_cache=/scratch/npm npm_config_offline=true PI_PACKED_NPM_CACHE=/scratch/npm npm_config_userconfig=/scratch/user-npmrc npm_config_globalconfig=/scratch/global-npmrc
  PYTHONDONTWRITEBYTECODE=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
  GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=init.defaultBranch GIT_CONFIG_VALUE_0=main
  /bin/bash -euo pipefail -c '
    mkdir -p /scratch/home /scratch/tmp /scratch/npm
    touch /scratch/user-npmrc /scratch/global-npmrc
    python3 - <<'"'"'PY'"'"'
import errno, json, os, pathlib, resource, socket
assert os.getuid() == 65534
assert "NoNewPrivs:\t1" in pathlib.Path("/proc/self/status").read_text()
assert "CapEff:\t0000000000000000" in pathlib.Path("/proc/self/status").read_text()
assert not pathlib.Path("/var/run/docker.sock").exists()
assert not pathlib.Path("/home").exists()
assert "extraheader" not in pathlib.Path("/source/.git/config").read_text().lower()
assert not any("TOKEN" in key or "SECRET" in key or key.startswith("ACTIONS_") for key in os.environ)
for path in ("/source/package.json", "/usr/containment-canary"):
    try:
        with open(path, "a") as stream: stream.write("unsafe")
    except OSError as error:
        assert error.errno in (errno.EROFS, errno.EACCES)
    else:
        raise AssertionError("read-only mount allowed a write")
try:
    socket.create_connection(("192.0.2.1", 80), timeout=1)
except OSError as error:
    assert error.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH), repr(error)
else:
    raise AssertionError("external network unexpectedly reachable")
cgroup = pathlib.Path("/sys/fs/cgroup")
assert int((cgroup / "memory.max").read_text()) == 2147483648
assert int((cgroup / "pids.max").read_text()) == 128
assert (cgroup / "cpu.max").read_text().split() == ["200000", "100000"]
assert resource.getrlimit(resource.RLIMIT_FSIZE) == (134217728, 134217728)
assert os.statvfs("/scratch").f_blocks * os.statvfs("/scratch").f_frsize <= 3221225472
pathlib.Path("/scratch/canary").write_text("scratch write allowed")
print(json.dumps({"containment": "passed", "uid": os.getuid(), "network": "denied", "source": "read-only", "memoryBytes": 2147483648, "pids": 128, "cpus": 2, "scratchBytes": 3221225472}), flush=True)
PY
    cp -a /source/. /scratch/work
    ln -s /deps/node_modules /scratch/work/node_modules
    ln -s /deps/janus/node_modules /scratch/work/janus/node_modules
    cp -a /cache/_cacache /scratch/npm/_cacache
    cd /scratch/work
    preserve_evidence() {
      result=$?
      if [[ -f .driver/test-gate-evidence/checks.jsonl ]]; then
        printf "\nTEST_GATE_EVIDENCE_BASE64 "
        base64 -w0 .driver/test-gate-evidence/checks.jsonl
        printf "\n"
      fi
      exit "$result"
    }
    trap preserve_evidence EXIT
    case "$1" in
      gate)
        if [[ "$(git branch --show-current)" == feat/task-skill-observability ]] && git merge-base --is-ancestor fed22542c7a5a0839f3bcca4024df80874ee27a7 HEAD; then
          export PI_POTETO_SKILLS_ROOT=/scratch/observer-skills
          python3 scripts/test_gate_runner.py --phase baseline --base fed22542c7a5a0839f3bcca4024df80874ee27a7
          python3 scripts/test_gate_runner.py --phase check --base fed22542c7a5a0839f3bcca4024df80874ee27a7
          make gate
        else
          make test-gate
          make gate
        fi;;
      durable) npm run test:ci;;
      types)
        janus/node_modules/.bin/tsc --noEmit -p janus/tsconfig.json
        node --test tests/test_aidr_writing_review.mjs tests/test_pr_review_gate.mjs tests/test_public_pr_wording.mjs tests/test_spawn_ceremony_check.mjs
        (cd janus && npm test)
        python3 -m unittest discover -s tests -p "test_*.py"
        python3 -m unittest discover -s skills/weekly-build-recap -p "test_*.py"
        shift 2
        "$@";;
      scan) python3 scripts/treehouse_codepath_scan.py; bash .buildkite/public-scan.sh;;
    esac
  ' -- "$@")
id=$(docker create "${args[@]}" "$image" "${command[@]}")
docker inspect "$id" --format '{{json .HostConfig}}' > "$area/host-controls.json"
set +e
timeout --signal=TERM --kill-after=10s 900 docker start --attach "$id" | head -c 16777216 | tee "$area/target.log"
client_status=${PIPESTATUS[0]}
set -e
stop
status=$(docker inspect "$id" --format '{{.State.ExitCode}}')
if [[ "$mode" == gate ]]; then
  python3 -c '
import base64, json, pathlib, sys
prefix = b"TEST_GATE_EVIDENCE_BASE64 "
rows = pathlib.Path(sys.argv[1]).read_bytes().splitlines()
encoded = [row[len(prefix):] for row in rows if row.startswith(prefix)]
assert len(encoded) == 1
content = base64.b64decode(encoded[0], validate=True)
assert 0 < len(content) <= 16777216
for row in content.splitlines():
    assert isinstance(json.loads(row), dict)
pathlib.Path(sys.argv[2]).write_bytes(content)
' "$area/target.log" "$area/checks.jsonl"
fi
test "$client_status" -eq 0 || exit "$client_status"
test "$status" -eq 0
