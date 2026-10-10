#!/usr/bin/env python3
"""Read-only validation of authored documentation and pinned source references."""
from pathlib import Path
from urllib.parse import unquote, urlparse
import hashlib
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'references/manifest.json').read_text())
errors = []
source_links = 0
local_links = 0
repos = {}
for repo in manifest['repositories']:
    path = ROOT / repo['path']
    try:
        sha = subprocess.check_output(['git', '-C', str(path), 'rev-parse', 'HEAD'], text=True).strip()
        status = subprocess.check_output(['git', '-C', str(path), 'status', '--porcelain'], text=True).strip()
        if sha != repo['commit']:
            errors.append(f"HEAD changed: {repo['name']}")
        if status:
            errors.append(f"Reference checkout changed: {repo['name']}")
        parsed = urlparse(repo['url'])
        repos[parsed.path.removesuffix('.git').strip('/')] = repo
    except (OSError, subprocess.CalledProcessError) as exc:
        errors.append(f"Unreadable repository {repo['name']}: {exc}")

# Papers are cited by identifier and address; their files are not kept in this repository.
for paper in manifest['papers']:
    if 'path' in paper:
        path = ROOT / paper['path']
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != paper['sha256']:
            errors.append(f"Paper hash mismatch: {paper['path']}")

documents = [ROOT / 'README.md', *sorted((ROOT / 'docs').rglob('*.md')),
             ROOT / 'prototypes/control-center/README.md']
for file in documents:
    if not file.is_file():
        errors.append(f"Missing document: {file.relative_to(ROOT)}")
        continue
    text = file.read_text()
    fences = re.findall(r'^\s*```', text, re.M)
    if len(fences) % 2:
        errors.append(f"Unclosed code fence: {file.relative_to(ROOT)}")
    for match in re.finditer(r'\[[^\]\n]+\]\(([^)\n]+)\)', text):
        target = match.group(1).strip().strip('<>')
        if target.startswith(('mailto:', '#')):
            continue
        url = urlparse(target)
        if url.scheme in ('http', 'https'):
            parsed = re.match(r'^/([^/]+/[^/]+)/blob/([0-9a-f]{40})/(.+)$', url.path)
            if url.netloc != 'github.com' or not parsed:
                continue
            project, commit, relative = parsed.groups()
            repo = repos.get(project)
            if not repo:
                continue
            source_links += 1
            if commit != repo['commit']:
                errors.append(f"Wrong commit in {file.name}: {target}")
            source = ROOT / repo['path'] / unquote(relative)
            if not source.is_file():
                errors.append(f"Missing source in {file.name}: {target}")
                continue
            line = re.match(r'L(\d+)(?:-L(\d+))?$', url.fragment)
            if line:
                count = len(source.read_text(errors='replace').splitlines())
                start = int(line.group(1))
                end = int(line.group(2) or start)
                if not (1 <= start <= end <= count):
                    errors.append(f"Invalid source line in {file.name}: {target} ({count} lines)")
        elif not url.scheme:
            local_links += 1
            if not (file.parent / unquote(url.path)).exists():
                errors.append(f"Broken local link in {file.relative_to(ROOT)}: {target}")

result = {'ok': not errors, 'documents': len(documents), 'localLinks': local_links,
          'pinnedSourceLinks': source_links, 'repositories': len(repos), 'errors': errors}
print(json.dumps(result, ensure_ascii=False, indent=2))
sys.exit(1 if errors else 0)
