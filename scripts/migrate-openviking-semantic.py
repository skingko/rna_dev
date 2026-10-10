#!/usr/bin/env python3
"""Preserve an OpenViking tenant using its official backup/restore APIs.

No raw filesystem/index copy, source deletion, or credentials in argv/output.
The caller must stop application writers before backup and keep them stopped
until the target has been verified and client credentials have been switched.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'deploy/openviking/.runtime'
REMOTE = '''import base64,json,sys,urllib.request,urllib.error
x=json.load(sys.stdin)
r=urllib.request.Request('http://127.0.0.1:1933'+x['path'],method=x['method'],headers=x['headers'],data=base64.b64decode(x['body']) if x.get('body') is not None else None)
try:
 with urllib.request.urlopen(r,timeout=600) as f:
  b=f.read(64*1024*1024+1)
  if len(b)>64*1024*1024: raise ValueError('response_too_large')
  print(json.dumps({'status':f.status,'body':base64.b64encode(b).decode()}))
except urllib.error.HTTPError as e:
 print(json.dumps({'status':e.code}))
except Exception as e:
 print(json.dumps({'error':type(e).__name__}))
'''


def private_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + '.tmp-' + secrets.token_hex(8))
    try:
        with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def request(container, client, path, body=None, content_type='application/json'):
    relay = json.loads((RUNTIME / 'relay.json').read_text())
    key = json.loads(client.read_text())['api_key']
    if isinstance(body, dict):
        body = json.dumps(body).encode()
    payload = {'path': path, 'method': 'POST' if body is not None else 'GET',
               'headers': {'X-API-Key': key, 'Content-Type': content_type},
               'body': base64.b64encode(body).decode() if body is not None else None}
    env = {k: v for k, v in os.environ.items() if k not in ('DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
    proc = subprocess.run([relay['dockerExecutable'], '--host', relay['dockerHost'], 'exec', '-i',
                           container, 'python', '-c', REMOTE], input=json.dumps(payload),
                          capture_output=True, text=True, timeout=630, env=env)
    if proc.returncode:
        raise RuntimeError('Docker transport failed (output suppressed)')
    value = json.loads(proc.stdout)
    if value.get('status') != 200:
        raise RuntimeError('OpenViking migration request failed: HTTP ' + str(value.get('status', 'unavailable')))
    return base64.b64decode(value['body'])


def manifest(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        manifests = [n for n in names if n.endswith('/_ovpack/manifest.json')]
        if len(manifests) != 1:
            raise RuntimeError('Expected one official OVPack manifest')
        value = json.loads(archive.read(manifests[0]))
        if (value.get('kind') != 'openviking.ovpack' or value.get('format_version') != 3
                or value.get('root', {}).get('package_type') != 'backup'
                or value.get('root', {}).get('uri') != 'viking://'):
            raise RuntimeError('Expected an official full tenant OVPack v3 backup')
        if any(n.endswith('/dense.f32') for n in names):
            raise RuntimeError('Refusing a migration package containing old embedding vectors')
        files = [n for n in names if '/files/' in n and not n.endswith('/')]
        return {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'bytes': path.stat().st_size, 'files': len(files),
                'formatVersion': value.get('format_version'), 'containsVectors': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'restore', 'inspect', 'compare'])
    parser.add_argument('--file', type=Path, required=True)
    parser.add_argument('--against', type=Path)
    parser.add_argument('--container')
    parser.add_argument('--client', type=Path)
    parser.add_argument('--writers-stopped', action='store_true')
    parser.add_argument('--new-empty-target', action='store_true')
    args = parser.parse_args()
    if args.action not in ('inspect', 'compare'):
        if not args.writers_stopped or not args.client or not args.container:
            parser.error('Explicit stopped writers, container, and private client file are required')
        if not args.container.startswith('rna-openviking'):
            parser.error('Only dedicated Rna OpenViking containers are allowed')
    if args.action == 'backup':
        if args.file.exists():
            raise RuntimeError('Backup already exists; choose a new path')
        data = request(args.container, args.client, '/api/v1/pack/backup', {'include_vectors': False})
        private_write(args.file, data)
    result = manifest(args.file)
    if args.action == 'compare':
        if not args.against:
            parser.error('A target backup is required for comparison')
        manifest(args.against)
        def content_hashes(path):
            with zipfile.ZipFile(path) as archive:
                return {n.split('/files/', 1)[1]: hashlib.sha256(archive.read(n)).hexdigest()
                        for n in archive.namelist() if '/files/' in n and not n.endswith('/')}
        source, target = content_hashes(args.file), content_hashes(args.against)
        missing = [p for p in source if p not in target]
        changed = [p for p in source if p in target and source[p] != target[p]]
        result.update({'sourceFiles': len(source), 'targetFiles': len(target),
                       'missingFiles': len(missing), 'changedFiles': len(changed),
                       'originalBytesPreserved': not missing and not changed})
        if missing or changed:
            raise RuntimeError('Restored content mismatch: ' + str(len(missing)) + ' missing, ' + str(len(changed)) + ' changed')
    if args.action == 'restore':
        if not args.new_empty_target:
            parser.error('Restore overwrite is allowed only for an explicitly verified new empty tenant')
        boundary = 'rna-pack-' + secrets.token_hex(24)
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="migration.ovpack"\r\n'
                'Content-Type: application/zip\r\n\r\n').encode() + args.file.read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
        uploaded = json.loads(request(args.container, args.client, '/api/v1/resources/temp_upload', body,
                                      'multipart/form-data; boundary=' + boundary))
        temp_id = uploaded['result']['temp_file_id']
        restored = json.loads(request(args.container, args.client, '/api/v1/pack/restore',
                                     {'temp_file_id': temp_id, 'on_conflict': 'overwrite', 'vector_mode': 'recompute'}))
        if restored.get('status') != 'ok':
            raise RuntimeError('OpenViking did not confirm restore')
        result['restored'] = True
        result['vectorMode'] = 'recompute'
    print(json.dumps({'action': args.action, **result}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never include provider bodies, subprocess stderr, or credential data.
        print('Migration failed: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
