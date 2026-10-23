#!/usr/bin/env python3
"""Render versioned stats + highlights as a calm, local PNG via librsvg."""
import html
import json
from pathlib import Path
import subprocess
import sys


def render(stats_path, highlights_path, options_path, destination):
    stats = json.loads(Path(stats_path).read_text())
    highlights = json.loads(Path(highlights_path).read_text())
    options = json.loads(Path(options_path).read_text())
    if stats.get('schema') != 'weekly-build-recap.v1' or highlights.get('schema') != 'weekly-build-recap.highlights.v1' or options.get('schema') != 'weekly-build-recap.render.v1':
        raise ValueError('unsupported render input schema')
    lines = highlights['lines']
    if len(lines) != len(stats['repos']) or len(lines) > 22:
        raise ValueError('repo lines do not fit image')
    palette = options['palette']
    accents = [palette['accents'][key] for key in palette['headline']]
    primary, secondary, _, muted, _, cream = palette['chrome']
    background = palette['background']
    if options['theme'] == 'dark':
        background, primary, secondary, muted = primary, cream, cream, cream
    shapes = [f'<rect width="1600" height="900" fill="{background}"/>']
    font = "'Geist Sans','Geist','Helvetica Neue',sans-serif"

    def text(value, x, y, size, fill, weight='400'):
        shapes.append(f'<text x="{x}" y="{y}" fill="{fill}" font-size="{size}" font-weight="{weight}" font-family="{font}">{html.escape(str(value))}</text>')

    text('WEEKLY BUILD RECAP', 90, 92, 27, primary, '700')
    text(f"{stats['since']} to {stats['until']} UTC", 90, 125, 18, muted)
    for i, (value, label) in enumerate([(stats['counts']['commits'], 'COMMITS'), (stats['counts']['prs_opened'], 'OPENED'), (stats['counts']['prs_merged'], 'MERGED'), (stats['counts']['repos'], 'REPOS')]):
        x = 90 + i * 370
        text(value, x, 219, 52, accents[i % 3], '700')
        text(label, x, 250, 16, secondary, '600')
    shapes.append(f'<path d="M90 276 H1510" stroke="{cream}" stroke-width="2"/>')
    spacing = min(48, 440 / max(1, len(lines)))
    size = 14 if spacing >= 30 else 12
    for i, line in enumerate(lines):
        y = 310 + i * spacing
        if len(line) > 190:
            raise ValueError('repo line exceeds image width; refusing to truncate')
        shapes.append(f'<path d="M78 {y-20} V{y+5}" stroke="{accents[i % 3]}" stroke-width="3"/>')
        text(line, 90, y, size, primary)
    text('HOW  ' + stats['method'], 90, 765, 16, secondary)
    if options['note']:
        shapes.append(f'<rect x="89" y="788" width="1422" height="51" fill="none" stroke="{cream}" stroke-width="2"/>')
        text('NOTE  ' + options['note'], 103, 820, 17, primary)
    text('Counts reflect the selected UTC window; unique authored commits, not lines of code.', 90, 874, 14, muted)
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">' + ''.join(shapes) + '</svg>'
    subprocess.run(['rsvg-convert', '-o', str(destination)], input=svg, text=True, check=True)


if __name__ == '__main__':
    render(*sys.argv[1:])
