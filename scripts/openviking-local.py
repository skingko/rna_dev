#!/usr/bin/env python3
"""Start/stop only the dedicated Rna OpenViking Compose project."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import urllib.request
import urllib.error
import socket
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy/openviking"
LEGACY_RUNTIME = DEPLOY / '.runtime'
RUNTIME = LEGACY_RUNTIME / 'semantic'
FIXTURE = False
NATIVE_EMBEDDING = False
SEMANTIC_CONTAINER = 'rna-openviking-semantic'
EMBEDDING_CONTAINER = 'rna-openviking-embedding'
MODEL = 'bge-m3:latest'
MODEL_DIGEST = 'sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab'
MODEL_VOLUME = 'rna-openviking-models-bge-m3-790764642607'
DATA_VOLUME = 'rna-openviking-semantic-bge-m3-1024-790764642607'
MODEL_IDENTITY = {'schemaVersion': 1, 'model': MODEL, 'dimension': 1024,
                  'manifestDigest': MODEL_DIGEST, 'dataVolume': DATA_VOLUME}


def container_name():
    return 'rna-openviking' if FIXTURE else SEMANTIC_CONTAINER


def write_private(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp-' + secrets.token_hex(8))
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            output.write(json.dumps(value, indent=2) + '\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def docker_engine(desktop):
    executable = shutil.which('docker')
    if not executable:
        raise RuntimeError('Docker executable is unavailable')
    executable = str(Path(executable).resolve())
    if desktop:
        # Pin the same engine for Compose, cp, and the HTTP relay. No operation
        # in relay mode may silently fall back to the shell Docker context.
        host = 'unix://' + str(Path.home() / 'Library/Containers/com.docker.docker/Data/docker.raw.sock')
        return executable, host
    return executable, None


def configure_helper():
    executable, host = docker_engine(True)
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    (RUNTIME / 'desktop-relay').touch(mode=0o600)
    config_path = RUNTIME / 'relay.json'
    config = {'schemaVersion': 1, 'dockerExecutable': executable, 'dockerHost': host,
              'container': container_name(), 'host': '127.0.0.1', 'port': 1933,
              'maxConcurrent': 8, 'ioTimeoutSeconds': 5, 'requestTimeoutSeconds': 80,
              'transportTimeoutSeconds': 70, 'upstreamTimeoutSeconds': 65,
              'maxBytes': 2_000_000, 'logPath': str(RUNTIME / 'relay.log'),
              'logMaxBytes': 1_048_576, 'logBackups': 3}
    write_private(config_path, config)
    descriptor = {'schemaVersion': 1, 'id': 'openviking-relay', 'command': str(Path(sys.executable).resolve()),
                  'args': [str(ROOT / 'scripts/openviking-docker-relay.py'), '--config', str(config_path)],
                  'cwd': str(ROOT), 'healthUrl': 'http://127.0.0.1:1933/_rna/health',
                  'healthIdentity': 'rna-helper-v1', 'healthTimeoutMs': 5000, 'startupGraceMs': 30000,
                  'configFingerprint': hashlib.sha256(config_path.read_bytes()).hexdigest()}
    write_private(RUNTIME / 'relay-helper.json', descriptor)
    return descriptor


def configure_embedding_helper(binary):
    if FIXTURE:
        raise RuntimeError('Native real embedding cannot be configured in fixture mode')
    if not binary or not Path(binary).is_absolute() or not Path(binary).is_file():
        raise RuntimeError('An existing absolute official Ollama binary path is required')
    config_path = RUNTIME / 'embedding-helper.json'
    config = {'schemaVersion': 1, 'binary': str(Path(binary).resolve()),
              'models': str(RUNTIME / 'ollama-models'), 'model': MODEL,
              'modelDigest': MODEL_DIGEST, 'ollamaHost': '127.0.0.1',
              'ollamaPort': 11434, 'healthPort': 11435,
              'logPath': str(RUNTIME / 'embedding-helper.log')}
    write_private(config_path, config)
    descriptor = {'schemaVersion': 1, 'id': 'openviking-embedding',
                  'command': str(Path(sys.executable).resolve()),
                  'args': [str(ROOT / 'scripts/openviking-embedding-helper.py'), '--config', str(config_path)],
                  'cwd': str(ROOT), 'healthUrl': 'http://127.0.0.1:11435/_rna/health',
                  'healthIdentity': 'rna-helper-v1', 'healthTimeoutMs': 5000, 'startupGraceMs': 90000,
                  'configFingerprint': hashlib.sha256(config_path.read_bytes()).hexdigest()}
    write_private(RUNTIME / 'embedding-helper-descriptor.json', descriptor)
    return descriptor


def relay_command():
    descriptor = json.loads((RUNTIME / 'relay-helper.json').read_text())
    return [descriptor['command'], *descriptor['args']]


def relay_bootstrap(callback):
    """Own a temporary foreground child for provisioning only; never detach it."""
    # An existing listener belongs to the supervisor or an earlier installation.
    # Reuse it for provisioning; never kill/adopt a process based on relay.pid.
    try:
        with socket.create_connection(('127.0.0.1', 1933), timeout=1):
            existing = True
    except OSError:
        existing = False
    child = None
    try:
        if existing and not (RUNTIME / 'rna-client.json').exists():
            raise RuntimeError('Cannot provision a new tenant through an existing unowned listener; stop its owner first')
        if not existing:
            child = subprocess.Popen(relay_command(), stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     env={**os.environ, 'RNA_RELAY_BOOTSTRAP_PARENT_PID': str(os.getpid())})
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if child and child.poll() is not None:
                raise RuntimeError('Temporary relay failed to start')
            try:
                with urllib.request.urlopen('http://127.0.0.1:1933/health', timeout=3) as response:
                    if json.load(response).get('healthy'):
                        return callback()
            except (OSError, ValueError):
                time.sleep(.25)
        raise RuntimeError('OpenViking did not become live for provisioning')
    finally:
        if child:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def configure_fixture():
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = RUNTIME / "ov.conf"
    if path.exists():
        return
    config = {
        "server": {"host": "0.0.0.0", "port": 1933, "root_api_key": secrets.token_urlsafe(32)},
        "storage": {"workspace": "/app/.openviking/data"},
        "memory": {"extraction_output_format": "json"},
        "embedding": {"dense": {"provider": "openai", "api_base": "http://model-fixture:8010/v1",
            "api_key": "protocol-fixture-not-a-secret", "model": "rna-fixture-embedding-64", "dimension": 64, "input": "text"}},
        "vlm": {"provider": "openai", "api_base": "http://model-fixture:8010/v1", "api_key": "protocol-fixture-not-a-secret",
            "model": "rna-fixture-summary", "max_retries": 1, "max_concurrent": 2},
    }
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(config, handle, indent=2)
    print("Created private test configuration; generated server credential is not printed.")


def configure():
    """Fail closed without real model configuration; never create a fixture."""
    if FIXTURE:
        return configure_fixture()
    source = RUNTIME / 'models.json'
    if not source.is_file():
        raise RuntimeError('Real memory requires private .runtime/semantic/models.json with a vlm configuration')
    if source.stat().st_mode & 0o077:
        raise RuntimeError('Model credentials must have file permissions 0600')
    supplied = json.loads(source.read_text())
    vlm = supplied.get('vlm')
    allowed = {'provider', 'api_base', 'api_key', 'model', 'timeout', 'max_tokens', 'max_retries', 'max_concurrent', 'extra_request_body'}
    if set(supplied) != {'vlm'} or not isinstance(vlm, dict) or set(vlm) - allowed:
        raise RuntimeError('Expected only an explicit supported vlm configuration')
    if vlm.get('provider') != 'openai' or not all(isinstance(vlm.get(key), str) and vlm[key].strip() for key in ('model', 'api_base', 'api_key')):
        raise RuntimeError('A real OpenAI-compatible text model, endpoint and credential are required')
    endpoint = urlsplit(vlm['api_base'])
    if endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise RuntimeError('The configured text model must use a credential-free HTTPS endpoint URL')
    if any(marker in (vlm['model'] + ' ' + vlm['api_base']).lower() for marker in ('fixture', 'mock', 'fake')):
        raise RuntimeError('Protocol fixtures are forbidden in semantic memory configuration')
    vlm = dict(vlm)
    # OpenViking's generic thinking=False only becomes an API switch for
    # DashScope. DeepSeek Flash otherwise defaults to thinking=enabled/high;
    # a bounded summary response can then contain reasoning but no final text.
    # Do not permit arbitrary extra_body fields to override model/request limits.
    disabled_thinking = {'thinking': {'type': 'disabled'}}
    if 'extra_request_body' in vlm and vlm['extra_request_body'] != disabled_thinking:
        raise RuntimeError('Only extra_request_body thinking disabled is supported')
    if endpoint.hostname.lower() == 'api.deepseek.com' and vlm['model'] in {'deepseek-flash', 'deepseek-v4-pro'}:
        vlm.setdefault('extra_request_body', disabled_thinking)
    for name, default, low, high in [('timeout', 120, 1, 300), ('max_tokens', 4096, 256, 16384),
                                    ('max_retries', 1, 0, 3), ('max_concurrent', 2, 1, 8)]:
        value = vlm.setdefault(name, default)
        if isinstance(value, bool) or not isinstance(value, (int, float) if name == 'timeout' else int) or not low <= value <= high:
            raise RuntimeError('Text-model request limits are outside supported bounds: ' + name)
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = RUNTIME / 'ov.conf'
    existing = json.loads(path.read_text()) if path.exists() else None
    dense = {'provider': 'openai', 'api_base': 'http://host.docker.internal:11434/v1' if NATIVE_EMBEDDING else 'http://embedding:11434/v1',
             'api_key': 'local-ollama-no-auth', 'model': MODEL, 'dimension': 1024,
             'input': 'text', 'encoding_format': 'float', 'batch_size': 4}
    if existing:
        before = dict(existing.get('embedding', {}).get('dense', {}))
        # Switching the verified runtime for the exact same trained weights
        # does not change vector identity. Arbitrary endpoints remain forbidden.
        old_base = before.pop('api_base', None)
        if old_base not in {'http://embedding:11434/v1', 'http://host.docker.internal:11434/v1'} or before != {k:v for k,v in dense.items() if k != 'api_base'}:
            raise RuntimeError('Embedding identity changed; create a separate deployment and reindex original documents')
    lock = RUNTIME / 'model-identity.json'
    if lock.exists() and not existing:
        raise RuntimeError('Existing deployment lost its private configuration; restore it instead of silently rotating credentials')
    if existing and (not isinstance(existing.get('server', {}).get('root_api_key'), str) or len(existing['server']['root_api_key']) < 16):
        raise RuntimeError('Existing deployment server authentication is invalid')
    if lock.exists() and json.loads(lock.read_text()) != MODEL_IDENTITY:
        raise RuntimeError('Model identity lock does not match this deployment')
    config = {'server': {'host': '0.0.0.0', 'port': 1933,
                         'root_api_key': existing['server']['root_api_key'] if existing else secrets.token_urlsafe(32)},
              'storage': {'workspace': '/app/.openviking/data'},
              'memory': {'extraction_output_format': 'json'},
              'embedding': {'dense': dense, 'max_concurrent': 2}, 'vlm': vlm}
    write_private(path, config)
    write_private(lock, MODEL_IDENTITY)
    write_private(RUNTIME / 'deployment.json', {'schemaVersion': 1, 'embeddingRuntime': 'native' if NATIVE_EMBEDDING else 'container'})


def docker_http(docker, environment, method, path, key='', body=None):
    """Talk to the exact candidate container, never an existing host listener.

    Credentials and payload travel on stdin, not argv, logs or shell text.
    """
    script = '''import json,sys,urllib.request,urllib.error
x=json.load(sys.stdin)
data=json.dumps(x['body']).encode() if x['body'] is not None else None
request=urllib.request.Request('http://127.0.0.1:1933'+x['path'],data=data,method=x['method'],headers={'Content-Type':'application/json','X-API-Key':x['key']})
try:
 with urllib.request.urlopen(request,timeout=120) as response: print(json.dumps({'status':response.status,'body':json.load(response)}))
except urllib.error.HTTPError as error: print(json.dumps({'status':error.code}))
'''
    result = subprocess.run([*docker, 'exec', '-i', container_name(), 'python', '-c', script],
                            input=json.dumps({'method': method, 'path': path, 'key': key, 'body': body}),
                            capture_output=True, text=True, timeout=130, env=environment)
    if result.returncode:
        raise RuntimeError('Candidate HTTP transport failed (upstream output suppressed)')
    value = json.loads(result.stdout)
    if not 200 <= value.get('status', 0) < 300:
        raise RuntimeError('Candidate HTTP request failed with status ' + str(value.get('status')))
    return value['body']


def provision_candidate(docker, environment):
    path = RUNTIME / 'rna-client.json'
    if path.exists():
        client = json.loads(path.read_text())
        docker_http(docker, environment, 'GET', '/api/v1/system/status', client['api_key'])
        return
    config = json.loads((RUNTIME / 'ov.conf').read_text())
    result = docker_http(docker, environment, 'POST', '/api/v1/admin/accounts', config['server']['root_api_key'],
                         {'account_id': 'rna-local', 'admin_user_id': 'rna-agent'})['result']
    credential = result.get('user_key') or result.get('admin_api_key') or result.get('api_key')
    if not credential:
        raise RuntimeError('Candidate tenant response did not contain a credential')
    write_private(path, {'endpoint': 'http://127.0.0.1:1933', 'account_id': 'rna-local',
                         'user_id': 'rna-agent', 'api_key': credential})


def stage_semantic(compose, docker, environment):
    # The new volume cannot silently replace or mix the old 64D fixture index.
    configure()
    if NATIVE_EMBEDDING:
        manifest = (RUNTIME / 'ollama-models/manifests/registry.ollama.ai/library/bge-m3/latest').read_bytes()
    else:
        subprocess.run([*compose, 'up', '-d', '--wait', '--wait-timeout', '180', 'embedding'], check=True, env=environment)
        manifest_command = [*docker, 'exec', EMBEDDING_CONTAINER, 'cat',
                            '/root/.ollama/models/manifests/registry.ollama.ai/library/bge-m3/latest']
        cached = subprocess.run(manifest_command, capture_output=True, env=environment, timeout=30)
        if cached.returncode:
            print('Downloading pinned real BGE-M3 weights into the new model volume; no provider key is required.', flush=True)
            subprocess.run([*docker, 'exec', EMBEDDING_CONTAINER, 'ollama', 'pull', MODEL], check=True, env=environment,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1800)
            cached = subprocess.run(manifest_command, check=True, capture_output=True, env=environment, timeout=30)
        manifest = cached.stdout
    if 'sha256:' + hashlib.sha256(manifest).hexdigest() != MODEL_DIGEST:
        raise RuntimeError('Downloaded embedding manifest differs from the pinned model; candidate not started')
    # A one-shot container examines only the explicitly new data volume. Refuse
    # a populated unlabelled volume, including an accidentally copied old index.
    image = 'ghcr.io/volcengine/openviking:v0.4.21.1@sha256:13a78525aa255f0cdb026bfdc1ab8c3a9b2baa49148aa10df061e6c2b689c15f'
    check = '''import json,pathlib,sys,os
p=pathlib.Path('/volume');lock=p/'rna-model-identity.json';expected=json.load(sys.stdin)
if lock.exists():
 assert json.loads(lock.read_text())==expected,'Model identity lock mismatch'
else:
 assert not any(p.iterdir()),'Refusing populated volume without embedding identity lock'
 with open(lock,'x') as f:
  os.chmod(lock,0o600);f.write(json.dumps(expected));f.flush();os.fsync(f.fileno())
 fd=os.open(p,os.O_RDONLY)
 try:os.fsync(fd)
 finally:os.close(fd)
'''
    checked = subprocess.run([*docker, 'run', '--rm', '-i', '--network', 'none', '-v', DATA_VOLUME + ':/volume',
                              '--entrypoint', 'python', image, '-c', check],
                             input=json.dumps(MODEL_IDENTITY), capture_output=True, text=True, env=environment, timeout=60)
    if checked.returncode:
        raise RuntimeError('Semantic data volume identity validation failed; no existing data was deleted')
    subprocess.run([*compose, 'create', 'openviking'], check=True, env=environment)
    running = subprocess.run([*docker, 'inspect', '--format', '{{.State.Running}}', SEMANTIC_CONTAINER],
                             check=True, capture_output=True, text=True, env=environment, timeout=30).stdout.strip() == 'true'
    if running:
        current = subprocess.run([*docker, 'exec', SEMANTIC_CONTAINER, 'python', '-c',
                                  "import hashlib,pathlib;print(hashlib.sha256(pathlib.Path('/app/.openviking/ov.conf').read_bytes()).hexdigest())"],
                                 check=True, capture_output=True, text=True, env=environment, timeout=30).stdout.strip()
        if current != hashlib.sha256((RUNTIME / 'ov.conf').read_bytes()).hexdigest():
            raise RuntimeError('Running semantic model configuration changed; use an explicit coordinated restart')
    subprocess.run([*docker, 'cp', str(RUNTIME / 'ov.conf'), SEMANTIC_CONTAINER + ':/app/.openviking/ov.conf'], check=True, env=environment)
    subprocess.run([*compose, 'up', '-d', '--wait', '--wait-timeout', '180'], check=True, env=environment)
    ready = docker_http(docker, environment, 'GET', '/ready')
    if ready.get('status') != 'ready' or ready.get('checks', {}).get('embedding') != 'ok':
        raise RuntimeError('Candidate is live but its real embedding is not ready')
    provision_candidate(docker, environment)
    print('Real embedding candidate is ready; tenant credentials saved privately. Existing host listener and old data were not changed.')


def provision_account():
    """ROOT credentials only provision the tenant; Rna uses a tenant admin key."""
    path = RUNTIME / "rna-client.json"
    if path.exists():
        return
    config = json.loads((RUNTIME / "ov.conf").read_text())
    payload = json.dumps({"account_id": "rna-local-test", "admin_user_id": "rna-agent"}).encode()
    request = urllib.request.Request("http://127.0.0.1:1933/api/v1/admin/accounts", data=payload,
        headers={"Content-Type": "application/json", "X-API-Key": config["server"]["root_api_key"]})
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)["result"]
    credential = result.get("user_key") or result.get("admin_api_key") or result.get("api_key")
    if not credential:
        raise RuntimeError("OpenViking account response did not contain a tenant credential")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump({"endpoint": "http://127.0.0.1:1933", "account_id": "rna-local-test", "user_id": "rna-agent", "api_key": credential}, handle, indent=2)
    print("Created isolated Rna tenant; client credential saved privately, not printed.")


def main():
    global RUNTIME, FIXTURE, NATIVE_EMBEDDING
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', default='status',
                        choices=['prepare', 'configure', 'start', 'stop', 'restart', 'status', 'down', 'logs', 'configure-helper', 'configure-embedding-helper', 'relay'])
    parser.add_argument('--desktop-relay', action='store_true')
    parser.add_argument('--fixture', action='store_true', help='Explicitly operate the isolated legacy protocol fixture, never real project memory')
    runtime = parser.add_mutually_exclusive_group()
    runtime.add_argument('--native-embedding', action='store_true', help='Use the supervised native Ollama with the same pinned trained model')
    runtime.add_argument('--container-embedding', action='store_true', help='Use the isolated Ollama Docker service')
    parser.add_argument('--ollama-binary', help='Absolute official binary for configure-embedding-helper; never a shell command')
    args = parser.parse_args()
    FIXTURE = args.fixture
    if FIXTURE:
        RUNTIME = LEGACY_RUNTIME
    if FIXTURE and (args.native_embedding or args.container_embedding):
        raise RuntimeError('Real embedding runtime options cannot be used with --fixture')
    deployment = RUNTIME / 'deployment.json'
    previous = json.loads(deployment.read_text()) if deployment.exists() and not FIXTURE else {}
    if previous and (previous.get('schemaVersion') != 1 or previous.get('embeddingRuntime') not in {'native', 'container'} or set(previous) != {'schemaVersion', 'embeddingRuntime'}):
        raise RuntimeError('Invalid persisted semantic deployment configuration')
    NATIVE_EMBEDDING = args.native_embedding or (not args.container_embedding and previous.get('embeddingRuntime') == 'native')
    action = args.action
    if action == 'configure-embedding-helper':
        configure_embedding_helper(args.ollama_binary)
        print('Wrote native embedding helper configuration; no process or Docker state was changed.')
        return
    if action == 'configure':
        configure()
        print('Wrote private model configuration; no process or Docker state was changed.')
        return
    if FIXTURE and action == 'prepare':
        raise RuntimeError('Candidate preparation is reserved for real semantic memory')
    if action == 'configure-helper':
        configure_helper()
        print('Wrote relay.json and relay-helper.json; no process or Docker state was changed.')
        return
    if action == 'relay':
        # Explicit development foreground mode. Production lifecycle belongs to
        # the Rna supervisor's managed helper pool, not a second detached parent.
        command = relay_command()
        os.execv(command[0], command)
    commands = {'start': ['up', '-d', '--wait', '--wait-timeout', '180'], 'stop': ['stop'],
                'restart': ['restart'], 'status': ['ps'], 'down': ['down'], 'logs': ['logs', '--tail', '60']}
    direct = args.desktop_relay or (RUNTIME / 'desktop-relay').exists()
    # Candidate preparation never writes helper descriptors or occupies 1933.
    if args.desktop_relay and action != 'prepare':
        configure_helper()
    elif direct and action in ('start', 'restart') and not (RUNTIME / 'relay-helper.json').exists():
        configure_helper()
    executable, host = docker_engine(direct)
    docker = [executable, '--host', host] if host else [executable]
    environment = {key: value for key, value in os.environ.items()
                   if not direct or key not in {'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'}}
    compose = [*docker, 'compose', '-f', str(DEPLOY / ('compose.fixture.yaml' if FIXTURE else 'compose.yaml'))]
    if NATIVE_EMBEDDING:
        compose.extend(['-f', str(DEPLOY / 'compose.native-embedding.yaml')])
    if FIXTURE and direct:
        compose.extend(['-f', str(DEPLOY / 'compose.desktop-relay.yaml')])
    if not FIXTURE and not direct and action != 'prepare':
        compose.extend(['-f', str(DEPLOY / 'compose.direct.yaml')])
    if not FIXTURE and action in ('prepare', 'start'):
        stage_semantic(compose, docker, environment)
        return
    if not FIXTURE and action == 'restart':
        # Configuration changes require revalidation; do not turn a former
        # fixture or an edited embedding config into an implicit replacement.
        configure()
        subprocess.run([*docker, 'cp', str(RUNTIME / 'ov.conf'), SEMANTIC_CONTAINER + ':/app/.openviking/ov.conf'], check=True, env=environment)
        subprocess.run([*compose, *commands[action]], check=True, env=environment)
        return
    if action == 'start':
        configure()
        subprocess.run([*compose, 'build', 'model-fixture'], check=True, env=environment)
        subprocess.run([*compose, 'create'], check=True, env=environment)
    if action in ('start', 'restart'):
        subprocess.run([*docker, 'cp', str(RUNTIME / 'ov.conf'), container_name() + ':/app/.openviking/ov.conf'], check=True, env=environment)
    subprocess.run([*compose, *commands[action]], check=True, env=environment)
    if action == 'start':
        if direct:
            relay_bootstrap(provision_account)
        else:
            provision_account()
    if direct and action in ('start', 'restart'):
        print('Containers started. For continuous host access, configure the Rna supervisor with the absolute relay-helper.json descriptor path.')
        print('Temporary development access: python3 scripts/openviking-local.py relay (foreground).')


if __name__ == '__main__':
    main()
