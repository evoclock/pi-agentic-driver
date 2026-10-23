#!/usr/bin/env python3
"""Read-only GitHub recap collector and draft assembler; no third-party dependencies."""
import argparse
import datetime as dt
import json
from pathlib import Path
import re
import subprocess
import sys

SCHEMA = 'weekly-build-recap.v1'
BANNED = ('various improvements', 'continued work', 'miscellaneous updates', 'general improvements', 'lots of work')
BANNED_LOCAL = Path(__file__).with_name('banned.local.json')


def banned_phrases():
    if not BANNED_LOCAL.exists():
        return BANNED
    phrases = json.loads(BANNED_LOCAL.read_text())
    if not isinstance(phrases, list) or any(not isinstance(p, str) or not p.strip() for p in phrases):
        raise ValueError('banned.local.json must contain a list of nonempty phrases')
    return (*BANNED, *(p.lower() for p in phrases))
HIGHLIGHTS_SCHEMA = 'weekly-build-recap.highlights.v1'
CONFIG = Path(__file__).with_name('config.json')


def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', path], text=True))


def pages(path):
    result = []
    for page in range(1, 101):
        separator = '&' if '?' in path else '?'
        batch = api(f'{path}{separator}per_page=100&page={page}')
        if not isinstance(batch, list):
            raise ValueError('expected a list from GitHub')
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise ValueError('pagination limit reached; refusing incomplete counts')


def meaningful_readme(text, description):
    for paragraph in re.split(r'\n\s*\n', text or ''):
        line = re.sub(r'[#*`>\[\]()]', '', paragraph).strip().replace('\n', ' ')
        if len(line) >= 35 and not line.startswith(('http', '!', '<', '---')):
            return line[:180]
    return (description or 'No project description available.').strip()[:180]


def count_commits(repo, identities, since, until):
    owner, name = repo['full_name'].split('/')
    branches = pages(f'repos/{owner}/{name}/branches')
    all_shas, default_shas = set(), set()
    for branch in branches:
        import urllib.parse
        ref = urllib.parse.quote(branch['name'], safe='')
        commits = pages(f'repos/{owner}/{name}/commits?sha={ref}&since={since}&until={until}')
        eligible = {c['sha'] for c in commits if (c.get('author') or {}).get('login', '').lower() in identities or
                    (c.get('commit', {}).get('author', {}).get('email') or '').lower() in identities or
                    (c.get('commit', {}).get('author', {}).get('name') or '').lower() in identities}
        if repo.get('fork') and repo.get('parent'):
            parent = repo['parent']
            # Only commits not reachable from the parent's default branch are local work.
            compare = api(f"repos/{parent['full_name']}/compare/{urllib.parse.quote(parent['default_branch'], safe='')}...{owner}:{ref}")
            if compare.get('total_commits', 0) > len(compare.get('commits', [])):
                raise ValueError('fork comparison truncated; refusing incomplete counts')
            eligible &= {c['sha'] for c in compare.get('commits', [])}
        all_shas.update(eligible)
        if branch['name'] == repo['default_branch']:
            default_shas.update(eligible)
    return all_shas, default_shas


def search_prs(login, field, since, until):
    import urllib.parse
    query = f'user:{login} is:pr {field}:{since}..{until}'
    if field == 'merged':
        query += ' is:merged'
    path = 'search/issues?q=' + urllib.parse.quote(query, safe='')
    result = []
    for page in range(1, 11):
        data = api(f'{path}&per_page=100&page={page}')
        if data['total_count'] > 1000:
            raise ValueError('PR search exceeds GitHub 1000-result limit')
        result.extend(data['items'])
        if len(result) >= data['total_count']:
            return result
    raise ValueError('PR search pagination incomplete')


def collect(login, identities, since, until):
    import base64
    repos = pages('user/repos?affiliation=owner' if api('user')['login'].lower() == login.lower() else f'users/{login}/repos?type=owner')
    def grouped(items):
        result = {}
        for item in items:
            name = item['repository_url'].split('/repos/', 1)[-1]
            result.setdefault(name, []).append(item)
        return result
    opened_by_repo = grouped(search_prs(login, 'created', since, until))
    merged_by_repo = grouped(search_prs(login, 'merged', since, until))
    output, all_shas, default_shas = [], set(), set()
    opened, merged = 0, 0
    for repo0 in repos:
        if repo0.get('pushed_at', '')[:10] < since and repo0['full_name'] not in opened_by_repo and repo0['full_name'] not in merged_by_repo:
            continue
        owner, name = repo0['full_name'].split('/')
        repo = api(f'repos/{owner}/{name}')
        opened_prs = opened_by_repo.get(repo['full_name'], [])
        merged_prs_here = merged_by_repo.get(repo['full_name'], [])
        shas, defaults = count_commits(repo, identities, since + 'T00:00:00Z', until + 'T23:59:59Z')
        all_shas.update(shas)
        default_shas.update(defaults)
        if not (shas or opened_prs or merged_prs_here):
            continue
        try:
            readme = api(f'repos/{owner}/{name}/readme')
            text = base64.b64decode(readme['content']).decode('utf-8', errors='replace')
        except subprocess.CalledProcessError:
            text = ''
        titles = [p['title'].strip() for p in merged_prs_here]
        output.append({'name': repo['full_name'], 'url': repo['html_url'],
                       'description': meaningful_readme(text, repo.get('description')),
                       'landed': titles, 'commits': len(shas), 'default_commits': len(defaults),
                       'prs_opened': len(opened_prs), 'prs_merged': len(merged_prs_here)})
        opened += len(opened_prs)
        merged += len(merged_prs_here)
    return {'schema': SCHEMA, 'account': login, 'since': since, 'until': until,
            'counts': {'commits': len(all_shas), 'default_commits': len(default_shas),
                       'prs_opened': opened, 'prs_merged': merged, 'repos': len(output)},
            'repos': output, 'method': 'Unique authored SHAs across branches; fork commits exclude parent history. PRs by creation/merge date (UTC); default-branch SHAs counted separately.'}


def validate(stats):
    if stats.get('schema') != SCHEMA or not isinstance(stats.get('repos'), list):
        raise ValueError('unsupported stats schema')
    for key in ('commits', 'default_commits', 'prs_opened', 'prs_merged', 'repos'):
        if type(stats['counts'][key]) is not int or stats['counts'][key] < 0:
            raise ValueError('invalid count')
    if stats['counts']['repos'] != len(stats['repos']):
        raise ValueError('repo count mismatch')
    for repo in stats['repos']:
        for text in (repo['description'], *repo['landed']):
            if any(phrase in text.lower() for phrase in banned_phrases()):
                raise ValueError('banned recap phrase: ' + text)


def shorten(text, limit):
    if len(text) <= limit:
        return text
    return text[:limit - 1].rsplit(' ', 1)[0].rstrip(' ,:') + '…'


def drafts(stats, note=''):
    validate(stats)
    c = stats['counts']
    headline = f"This week: {c['commits']} commits, {c['prs_opened']} PRs opened, {c['prs_merged']} merged across {c['repos']} repos."
    lines = []
    for r in stats['repos']:
        landed = ', '.join(shorten(title, 32) for title in r['landed'][:2])
        if len(r['landed']) > 2:
            landed += f" (+{len(r['landed']) - 2} more merged PRs)"
        lines.append(f"{r['name']}: {shorten(r['description'], 42)} Landed: {landed or 'No merged PRs in this window.'}")
    x = headline
    for line in lines:
        if len(x + '\n' + line) <= 280:
            x += '\n' + line
    if len(x) > 280:
        raise ValueError('X post exceeds 280 characters')
    linkedin = '\n'.join([headline, *lines, stats['method'], note]).strip()
    for text in (headline, *lines, x, linkedin):
        if any(phrase in text.lower() for phrase in banned_phrases()):
            raise ValueError('banned recap phrase')
    return {'headline': headline, 'lines': lines, 'x': x, 'linkedin': linkedin}


def main():
    p = argparse.ArgumentParser(description='Read-only weekly recap; writes drafts only')
    p.add_argument('--account', help='GitHub account (default: config owner)')
    p.add_argument('--config', type=Path, default=CONFIG, help='Versioned owner, author and palette config')
    p.add_argument('--author', action='append', default=[], help='GitHub login, author email or name; repeat for bots')
    p.add_argument('--days', type=int, default=7)
    p.add_argument('--since'); p.add_argument('--until')
    p.add_argument('--stats-input', type=Path, help='Use pre-fetched or external v1 stats JSON instead of collecting')
    p.add_argument('--highlights-input', type=Path, help='Use external v1 highlights JSON')
    p.add_argument('--renderer', default='svg', choices=['svg', 'none'])
    p.add_argument('--theme', choices=['light', 'dark'], help='Theme override')
    p.add_argument('--palette', help='Named preset from config; default neutral')
    p.add_argument('--note', default='')
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.days < 1 or bool(a.since) != bool(a.until):
        p.error('provide both --since and --until, or positive --days')
    config = json.loads(a.config.read_text())
    if config.get('schema') != 'weekly-build-recap.config.v1':
        p.error('unsupported config schema')
    if a.stats_input:
        stats = json.loads(a.stats_input.read_text())
    else:
        until = dt.date.fromisoformat(a.until) if a.until else dt.datetime.now(dt.timezone.utc).date()
        since = dt.date.fromisoformat(a.since) if a.since else until - dt.timedelta(days=a.days - 1)
        if since > until:
            p.error('since must not exceed until')
        login = a.account or config['owner'] or api('user')['login']
        stats = collect(login, {s.lower() for s in [login, *config['authors'], *a.author]}, since.isoformat(), until.isoformat())
    name = a.palette or config['default_palette']
    if name not in config['palettes']:
        p.error('unknown palette preset')
    palette = config['palettes'][name]
    if any(not re.fullmatch(r'#[0-9a-fA-F]{6}', color) for color in [*palette['accents'].values(), *palette['chrome'], palette['background']]):
        p.error('invalid palette color')
    data = drafts(stats, a.note)
    highlights = json.loads(a.highlights_input.read_text()) if a.highlights_input else {'schema': HIGHLIGHTS_SCHEMA, 'lines': data['lines']}
    if highlights.get('schema') != HIGHLIGHTS_SCHEMA or len(highlights.get('lines', [])) != len(stats['repos']):
        p.error('highlights schema or repo count mismatch')
    if any(any(phrase in line.lower() for phrase in banned_phrases()) for line in highlights['lines']):
        p.error('banned highlights phrase')
    data['lines'] = highlights['lines']
    a.output.mkdir(parents=True, exist_ok=True)
    for name, value in [('stats.json', stats), ('highlights.json', highlights), ('render.json', {'schema': 'weekly-build-recap.render.v1', 'note': a.note, 'palette': palette, 'theme': a.theme or config['default_theme']}), ('x.txt', data['x']), ('linkedin.txt', data['linkedin'])]:
        (a.output / name).write_text(json.dumps(value, indent=2) + '\n' if isinstance(value, dict) else value + '\n')
    if a.renderer == 'svg':
        subprocess.run([sys.executable, str(Path(__file__).with_name('render.py')), str(a.output / 'stats.json'), str(a.output / 'highlights.json'), str(a.output / 'render.json'), str(a.output / 'recap.png')], check=True)
        png = (a.output / 'recap.png').read_bytes()
        if png[:8] != b'\x89PNG\r\n\x1a\n' or int.from_bytes(png[16:20], 'big') != 1600 or int.from_bytes(png[20:24], 'big') != 900 or len(png) < 10000:
            raise ValueError('PNG dimensions or content invalid')
    print(json.dumps({'counts': stats['counts'], 'png': str(a.output / 'recap.png') if a.renderer == 'svg' else None}))


if __name__ == '__main__':
    main()
