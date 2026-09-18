"""Check the published research snapshot, without accessing original data."""
from pathlib import Path
import hashlib,json,re,sys
from urllib.parse import unquote

HERE=Path(__file__).resolve().parent
REPO=HERE.parent.parent
manifest=json.loads((HERE/'manifest.json').read_text())
errors=[];published=[]
for row in manifest['files']:
    if row['status']!='published':continue
    path=HERE/row['published'];published.append(path)
    if not path.is_file():errors.append(f'Missing published artifact: {row["published"]}');continue
    if path.is_symlink():errors.append(f'Symlink in archive: {path}')
    actual=hashlib.sha256(path.read_bytes()).hexdigest()
    if actual!=row['publishedSha256']:errors.append(f'Publication hash mismatch: {row["published"]}')
    if path.suffix in {'.db','.sqlite','.sqlite3','.jsonl'}:errors.append(f'Bulk operational file in archive: {path}')
    if path.suffix=='.json':
        try:json.loads(path.read_text())
        except Exception as exc:errors.append(f'Invalid JSON: {path}: {exc}')
for path in HERE.rglob('*.md'):
    # Archived commands are historical examples, not Markdown navigation.
    text=re.sub(r'```.*?```','',path.read_text(),flags=re.S)
    for target in re.findall(r'\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)',text):
        target=target.strip('<>')
        if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:',target) or target.startswith('#'):continue
        target=unquote(target.split('#')[0])
        if not target:continue
        resolved=(REPO/target.lstrip('/')) if target.startswith('/') else (path.parent/target)
        if not resolved.exists():errors.append(f'Broken Markdown link: {path.relative_to(HERE)} -> {target}')
actual={p for p in (HERE/'archive').rglob('*') if p.is_file()}
if actual!=set(published):errors.append(f'Manifest/archive file mismatch: unlisted={len(actual-set(published))}, missing={len(set(published)-actual)}')
if errors:
    print('\n'.join(errors));sys.exit(1)
print(f'OK: {len(published)} published artifacts; hashes, JSON, Markdown targets and archive scope verified.')
