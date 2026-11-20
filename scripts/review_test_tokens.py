"""Read-only adapter to the host gate's existing test-token preservation check."""
import subprocess
import sys
from pathlib import Path
from test_gate_runner import preserve_test_tokens, is_test_path, Blocked


def check(base: str) -> None:
    paths = subprocess.check_output(
        ['git', 'diff', '--name-only', '-z', base, '--'], text=True
    ).split('\0')
    for name in filter(None, paths):
        if not is_test_path(name):
            continue
        old = subprocess.run(['git', 'show', f'{base}:{name}'], capture_output=True, text=True)
        if old.returncode:
            continue  # New tests have no inherited tokens to preserve.
        path = Path(name)
        preserve_test_tokens(old.stdout, path.read_text() if path.is_file() else '', name)


if __name__ == '__main__':
    try:
        check(sys.argv[1] if len(sys.argv) > 1 else 'origin/main')
        print('native test-token check: OK')
    except (Blocked, OSError, subprocess.CalledProcessError) as error:
        print(f'BLOCKED: {error}', file=sys.stderr)
        sys.exit(3)
