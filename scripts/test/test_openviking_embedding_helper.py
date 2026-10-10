import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch, Mock
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

SCRIPT = Path(__file__).resolve().parents[1] / 'openviking-embedding-helper.py'
spec = importlib.util.spec_from_file_location('embedding_helper', SCRIPT)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
DIGEST = 'a' * 64

FAKE = '''#!PYTHON
import json, os, signal, subprocess, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
root=Path(os.environ['OLLAMA_MODELS'])
if sys.argv[1:] != ['serve']: sys.exit(3)
child=subprocess.Popen([sys.executable,'-c',"import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(300)"],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
(root/'pids.json').write_text(json.dumps({'serve':os.getpid(),'grandchild':child.pid}))
(root/'keep-alive').write_text(os.environ.get('OLLAMA_KEEP_ALIVE',''))
signal.signal(signal.SIGTERM, signal.SIG_IGN)
if (root/'flood').exists():
    os.write(1,b'PRIVATE-CONTENT'*300000);os.write(2,b'PRIVATE-CONTENT'*300000)
if (root/'early-exit').exists(): sys.exit(0)
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        if self.path not in ['/api/tags','/api/ps']: self.send_error(404);return
        if self.path == '/api/tags' and (root/'tags-delay').exists():
            with (root/'slow-tags-started').open('a') as log: log.write('probe\\n')
            time.sleep(float((root/'tags-delay').read_text()))
        body=json.dumps({'models':[]}).encode() if self.path=='/api/ps' and (not (root/'loaded').exists() or (root/'unload').exists()) else (root/'tags.json').read_bytes()
        try:
            self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        except OSError: pass
    def do_POST(self):
        if self.path != '/api/embed': self.send_error(404);return
        request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        (root/'warmup-request.json').write_text(json.dumps(request))
        counter=root/'warmup-count';counter.write_text(str(int(counter.read_text())+1 if counter.exists() else 1))
        if (root/'warmup-delay').exists(): time.sleep(float((root/'warmup-delay').read_text()))
        (root/'loaded').touch()
        body=json.dumps({'model':request['model'],'embeddings':[[0.1]*1024] if not (root/'invalid-vector').exists() else [[]]}).encode()
        try:
            self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        except OSError: pass
ThreadingHTTPServer(tuple([os.environ['OLLAMA_HOST'].rsplit(':',1)[0],int(os.environ['OLLAMA_HOST'].rsplit(':',1)[1])]),Handler).serve_forever()
'''


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def running(pid):
    result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True, timeout=2)
    return bool(result.stdout.strip()) and not result.stdout.strip().startswith('Z')


def until(check, timeout=12):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if check():
            return
        time.sleep(.04)
    raise AssertionError('Fixture did not settle')


class OwnershipProbeTests(unittest.TestCase):
    def table(self, rows):
        return ('Active Internet connections (including servers)\nProto Recv-Q Send-Q Local Address Foreign Address (state) pid\n' + '\n'.join(rows) + '\n').encode()

    def test_kernel_table_checks_every_ipv4_ipv6_reuseport_listener(self):
        rows = ['tcp4 0 0 127.0.0.1.11434 *.* LISTEN 42', 'tcp4 0 0 127.0.0.1.11434 127.0.0.1.6000 ESTABLISHED 99']
        self.assertEqual(helper.tcp_listener_pids(self.table(rows), 11434), {42})
        rows.append('tcp6 0 0 ::1.11434 *.* LISTEN 77')
        self.assertEqual(helper.tcp_listener_pids(self.table(rows), 11434), {42, 77})
        rows.append('tcp4 0 0 127.0.0.1.11434 *.* LISTEN 88')
        self.assertEqual(helper.tcp_listener_pids(self.table(rows), 11434), {42, 77, 88})
        with patch.object(helper, 'bounded_command', return_value=subprocess.CompletedProcess([], 0, self.table(rows))):
            self.assertEqual(helper.owner_probe({'ollamaPort': 11434}, 42)['code'], 'EMBEDDING_OWNER_MISMATCH')

    def test_unrelated_full_process_scan_timeout_cannot_trigger_a_false_owner_failure(self):
        calls = []
        def command(args, timeout, limit):
            calls.append(args)
            if args[0].endswith('lsof'):
                raise subprocess.TimeoutExpired(args, timeout)  # injected old global-scan failure
            return subprocess.CompletedProcess(args, 0, self.table(['tcp4 0 0 127.0.0.1.11434 *.* LISTEN 42']))
        with patch.object(helper, 'bounded_command', side_effect=command):
            for _ in range(100):
                result = helper.owner_probe({'ollamaPort': 11434}, 42)
                self.assertTrue(result['ok']); self.assertEqual(result['backend'], 'netstat')
        self.assertEqual(len(calls), 100); self.assertTrue(all(args[0].endswith('netstat') for args in calls))

    def test_unknown_kernel_schema_uses_strict_global_fallback_and_timeouts_stay_unhealthy(self):
        calls = []
        def command(args, *_args):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, b'unknown table' if args[0].endswith('netstat') else b'p42\nf3\np77\nf8\n')
        with patch.object(helper, 'bounded_command', side_effect=command):
            value = helper.owner_probe({'ollamaPort': 11434}, 42)
        self.assertEqual(value['code'], 'EMBEDDING_OWNER_MISMATCH'); self.assertEqual(value['backend'], 'lsof'); self.assertNotIn('-p', calls[-1])
        with patch.object(helper, 'bounded_command', side_effect=subprocess.TimeoutExpired(['fixture'], 1)):
            self.assertEqual(helper.owner_probe({'ollamaPort': 11434}, 42)['code'], 'EMBEDDING_OWNER_PROBE_TIMEOUT')
        for raw in [self.table(['tcp4 0 0 127.0.0.1.11434 *.* LISTEN 0']), self.table(['tcp4 0 0 127.0.0.1.11434'])]:
            with self.assertRaises(ValueError): helper.tcp_listener_pids(raw, 11434)

    def test_system_command_pipe_and_lifetime_are_bounded(self):
        processes = []; original = subprocess.Popen
        def spawn(*args, **kwargs):
            process = original(*args, **kwargs); processes.append(process); return process
        with patch.object(helper.subprocess, 'Popen', side_effect=spawn):
            with self.assertRaises(OverflowError): helper.bounded_command([sys.executable, '-c', 'import os;os.write(1,b"x"*2000000)'], 2, 8192)
            with self.assertRaises(subprocess.TimeoutExpired): helper.bounded_command([sys.executable, '-c', 'import time;time.sleep(60)'], .05, 8192)
        self.assertTrue(all(process.poll() is not None for process in processes))

    def test_model_timeout_and_invalid_response_have_fixed_noncontent_diagnostics(self):
        connection = Mock(); connection.connect.side_effect = TimeoutError('private-provider-content')
        with patch.object(helper.http.client, 'HTTPConnection', return_value=connection):
            result = helper.model_probe({'ollamaPort': 1})
        self.assertEqual(result['code'], 'EMBEDDING_MODEL_TIMEOUT'); self.assertFalse(result['ok']); self.assertNotIn('private-provider-content', json.dumps(result))


class ReadinessSocketTests(unittest.TestCase):
    def trickle(self, cancel, loaded=False):
        headers_sent = threading.Event()
        disconnected = threading.Event()
        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.0'
            def log_message(self, *_args): pass
            def do_GET(self):
                self.send_response(200); self.send_header('Content-Length', '99999'); self.end_headers(); headers_sent.set()
                try:
                    while True:
                        self.wfile.write(b' '); self.wfile.flush(); time.sleep(.02)
                except OSError:
                    disconnected.set()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        cancellation = helper.ProbeCancellation()
        result = []
        worker = threading.Thread(target=lambda: result.append(helper.model_probe({'ollamaPort': server.server_port}, loaded, cancellation)))
        started = time.monotonic(); worker.start()
        self.addCleanup(lambda: worker.join(timeout=2)); self.addCleanup(cancellation.cancel)
        self.assertTrue(headers_sent.wait(.5))
        if cancel: cancellation.cancel()
        worker.join(timeout=1.5)
        self.assertFalse(worker.is_alive(), 'Slow HTTP/1.0 body must not outlive the total probe deadline')
        self.assertLess(time.monotonic() - started, .6 if cancel else 1.4)
        self.assertFalse(result[0]['ok'])
        self.assertEqual(result[0]['code'], ('EMBEDDING_RESIDENT' if loaded else 'EMBEDDING_MODEL') + ('_CANCELLED' if cancel else '_TIMEOUT'))
        self.assertTrue(disconnected.wait(.5), 'Timed-out probe must close its actual response socket')

    def test_model_body_trickle_obeys_total_one_second_deadline(self):
        self.trickle(False)

    def test_resident_body_trickle_cancels_immediately(self):
        self.trickle(True, loaded=True)


class ReadinessWorkerTests(unittest.TestCase):
    def configured(self, warmed=True):
        instance = helper.Helper({**helper.DEFAULTS, 'modelDigest': DIGEST})
        instance.child_pid = 42
        instance.guardian_process = Mock()
        instance.guardian_process.poll.return_value = None
        instance.guardian_process.returncode = 0
        if warmed:
            instance.warmup = Mock()
            instance.warmup.lock = threading.Lock()
            instance.warmup.result = {'ok': True, 'code': 'EMBEDDING_PROBE_OK', 'elapsedMs': 0}
            instance.warmup.thread.is_alive.return_value = False
        self.addCleanup(instance.close)
        return instance

    def test_success_remains_fresh_during_fast_refresh_without_random_unhealthy_samples(self):
        instance = self.configured()
        def slow_success(*_args, **_kwargs):
            time.sleep(.025)
            return {'ok': True, 'code': 'EMBEDDING_PROBE_OK', 'elapsedMs': 25}
        with patch.object(helper, 'owner_probe', side_effect=slow_success) as owner, patch.object(helper, 'model_probe', side_effect=slow_success), patch.object(helper, 'PROBE_INTERVAL_SECONDS', .025):
            self.assertTrue(instance.schedule_probe()); instance.probe_thread.join(timeout=1)
            initial = instance.health_snapshot()['readiness']['probeStartedAt']
            end = time.monotonic() + .5
            while time.monotonic() < end:
                instance.schedule_probe()
                self.assertTrue(instance.health_snapshot()['ready'], 'Refreshing must not toggle a fresh completed result to false')
                time.sleep(.005)
            instance.probe_thread.join(timeout=1)
            self.assertGreater(owner.call_count, 3)
            self.assertGreater(instance.health_snapshot()['readiness']['probeStartedAt'], initial)

    def test_probe_is_singleflight_and_staleness_is_from_start_not_completion(self):
        instance = self.configured()
        entered, release = threading.Event(), threading.Event()
        success = {'ok': True, 'code': 'EMBEDDING_PROBE_OK', 'elapsedMs': 0}
        def owner(*_args):
            entered.set(); release.wait(4)
            return success
        with patch.object(helper, 'owner_probe', return_value=success), patch.object(helper, 'model_probe', return_value=success):
            instance.schedule_probe(); instance.probe_thread.join(timeout=1)
        try:
            with patch.object(helper, 'owner_probe', side_effect=owner) as calls, patch.object(helper, 'model_probe', return_value=success):
                instance.next_probe_at = 0
                self.assertTrue(instance.schedule_probe()); self.assertTrue(entered.wait(.5))
                with ThreadPoolExecutor(max_workers=4) as executor:
                    self.assertTrue(all(value is False for value in executor.map(lambda _: instance.schedule_probe(), range(40))))
                self.assertTrue(instance.health_snapshot()['ready'])
                until(lambda: instance.health_snapshot()['readiness']['ageMs'] > 2050, timeout=3)
                snapshot = instance.health_snapshot()
                self.assertFalse(snapshot['ready']); self.assertTrue(snapshot['readiness']['probing'])
                self.assertEqual(snapshot['readiness']['code'], 'EMBEDDING_PROBE_STALE')
                self.assertEqual(calls.call_count, 1)
                release.set(); instance.probe_thread.join(timeout=1)
                self.assertFalse(instance.health_snapshot()['ready'], 'A late success must not start a new two-second freshness window')
                self.assertGreater(instance.health_snapshot()['readiness']['ageMs'], 2000)
        finally:
            release.set(); instance.probe_thread.join(timeout=1)

    def test_subsecond_successful_probes_refresh_from_start_without_stale_gaps(self):
        instance = self.configured()
        def success(*_args, **_kwargs):
            time.sleep(.22)  # owner + tags + resident: approximately 660ms total
            return {'ok': True, 'code': 'EMBEDDING_PROBE_OK', 'elapsedMs': 220}
        with patch.object(helper, 'owner_probe', side_effect=success) as owner, patch.object(helper, 'model_probe', side_effect=success):
            instance.schedule_probe(); instance.probe_thread.join(timeout=1.5)
            self.assertTrue(instance.health_snapshot()['ready'])
            end = time.monotonic() + 3
            while time.monotonic() < end:
                instance.schedule_probe()
                self.assertTrue(instance.health_snapshot()['ready'], 'Subsecond successful probes must not create completion+interval freshness gaps')
                time.sleep(.01)
            instance.probe_thread.join(timeout=1.5)
            self.assertGreaterEqual(owner.call_count, 4)

    def test_slow_owner_probe_expires_while_real_health_http_remains_responsive(self):
        instance = self.configured()
        instance.config['healthPort'] = free_port()
        entered, release = threading.Event(), threading.Event()
        success = {'ok': True, 'code': 'EMBEDDING_PROBE_OK', 'elapsedMs': 0}
        with patch.object(helper, 'owner_probe', return_value=success), patch.object(helper, 'model_probe', return_value=success):
            instance.schedule_probe(); instance.probe_thread.join(timeout=1)
        initial = instance.health_snapshot()['readiness']
        def slow_owner(*_args):
            entered.set(); release.wait(5)
            return success
        def accept_loop():
            while not instance.stopped.is_set():
                instance.schedule_probe()
                instance.server.handle_request()
        def fetch_health():
            started = time.monotonic()
            try:
                response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                    f"http://127.0.0.1:{instance.config['healthPort']}/_rna/health", timeout=.3)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                body = json.load(response)
            self.assertLess(time.monotonic() - started, .3)
            return response.status, body
        env = dict(zip(helper.IDENTITY_KEYS, ('fixture', 'private-token', 'fingerprint', '/fixture-owner')))
        with patch.dict(os.environ, env), patch.object(helper, 'owner_probe', side_effect=slow_owner) as owner, patch.object(helper, 'model_probe', return_value=success):
            instance.server = helper.HealthServer(instance)
            instance.next_probe_at = 0
            accept = threading.Thread(target=accept_loop, daemon=True); accept.start()
            try:
                self.assertTrue(entered.wait(.5))
                self.assertEqual(fetch_health()[0], 200, 'Fresh complete success is usable during refresh')
                until(lambda: instance.health_snapshot()['readiness']['ageMs'] > 2050, timeout=3)
                with ThreadPoolExecutor(max_workers=3) as executor:
                    responses = list(executor.map(lambda _: fetch_health(), range(6)))
                for status, body in responses:
                    self.assertEqual(status, 503); self.assertFalse(body['ok'])
                    readiness = body['embedding']['readiness']
                    self.assertEqual(readiness['code'], 'EMBEDDING_PROBE_STALE'); self.assertTrue(readiness['probing'])
                    self.assertEqual(readiness['probeStartedAt'], initial['probeStartedAt'])
                    self.assertEqual(readiness['checkedAt'], initial['checkedAt'])
                    self.assertGreater(readiness['ageMs'], 2000)
                self.assertEqual(owner.call_count, 1)
            finally:
                instance.stopped.set(); release.set(); accept.join(timeout=1); instance.close()
                self.assertFalse(accept.is_alive()); self.assertFalse(instance.probe_thread.is_alive())

    def test_close_cancels_worker_and_never_publishes_late_success_or_starts_warmup(self):
        instance = self.configured(warmed=False)
        entered = threading.Event()
        def owner(*_args):
            entered.set(); instance.probe_cancellation.event.wait(2)
            return {'ok': True, 'code': 'EMBEDDING_PROBE_OK', 'elapsedMs': 0}
        with patch.object(helper, 'owner_probe', side_effect=owner), patch.object(helper, 'model_probe') as model, patch.object(helper, 'EmbeddingWarmup') as warmup:
            instance.schedule_probe(); self.assertTrue(entered.wait(.5))
            started = time.monotonic(); self.assertTrue(instance.close())
            self.assertLess(time.monotonic() - started, .5)
            self.assertIsNone(instance.probe_snapshot); self.assertFalse(instance.health_snapshot()['ready'])
            self.assertFalse(instance.schedule_probe()); model.assert_not_called(); warmup.assert_not_called()

    def test_child_generation_change_discards_late_probe_result(self):
        instance = self.configured(warmed=False)
        entered, release = threading.Event(), threading.Event()
        def owner(*_args):
            entered.set(); release.wait(2)
            return {'ok': True, 'code': 'EMBEDDING_PROBE_OK', 'elapsedMs': 0}
        try:
            with patch.object(helper, 'owner_probe', side_effect=owner), patch.object(helper, 'model_probe') as model, patch.object(helper, 'EmbeddingWarmup') as warmup:
                instance.schedule_probe(); self.assertTrue(entered.wait(.5))
                instance.child_pid = 43
                release.set(); instance.probe_thread.join(timeout=1)
                self.assertIsNone(instance.probe_snapshot); self.assertFalse(instance.health_snapshot()['ready'])
                model.assert_not_called(); warmup.assert_not_called()
        finally:
            release.set(); instance.probe_thread.join(timeout=1)

    def test_unsettled_probe_shutdown_is_bounded_and_reports_cleanup_uncertainty(self):
        instance = self.configured(warmed=False)
        entered, release = threading.Event(), threading.Event()
        def owner(*_args):
            entered.set(); release.wait(5)
            return {'ok': True, 'code': 'EMBEDDING_PROBE_OK', 'elapsedMs': 0}
        try:
            with patch.object(helper, 'owner_probe', side_effect=owner), patch.object(helper, 'EmbeddingWarmup') as warmup:
                instance.schedule_probe(); self.assertTrue(entered.wait(.5))
                started = time.monotonic(); self.assertFalse(instance.close())
                self.assertLess(time.monotonic() - started, 2.5)
                self.assertTrue(instance.cleanup_uncertain); self.assertTrue(instance.probe_thread.is_alive())
                release.set(); instance.probe_thread.join(timeout=1)
                self.assertIsNone(instance.probe_snapshot); warmup.assert_not_called()
        finally:
            release.set(); instance.probe_thread.join(timeout=1)


class WarmupSocketTests(unittest.TestCase):
    def trickle(self, cancel):
        headers_sent = threading.Event()
        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.0'
            def log_message(self, *_args): pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200); self.send_header('Content-Length', '99999'); self.end_headers(); headers_sent.set()
                try:
                    for _ in range(1000):
                        self.wfile.write(b' '); self.wfile.flush(); time.sleep(.02)
                except OSError: pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        warm = helper.EmbeddingWarmup({'ollamaPort': server.server_port, 'model': 'bge-m3:latest', 'warmupTimeoutSeconds': 60 if cancel else .18})
        self.addCleanup(warm.interrupt)
        self.assertTrue(headers_sent.wait(1))
        start=time.monotonic()
        if cancel: warm.interrupt()
        warm.thread.join(timeout=1)
        self.assertFalse(warm.thread.is_alive(), 'Connection:close body trickles must not defeat total lifetime or cancellation')
        self.assertLess(time.monotonic()-start, .8)
        self.assertEqual(warm.result['code'], 'EMBEDDING_WARMUP_CANCELLED' if cancel else 'EMBEDDING_WARMUP_TIMEOUT')
        self.assertFalse(warm.result['ok'])

    def test_http10_response_body_trickle_obeys_total_deadline(self):
        self.trickle(False)

    def test_http10_response_body_trickle_is_interruptible_after_socket_handoff(self):
        self.trickle(True)


@unittest.skipUnless(sys.platform == 'darwin', 'native macOS helper uses system lsof')
class EmbeddingHelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rna-embedding-helper-')
        self.directory = Path(self.temp.name)
        self.models = self.directory / 'models'; self.models.mkdir()
        self.binary = self.directory / 'ollama-fixture'
        self.binary.write_text(FAKE.replace('PYTHON', sys.executable)); self.binary.chmod(0o700)
        self.config = {**helper.DEFAULTS, 'binary': str(self.binary), 'models': str(self.models), 'modelDigest': 'sha256:' + DIGEST, 'ollamaPort': free_port(), 'healthPort': free_port()}
        self.file = self.directory / 'config.json'; self.file.write_text(json.dumps(self.config))
        self.owner = self.directory / 'owner.json'
        self.env = {**os.environ, 'RNA_MANAGED_HELPER_ID': 'embedding-fixture', 'RNA_MANAGED_HELPER_TOKEN': 'fixture-token', 'RNA_MANAGED_HELPER_FINGERPRINT': 'fixture-owner-fingerprint', 'RNA_MANAGED_HELPER_OWNER_FILE': str(self.owner)}
        self.tags(DIGEST)
        self.process = None
        self.known_pids = None

    def tags(self, digest):
        (self.models / 'tags.json').write_text(json.dumps({'models': [{'name': 'bge-m3:latest', 'digest': digest}]}))

    def start(self, acknowledge=True, fingerprint=None):
        self.process = subprocess.Popen([sys.executable, str(SCRIPT), '--config', str(self.file)], env=self.env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        if acknowledge:
            self.ack(self.process.pid, fingerprint)
        return self.process

    def ack(self, pid, fingerprint=None):
        self.owner.write_text(json.dumps({'phase': 'running', 'pid': pid, 'id': self.env['RNA_MANAGED_HELPER_ID'], 'token': self.env['RNA_MANAGED_HELPER_TOKEN'], 'fingerprint': self.env['RNA_MANAGED_HELPER_FINGERPRINT'], 'descriptor': {'configFingerprint': fingerprint or hashlib.sha256(self.file.read_bytes()).hexdigest()}}))

    def health(self, timeout=2):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            response = opener.open(f"http://127.0.0.1:{self.config['healthPort']}/_rna/health", timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        except (OSError, TimeoutError):
            return None
        with response:
            self.last_health_status = response.status
            return json.load(response)

    def ready(self):
        until(lambda: (self.health() or {}).get('ok') is True)
        self.known_pids = json.loads((self.models / 'pids.json').read_text())
        return self.health()

    def assert_tree_stopped(self):
        pids = self.known_pids or json.loads((self.models / 'pids.json').read_text())
        until(lambda: all(not running(pid) for pid in pids.values()))

    def tearDown(self):
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
            try:
                self.process.communicate(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill(); self.process.communicate(timeout=3)
        # Test-only last-resort cleanup, signal only the current listener whose
        # PID is the exact fixture process recorded in this private directory.
        if (self.models / 'pids.json').exists():
            pids = json.loads((self.models / 'pids.json').read_text())
            if running(pids['serve']) and helper.port_owned(self.config, pids['serve']):
                os.killpg(pids['serve'], signal.SIGKILL)
        self.temp.cleanup()

    def test_no_owner_and_invalid_config_never_spawn(self):
        bad = {**self.config, 'ollamaHost': '0.0.0.0'}; self.file.write_text(json.dumps(bad))
        with self.assertRaises(ValueError): helper.load_config(self.file)
        self.file.write_text(json.dumps(self.config))
        env = {key: value for key, value in os.environ.items() if not key.startswith('RNA_MANAGED_HELPER_')}
        result = subprocess.run([sys.executable, str(SCRIPT), '--config', str(self.file)], env=env, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 1); self.assertFalse((self.models / 'pids.json').exists())

    def test_owner_acknowledgement_and_exact_config_hash_precede_spawn(self):
        self.start(False); time.sleep(.2)
        self.assertFalse((self.models / 'pids.json').exists()); self.assertIsNone(self.health())
        self.ack(self.process.pid, '0' * 64)
        self.assertEqual(self.process.wait(timeout=3), 1)
        self.assertFalse((self.models / 'pids.json').exists())

    def test_foreign_embedding_listener_is_never_adopted_or_killed(self):
        with socket.socket() as foreign:
            foreign.bind(('127.0.0.1', self.config['ollamaPort'])); foreign.listen()
            self.start(); self.assertEqual(self.process.wait(timeout=3), 1)
            self.assertFalse((self.models / 'pids.json').exists())
            self.assertEqual(foreign.getsockname()[1], self.config['ollamaPort'])

    def test_occupied_health_listener_prevents_child_spawn(self):
        with socket.socket() as foreign:
            foreign.bind(('127.0.0.1', self.config['healthPort'])); foreign.listen()
            self.start(); self.assertEqual(self.process.wait(timeout=3), 1)
            self.assertFalse((self.models / 'pids.json').exists())

    def test_managed_identity_model_digest_and_quiet_bounded_stdio(self):
        (self.models / 'flood').touch(); self.start(); health = self.ready()
        self.assertEqual(health['managedHelper'], {'id': 'embedding-fixture', 'token': 'fixture-token', 'fingerprint': 'fixture-owner-fingerprint', 'pid': self.process.pid})
        self.assertEqual(health['embedding']['modelDigest'], DIGEST); self.assertTrue(health['embedding']['childAlive'])
        self.assertEqual((self.models/'keep-alive').read_text(), '-1')
        self.assertTrue(health['embedding']['readiness']['warmup']['ok'])
        self.assertTrue(health['embedding']['readiness']['resident']['ok'])
        self.assertEqual(json.loads((self.models/'warmup-request.json').read_text()), {'model':'bge-m3:latest','input':'ok','keep_alive':-1})
        self.assertEqual((self.models/'warmup-count').read_text(), '1')
        self.process.terminate(); out, err = self.process.communicate(timeout=8)
        self.assertEqual(self.process.returncode, 0); self.assertEqual(out, b''); self.assertEqual(err, b''); self.assert_tree_stopped()

    def test_missing_or_wrong_model_digest_is_not_ready(self):
        self.tags('b' * 64); self.start()
        until(lambda: (self.models / 'pids.json').exists())
        until(lambda: self.health() is not None)
        until(lambda: ((self.health() or {}).get('embedding', {}).get('readiness') or {}).get('model', {}).get('code') == 'EMBEDDING_MODEL_IDENTITY_MISMATCH')
        self.assertFalse(self.health()['ok']); self.assertFalse((self.models/'warmup-count').exists()); self.tags(DIGEST); self.ready()

    def test_cold_inference_is_once_async_and_health_stays_unready_until_real_vector(self):
        (self.models/'warmup-delay').write_text('2'); self.start()
        until(lambda: (self.models/'warmup-count').exists())
        for _ in range(4):
            health=self.health(); self.assertIsNotNone(health); self.assertFalse(health['ok'])
            self.assertEqual(self.last_health_status,503)
            self.assertEqual(health['embedding']['readiness']['warmup']['code'], 'EMBEDDING_WARMUP_PENDING')
        self.ready(); time.sleep(1.2); self.assertTrue(self.health()['ok']); self.assertEqual((self.models/'warmup-count').read_text(), '1')

    def test_warmup_total_timeout_is_not_retried_or_reported_ready(self):
        self.config['warmupTimeoutSeconds']=.15; self.file.write_text(json.dumps(self.config))
        (self.models/'warmup-delay').write_text('3'); self.start()
        until(lambda: ((self.health() or {}).get('embedding',{}).get('readiness') or {}).get('warmup',{}).get('code')=='EMBEDDING_WARMUP_TIMEOUT')
        time.sleep(1.2); self.assertFalse(self.health()['ok']); self.assertEqual((self.models/'warmup-count').read_text(), '1')
        self.assertEqual(self.last_health_status,503)

    def test_invalid_vector_never_passes_and_missing_residency_revokes_prior_readiness(self):
        (self.models/'invalid-vector').touch(); self.start()
        until(lambda: ((self.health() or {}).get('embedding',{}).get('readiness') or {}).get('warmup',{}).get('code')=='EMBEDDING_WARMUP_RESPONSE_INVALID')
        self.assertFalse(self.health()['ok']); self.assertEqual((self.models/'warmup-count').read_text(), '1')
        self.process.terminate(); self.process.communicate(timeout=8); (self.models/'invalid-vector').unlink(); self.start(); self.ready()
        (self.models/'unload').touch()
        until(lambda: ((self.health() or {}).get('embedding',{}).get('readiness') or {}).get('resident',{}).get('code')=='EMBEDDING_RESIDENT_MISSING')
        self.assertFalse(self.health()['ok']); self.assertEqual((self.models/'warmup-count').read_text(), '2')

    def test_stop_during_cold_inference_cancels_request_and_cleans_native_tree(self):
        (self.models/'warmup-delay').write_text('60'); self.start()
        until(lambda: (self.models/'warmup-count').exists()); self.known_pids=json.loads((self.models/'pids.json').read_text())
        start=time.monotonic(); self.process.terminate(); self.process.communicate(timeout=8)
        self.assertEqual(self.process.returncode,0); self.assertLess(time.monotonic()-start,5); self.assert_tree_stopped()

    def test_helper_sigkill_cleans_stubborn_native_grandchild(self):
        self.start(); self.ready(); self.process.kill(); self.process.wait(timeout=3)
        self.assert_tree_stopped()
        until(lambda: self.health() is None)

    def test_native_exit_cleans_descendants_before_wrapper_exit(self):
        (self.models / 'early-exit').touch(); self.start(); self.process.wait(timeout=8)
        self.assert_tree_stopped()

    def test_supervisor_sigkill_does_not_leave_helper_or_native_tree(self):
        launcher = self.directory / 'launcher.py'
        launcher.write_text('''import hashlib,json,os,subprocess,sys,time
from pathlib import Path
p=subprocess.Popen([sys.executable,sys.argv[1],'--config',sys.argv[2]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
Path(sys.argv[4]).write_text(str(p.pid))
Path(sys.argv[3]).write_text(json.dumps({'phase':'running','pid':p.pid,'id':os.environ['RNA_MANAGED_HELPER_ID'],'token':os.environ['RNA_MANAGED_HELPER_TOKEN'],'fingerprint':os.environ['RNA_MANAGED_HELPER_FINGERPRINT'],'descriptor':{'configFingerprint':hashlib.sha256(Path(sys.argv[2]).read_bytes()).hexdigest()}}))
p.wait()
''')
        pidfile = self.directory / 'helper.pid'
        launcher_process = subprocess.Popen([sys.executable, str(launcher), str(SCRIPT), str(self.file), str(self.owner), str(pidfile)], env=self.env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            until(lambda: (self.health() or {}).get('ok') is True)
            self.known_pids = json.loads((self.models / 'pids.json').read_text()); wrapper = int(pidfile.read_text())
            launcher_process.kill(); launcher_process.wait(timeout=3)
            self.assert_tree_stopped(); until(lambda: not running(wrapper))
        finally:
            if launcher_process.poll() is None:
                launcher_process.terminate(); launcher_process.wait(timeout=3)

    def test_readiness_disappears_on_native_death(self):
        self.start(); self.ready(); os.kill(self.known_pids['serve'], signal.SIGKILL)
        self.process.wait(timeout=8); self.assert_tree_stopped(); self.assertIsNone(self.health())

    def test_slow_health_connections_have_bounded_lifetime(self):
        self.start(); self.ready()
        sockets = [socket.create_connection(('127.0.0.1', self.config['healthPort'])) for _ in range(4)]
        try:
            for sock in sockets: sock.sendall(b'GET /_rna/health HTTP/1.0\r\nX-Slow: ')
            time.sleep(2.5)
            self.assertTrue(self.health()['ok'])
        finally:
            for sock in sockets: sock.close()

    def test_slow_readiness_probe_does_not_block_health_or_start_probe_storm(self):
        self.start(); self.ready()
        (self.models/'tags-delay').write_text('60')
        until(lambda: (self.models/'slow-tags-started').exists())
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=3) as executor:
            health = list(executor.map(lambda _: self.health(timeout=.3), range(6)))
        self.assertLess(time.monotonic() - started, .5)
        self.assertTrue(all(value is not None for value in health), 'Slow probe must return prompt health JSON, not time out the accept loop')
        self.assertEqual((self.models/'slow-tags-started').read_text().splitlines(), ['probe'], 'Concurrent HTTP requests must not launch additional probes')
        until(lambda: ((self.health() or {}).get('embedding', {}).get('readiness') or {}).get('model', {}).get('code') == 'EMBEDDING_MODEL_TIMEOUT')
        self.assertFalse(self.health()['ok'], 'A failed refresh must invalidate the previous success immediately')

    def test_stop_during_slow_readiness_probe_cleans_native_tree(self):
        self.start(); self.ready()
        (self.models/'tags-delay').write_text('60')
        until(lambda: (self.models/'slow-tags-started').exists())
        started = time.monotonic(); self.process.terminate(); self.process.communicate(timeout=5)
        self.assertEqual(self.process.returncode, 0)
        self.assertLess(time.monotonic() - started, 3)
        self.assert_tree_stopped()


if __name__ == '__main__':
    unittest.main()
