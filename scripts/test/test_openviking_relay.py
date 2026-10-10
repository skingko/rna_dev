"""Real local socket/child-process fixtures; no Docker, models, or live state."""
import base64
from contextlib import contextmanager
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[2]
RELAY = ROOT / 'scripts/openviking-docker-relay.py'
SPEC = importlib.util.spec_from_file_location('openviking_local_fixture', ROOT / 'scripts/openviking-local.py')
LOCAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOCAL)

FAKE_DOCKER = r'''#!PYTHON
import base64,json,os,sys,time
x=json.load(sys.stdin)
if x['path']=='/api/v1/hang': time.sleep(10)
if x['path']=='/api/v1/flood':
    sys.stdout.write('x'*5000000);sys.stdout.flush();time.sleep(10)
if x['path']=='/ready':
    value={'status':'ready','checks':{'embedding':'ok'}}
else:
    value={'args':sys.argv[1:6], 'context':os.getenv('DOCKER_CONTEXT'), 'hostEnv':os.getenv('DOCKER_HOST'),
           'request':x, 'pid':os.getpid()}
body=json.dumps(value).encode()
print(json.dumps({'status':200,'content_type':'application/json','body':base64.b64encode(body).decode()}))
'''.replace('PYTHON', sys.executable)


def port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


@contextmanager
def fixture(*, owner_delay=0, reject_owner=False, wrong_config_hash=False, unmanaged=False, **overrides):
    with tempfile.TemporaryDirectory(prefix='rna-relay-fixture-') as directory:
        directory = Path(directory)
        docker = directory / 'fake-docker'
        docker.write_text(FAKE_DOCKER)
        docker.chmod(0o700)
        config = {'schemaVersion':1, 'dockerExecutable':str(docker), 'dockerHost':'unix:///fixture-pinned-engine.sock',
                  'host':'127.0.0.1', 'port':port(), 'logPath':str(directory/'relay.log'),
                  'maxConcurrent':2, 'ioTimeoutSeconds':.2, 'upstreamTimeoutSeconds':.3,
                  'transportTimeoutSeconds':5, 'requestTimeoutSeconds':6, 'logMaxBytes':1024, 'logBackups':2, **overrides}
        path = directory/'relay.json'
        path.write_text(json.dumps(config))
        config_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        env = {**os.environ, 'DOCKER_CONTEXT':'wrong-context', 'DOCKER_HOST':'unix:///wrong.sock',
               'RNA_MANAGED_HELPER_ID':'openviking-relay', 'RNA_MANAGED_HELPER_TOKEN':'fixture-token',
               'RNA_MANAGED_HELPER_FINGERPRINT':'fixture-fingerprint', 'RNA_MANAGED_HELPER_OWNER_FILE':str(directory/'owner.json')}
        if unmanaged:
            env = {key: value for key, value in env.items() if not key.startswith('RNA_MANAGED_HELPER_')}
        (directory/'owner.json').write_text(json.dumps({'phase':'prepared','pid':None}))
        child = subprocess.Popen([sys.executable, str(RELAY), '--config', str(path)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        base = f"http://127.0.0.1:{config['port']}"
        def request(route, data=None, headers=None):
            try:
                with urllib.request.urlopen(urllib.request.Request(base+route, data=data, headers=headers or {}), timeout=3) as response:
                    return response.status, json.loads(response.read())
            except urllib.error.HTTPError as error:
                with error:
                    return error.code, error.read()
        try:
            if owner_delay:
                time.sleep(owner_delay)
                try:
                    connection = socket.create_connection(('127.0.0.1',config['port']), timeout=.2)
                except OSError:
                    pass
                else:
                    connection.close()
                    raise AssertionError('Relay listened before durable owner confirmation')
            (directory/'owner.json').write_text(json.dumps({'phase':'running','id':'openviking-relay','token':'fixture-token','fingerprint':'fixture-fingerprint','pid':child.pid + int(reject_owner), 'descriptor': {'configFingerprint': '0'*64 if wrong_config_hash else config_hash}}))
            if not unmanaged and (reject_owner or wrong_config_hash):
                yield config, child, request, directory
                return
            deadline = time.monotonic()+4
            while time.monotonic()<deadline:
                if child.poll() is not None:
                    raise RuntimeError('Relay fixture failed to start')
                try:
                    if request('/_rna/health')[0] == 200:
                        break
                except OSError:
                    time.sleep(.02)
            else:
                raise RuntimeError('Relay fixture startup deadline')
            yield config, child, request, directory
        finally:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


class RelayTests(unittest.TestCase):
    def test_unmanaged_foreground_relay_does_not_require_a_managed_config_hash(self):
        with fixture(unmanaged=True, wrong_config_hash=True) as (_, _, request, _):
            self.assertIsNone(request('/_rna/health')[1]['managedHelper'])
            self.assertEqual(request('/ready')[0], 200)

    def test_config_hash_mismatch_exits_before_listening_even_with_matching_pid_and_nonce(self):
        with fixture(wrong_config_hash=True) as (config, child, _, directory):
            self.assertNotEqual(child.wait(timeout=3), 0)
            with self.assertRaises(OSError):
                socket.create_connection(('127.0.0.1', config['port']), timeout=.2)
            self.assertFalse((directory/'relay.log').exists())

    def test_prepared_owner_does_not_listen_until_exact_durable_pid_ack(self):
        with fixture(owner_delay=.25) as (_, child, request, _):
            self.assertEqual(request('/_rna/health')[1]['managedHelper']['pid'], child.pid)

    def test_wrong_owner_pid_exits_without_listening_or_transport_after_bounded_gate(self):
        with fixture(reject_owner=True) as (config, child, _, directory):
            self.assertNotEqual(child.wait(timeout=12), 0)
            with self.assertRaises(OSError):
                socket.create_connection(('127.0.0.1', config['port']), timeout=.2)
            self.assertFalse((directory/'relay.log').exists())

    def test_ready_passthrough_and_engine_pinning_headers_stdin_and_identity(self):
        with fixture() as (_, child, request, directory):
            code, body = request('/ready')
            self.assertEqual((code, body), (200, {'status':'ready','checks':{'embedding':'ok'}}), (directory/'relay.log').read_text())
            code, body = request('/api/v1/resource', data=b'private-body', headers={'X-API-Key':'private-credential', 'X-OpenViking-User':'project-user','X-Unrelated':'must-not-forward'})
            self.assertEqual(code, 200)
            self.assertEqual(body['args'], ['--host','unix:///fixture-pinned-engine.sock','exec','-i','rna-openviking'])
            self.assertIsNone(body['context']); self.assertIsNone(body['hostEnv'])
            self.assertEqual(base64.b64decode(body['request']['body']), b'private-body')
            headers = {key.lower():value for key,value in body['request']['headers'].items()}
            self.assertEqual(headers['x-api-key'], 'private-credential')
            self.assertNotIn('x-unrelated', headers)
            identity = request('/_rna/health')[1]['managedHelper']
            self.assertEqual(identity, {'id':'openviking-relay','token':'fixture-token','fingerprint':'fixture-fingerprint','pid':child.pid})
            self.assertNotIn('private-', (directory/'relay.log').read_text())
            self.assertEqual(request('/health-pretend')[0],404)

    def test_subprocess_timeout_and_output_limit_release_admission(self):
        with fixture(maxBytes=1024, transportTimeoutSeconds=.6, requestTimeoutSeconds=1) as (_, _, request, _):
            started = time.monotonic()
            self.assertEqual(request('/api/v1/hang')[0], 502)
            self.assertLess(time.monotonic()-started, 1.5)
            started = time.monotonic()
            self.assertEqual(request('/api/v1/flood')[0], 502)
            self.assertLess(time.monotonic()-started, 1.5)
            self.assertEqual(request('/ready')[0], 200)
            self.assertEqual(request('/api/v1/write', b'x'*1025)[0], 413)

    def test_concurrency_cap_rejects_before_spawning_threads(self):
        with fixture(maxConcurrent=1, transportTimeoutSeconds=1.5, requestTimeoutSeconds=2) as (config, _, request, _):
            pending = socket.create_connection(('127.0.0.1', config['port']))
            try:
                pending.sendall(b'POST /api/v1/write HTTP/1.0\r\nContent-Length: 100\r\n\r\nx')
                time.sleep(.05)
                self.assertEqual(request('/ready')[0], 503)
                time.sleep(.3)
                self.assertEqual(request('/ready')[0], 200)
            finally:
                pending.close()

    def test_slow_trickle_cannot_extend_whole_request_deadline(self):
        with fixture(ioTimeoutSeconds=.25, transportTimeoutSeconds=.6, requestTimeoutSeconds=.8) as (config, _, request, _):
            pending = socket.create_connection(('127.0.0.1', config['port']))
            pending.settimeout(.1)
            started = time.monotonic()
            try:
                pending.sendall(b'POST /api/v1/write HTTP/1.0\r\nContent-Length: 100\r\n\r\n')
                for _ in range(15):
                    try:
                        pending.sendall(b'x')
                    except OSError:
                        break
                    time.sleep(.1)
                self.assertLess(time.monotonic()-started, 1.4)
                self.assertEqual(request('/ready')[0], 200)
            finally:
                pending.close()

    def test_rotation_and_private_log_permissions(self):
        with fixture() as (_, _, request, directory):
            for _ in range(90):
                self.assertEqual(request('/api/v1/flood')[0], 502)
            logs = list(directory.glob('relay.log*'))
            self.assertLessEqual(len(logs), 3)
            self.assertGreater(len(logs), 1)
            self.assertTrue(all(path.stat().st_size <= 1100 for path in logs))
            self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in logs))

    def test_invalid_framing_never_reaches_transport(self):
        with fixture() as (config, _, _, _):
            for headers in (b'Content-Length: -1', b'Content-Length: 1\r\nContent-Length: 1', b'Transfer-Encoding: chunked'):
                with socket.create_connection(('127.0.0.1', config['port'])) as client:
                    client.sendall(b'POST /api/v1/write HTTP/1.0\r\n'+headers+b'\r\n\r\n')
                    status=client.recv(300).split(b'\r\n',1)[0]
                    self.assertTrue(b'400' in status or b'411' in status, status)

    def test_shutdown_reaps_active_docker_transport_child(self):
        with fixture(transportTimeoutSeconds=5, requestTimeoutSeconds=6) as (config, child, request, _):
            pending = socket.create_connection(('127.0.0.1', config['port']))
            try:
                pending.sendall(b'GET /api/v1/hang HTTP/1.0\r\n\r\n')
                deadline = time.monotonic()+2
                child_pid = None
                while time.monotonic()<deadline:
                    # OS process evidence, not a mocked Popen. No live processes
                    # are targeted: only descendants of this fixture relay.
                    output = subprocess.run(['ps','-axo','pid=,ppid='], capture_output=True, text=True, check=True).stdout
                    children = [int(row.split()[0]) for row in output.splitlines() if len(row.split()) == 2 and int(row.split()[1]) == child.pid]
                    if children:
                        child_pid = children[0]
                        break
                    time.sleep(.01)
                self.assertIsNotNone(child_pid)
                child.terminate(); child.wait(timeout=2)
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
            finally:
                pending.close()


class LocalConfigurationTests(unittest.TestCase):
    def test_helper_configure_only_writes_private_descriptor_without_docker_or_process(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(LOCAL, 'RUNTIME', Path(directory)), patch.object(LOCAL.shutil, 'which', return_value='/bin/echo'), patch.object(LOCAL.subprocess, 'run') as run, patch.object(LOCAL.subprocess, 'Popen') as popen:
            descriptor = LOCAL.configure_helper()
            run.assert_not_called(); popen.assert_not_called()
            config = json.loads((Path(directory)/'relay.json').read_text())
            self.assertTrue(config['dockerHost'].endswith('/Data/docker.raw.sock'))
            self.assertEqual(descriptor['healthIdentity'], 'rna-helper-v1')
            self.assertEqual(descriptor['healthUrl'], 'http://127.0.0.1:1933/_rna/health')
            self.assertEqual(len(descriptor['configFingerprint']),64)
            self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in Path(directory).iterdir()))

    def test_relay_compose_and_copy_use_same_pinned_engine(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(LOCAL, 'RUNTIME', Path(directory)), patch.object(LOCAL, 'LEGACY_RUNTIME', Path(directory)), patch.object(LOCAL, 'FIXTURE', False), patch.object(LOCAL.shutil, 'which', return_value='/bin/echo'), patch.object(LOCAL.subprocess, 'run') as run, patch.object(LOCAL, 'configure'), patch.object(LOCAL, 'relay_bootstrap') as bootstrap, patch.object(sys, 'argv', ['openviking-local.py','start','--desktop-relay','--fixture']), patch.dict(os.environ, {'DOCKER_CONTEXT':'wrong-context','DOCKER_HOST':'unix:///wrong.sock'}):
            LOCAL.main()
            commands=[call.args[0] for call in run.call_args_list]
            self.assertEqual(len(commands),4)
            self.assertTrue(all(command[:3] == commands[0][:3] for command in commands))
            self.assertEqual(commands[0][1], '--host')
            self.assertEqual(commands[2][3], 'cp')
            self.assertTrue(all('DOCKER_CONTEXT' not in call.kwargs['env'] and 'DOCKER_HOST' not in call.kwargs['env'] for call in run.call_args_list))
            bootstrap.assert_called_once_with(LOCAL.provision_account)


if __name__ == '__main__':
    unittest.main()
