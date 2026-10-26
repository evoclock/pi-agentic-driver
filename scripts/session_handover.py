#!/usr/bin/env python3
"""Single producer and validator for a source-index handover; never an authority record."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SECTIONS = ('goal', 'next_fix_plan_item', 'changed_files', 'state', 'next_step', 'open_items', 'decisions', 'Rejected')
LABELS = ('quoted', 'derived', 'unknown', 'conflicting')
SHA = re.compile(r'^[0-9a-f]{40}$')
FILE = re.compile(r'^(.+):([1-9][0-9]*)$')


def validate(data, root):
    if not isinstance(data, dict) or set(data) != {'schema', 'sections', 'checks'} or data['schema'] != 'session-handover.v1':
        raise ValueError('invalid handover schema')
    sections = data['sections']
    if not isinstance(sections, dict) or tuple(sections) != SECTIONS:
        raise ValueError('sections must appear in fixed order, including Rejected')
    for section, claims in sections.items():
        if not isinstance(claims, list) or (section in ('goal', 'next_fix_plan_item', 'next_step') and len(claims) != 1):
            raise ValueError(f'{section}: invalid claim count')
        for claim in claims:
            if not isinstance(claim, dict) or set(claim) != {'label', 'text', 'pointer'}:
                raise ValueError(f'{section}: claim needs label, text and pointer')
            if claim['label'] not in LABELS or not isinstance(claim['text'], str) or not claim['text'].strip():
                raise ValueError(f'{section}: invalid label or text')
            pointer = claim['pointer']
            if not isinstance(pointer, str) or not pointer:
                raise ValueError(f'{section}: missing pointer')
            match = FILE.fullmatch(pointer)
            if match:
                path = root / match[1]
                if path.is_absolute() and not path.is_relative_to(root):
                    raise ValueError(f'{section}: pointer outside root')
                if not path.resolve().is_relative_to(root.resolve()) or not path.is_file() or int(match[2]) > sum(1 for _ in path.open()):
                    raise ValueError(f'{section}: missing source line: {pointer}')
            elif SHA.fullmatch(pointer):
                if subprocess.run(['git', '-C', str(root), 'cat-file', '-e', pointer + '^{commit}'], capture_output=True).returncode:
                    raise ValueError(f'{section}: missing commit')
            elif '#entry=' in pointer:
                name, entry = pointer.split('#entry=', 1)
                match_entry = re.fullmatch(r'([^@]+)@([0-9a-f]{64})', entry)
                path = (root / name).resolve()
                if (not match_entry or not path.is_relative_to(root.resolve()) or not path.is_file()
                        or not any(isinstance(record, dict) and record.get('id') == match_entry[1]
                                   and hashlib.sha256(line).hexdigest() == match_entry[2]
                                   for line in path.open('rb')
                                   for record in [json.loads(line)])):
                    raise ValueError(f'{section}: missing or mismatched session entry')
            else:
                raise ValueError(f'{section}: unsupported pointer: {pointer}')
    # Imported handovers cannot claim host-proven checks. The sidecar is a local
    # observation, not signed evidence or authority; validate never certifies it.
    if data['checks'] != []:
        raise ValueError('imported checks cannot claim host provenance')


def load(path, root):
    data = json.loads(path.read_text())
    validate(data, root)
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('write', 'validate', 'consume'))
    parser.add_argument('path', type=Path, help='HANDOVER.json destination')
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--input', type=Path, help='JSON sections input for write')
    parser.add_argument('--check', nargs='+', help='optional host-executed check (write only)')
    args = parser.parse_args()
    root = args.root.resolve()
    path = args.path.resolve()
    if args.action == 'write':
        if not args.input or path.exists() or path.with_suffix(path.suffix + '.consumed').exists():
            raise ValueError('write needs input and a new handover path; do not overwrite an existing handover')
        sections = json.loads(args.input.read_text())
        data = {'schema': 'session-handover.v1', 'sections': sections, 'checks': []}
        validate(data, root)
        with path.open('x') as output:
            json.dump(data, output, indent=2)
            output.write('\n')
        if args.check:
            code = subprocess.run(args.check, cwd=root, check=False).returncode
            commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
            # Separate host observation: readers must not treat imported JSON as proof.
            with path.with_suffix(path.suffix + '.checks.json').open('x') as output:
                json.dump({'handover_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                           'command': args.check, 'exit_code': code, 'commit': commit}, output)
                output.write('\n')
    elif args.action == 'validate':
        load(path, root)
    else:
        load(path, root)
        marker = path.with_suffix(path.suffix + '.consumed')
        # Exclusive creation is atomic across workers. The marker is host-recorded, not model prose.
        with marker.open('x') as output:
            json.dump({'handover': str(path), 'pid': os.getpid()}, output)
            output.write('\n')
    print(f'{args.action}: {path}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(f'handover: {error}', file=sys.stderr)
        sys.exit(1)
