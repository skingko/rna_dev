#!/usr/bin/env python3
"""Foreground managed native Ollama helper; no content or credentials are logged."""
import argparse
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

IDENTITY_KEYS = ('RNA_MANAGED_HELPER_ID', 'RNA_MANAGED_HELPER_TOKEN', 'RNA_MANAGED_HELPER_FINGERPRINT', 'RNA_MANAGED_HELPER_OWNER_FILE')
DEFAULTS = {'schemaVersion': 1, 'ollamaHost': '127.0.0.1', 'ollamaPort': 11434, 'healthPort': 11435, 'model': 'bge-m3:latest', 'warmupTimeoutSeconds': 60, 'embeddingDimension': 1024}
PROBE_INTERVAL_SECONDS = 1
READINESS_MAX_AGE_SECONDS = 2


def load_config(path):
    raw = Path(path).read_bytes()
    if len(raw) > 16384:
        raise ValueError('Configuration exceeds limit')
    config = {**DEFAULTS, **json.loads(raw)}
    if config['schemaVersion'] != 1 or config['ollamaHost'] != '127.0.0.1':
        raise ValueError('Embedding helper requires schema 1 and loopback')
    for key in ('binary', 'models'):
        if not isinstance(config.get(key), str) or not os.path.isabs(config[key]):
            raise ValueError('Absolute native paths required')
    if not Path(config['binary']).is_file() or not os.access(config['binary'], os.X_OK) or not Path(config['models']).is_dir():
        raise ValueError('Native executable or model directory unavailable')
    for key in ('ollamaPort', 'healthPort'):
        if type(config[key]) is not int or not 1 <= config[key] <= 65535:
            raise ValueError('Invalid loopback port')
    if config['ollamaPort'] == config['healthPort']:
        raise ValueError('Embedding and health ports must differ')
    if not isinstance(config['model'], str) or not re.fullmatch(r'[A-Za-z0-9_.:/-]{1,160}', config['model']):
        raise ValueError('Invalid model identity')
    digest = config.get('modelDigest', '')
    if not isinstance(digest, str) or not re.fullmatch(r'(?:sha256:)?[a-f0-9]{64}', digest):
        raise ValueError('Exact model manifest digest required')
    config['modelDigest'] = digest.removeprefix('sha256:')
    if type(config['warmupTimeoutSeconds']) not in (int, float) or not .05 <= config['warmupTimeoutSeconds'] <= 120:
        raise ValueError('Warmup must have a bounded total deadline')
    if type(config['embeddingDimension']) is not int or not 1 <= config['embeddingDimension'] <= 8192:
        raise ValueError('Expected embedding dimension must be bounded')
    return config, hashlib.sha256(raw).hexdigest()


def await_managed_owner(fingerprint, owner_timeout=10):
    # Native helpers never fall back to an unowned standalone daemon.
    if not all(os.environ.get(key) for key in IDENTITY_KEYS) or not os.path.isabs(os.environ[IDENTITY_KEYS[3]]):
        raise ValueError('Managed helper ownership is required')
    parent = os.getppid()
    deadline = time.monotonic() + owner_timeout
    while time.monotonic() < deadline and os.getppid() == parent:
        try:
            owner = json.loads(Path(os.environ[IDENTITY_KEYS[3]]).read_text())
            if owner.get('phase') == 'running' and owner.get('pid') == os.getpid() and all(owner.get(field) == os.environ[key] for field, key in zip(('id', 'token', 'fingerprint'), IDENTITY_KEYS[:3])):
                if owner.get('descriptor', {}).get('configFingerprint') != fingerprint:
                    raise RuntimeError('EMBEDDING_CONFIG_FINGERPRINT_MISMATCH')
                return parent
        except (OSError, ValueError, AttributeError):
            pass
        time.sleep(.05)
    raise RuntimeError('Managed helper ownership was not durably acknowledged')


def port_available(port):
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', port))
    finally:
        probe.close()


def child_exited(pid):
    # WNOWAIT retains the child PID until after all process-group signals. A
    # poll()/wait() here would reap it and make delayed negative-PID kills unsafe.
    return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def signal_owned_group(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass


def cleanup_child(child):
    signal_owned_group(child.pid, signal.SIGTERM)
    deadline = time.monotonic() + .6
    while time.monotonic() < deadline:
        time.sleep(.025)
    # The unreaped direct child still reserves this PID and process-group id.
    signal_owned_group(child.pid, signal.SIGKILL)
    try:
        child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        return False
    deadline = time.monotonic() + 1.5
    while time.monotonic() < deadline:
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        time.sleep(.025)
    return False  # no more signals after reaping; do not guess at a reused id


def send_frame(channel, value):
    channel.sendall(json.dumps(value, separators=(',', ':')).encode() + b'\n')


def guardian(fd, owner_pid):
    channel = socket.socket(fileno=fd)
    channel.settimeout(5)
    child = None
    stopped = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopped.set())
    try:
        payload = bytearray()
        while b'\n' not in payload:
            chunk = channel.recv(4096)
            if not chunk or len(payload) + len(chunk) > 16384 or os.getppid() != owner_pid:
                return 1
            payload.extend(chunk)
        config = json.loads(payload.split(b'\n')[0])
        port_available(config['ollamaPort'])
        if stopped.is_set() or os.getppid() != owner_pid:
            return 1
        env = {key: value for key, value in os.environ.items() if key in ('PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL')}
        env.update({'OLLAMA_HOST': f"127.0.0.1:{config['ollamaPort']}", 'OLLAMA_MODELS': config['models'], 'OLLAMA_NO_CLOUD': '1', 'OLLAMA_KEEP_ALIVE': '-1', 'OLLAMA_NUM_PARALLEL': '1'})
        child = subprocess.Popen([config['binary'], 'serve'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True, env=env)
        send_frame(channel, {'event': 'started', 'pid': child.pid})
        channel.settimeout(.2)
        while not stopped.is_set() and os.getppid() == owner_pid and not child_exited(child.pid):
            try:
                channel.recv(128)
                break  # EOF or explicit stop; command stdin is independent
            except socket.timeout:
                pass
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass
    finally:
        try:
            send_frame(channel, {'event': 'stopping'})
        except OSError:
            pass
        cleaned = cleanup_child(child) if child else True
        try:
            send_frame(channel, {'event': 'stopped', 'cleaned': cleaned})
        except OSError:
            pass
        channel.close()
    return 0 if cleaned else 1


def probe_result(started, code=None, **details):
    return {'ok': code is None, 'code': code or 'EMBEDDING_PROBE_OK', 'elapsedMs': max(0, round((time.monotonic() - started) * 1000)), **details}


def shutdown_socket(sock):
    if sock:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


class ProbeCancellation:
    """One readiness worker owns at most one HTTP socket at a time."""
    def __init__(self):
        self.lock = threading.Lock()
        self.event = threading.Event()
        self.socket = None

    def attach(self, sock):
        with self.lock:
            self.socket = sock
            if self.event.is_set():
                shutdown_socket(sock)
                raise OSError('Probe cancelled')

    def detach(self, sock):
        with self.lock:
            if self.socket is sock:
                self.socket = None

    def cancel(self):
        with self.lock:
            self.event.set()
            shutdown_socket(self.socket)


def model_probe(config, loaded=False, cancellation=None):
    """A total one-second deadline, including headers and trickling body reads.

    Keep the original connected socket even if HTTP/1.0 hands its ownership to
    the response. Neither redirects, proxies, nor a slow stream extend the bound.
    """
    started = time.monotonic()
    prefix = 'EMBEDDING_RESIDENT' if loaded else 'EMBEDDING_MODEL'
    cancellation = cancellation or ProbeCancellation()
    expired = threading.Event()
    connection = http.client.HTTPConnection('127.0.0.1', config['ollamaPort'], timeout=1)
    sock = None
    timer = None
    response = None
    result = probe_result(started, prefix + '_UNREACHABLE')
    try:
        if cancellation.event.is_set():
            raise OSError('Probe cancelled')
        connection.connect()
        sock = connection.sock
        cancellation.attach(sock)
        remaining = 1 - (time.monotonic() - started)
        if remaining <= 0:
            expired.set()
            raise TimeoutError('Probe deadline')
        def expire():
            expired.set()
            shutdown_socket(sock)
        timer = threading.Timer(remaining, expire)
        timer.daemon = True
        timer.start()
        connection.request('GET', f"/api/{'ps' if loaded else 'tags'}")
        response = connection.getresponse()
        if response.status != 200:
            result = probe_result(started, prefix + '_HTTP', httpStatus=response.status)
        else:
            raw = response.read(65537)
            if len(raw) > 65536:
                result = probe_result(started, prefix + '_RESPONSE_TOO_LARGE')
            else:
                models = json.loads(raw).get('models', [])
                if not isinstance(models, list):
                    result = probe_result(started, prefix + '_RESPONSE_INVALID')
                else:
                    matches = [model for model in models if isinstance(model, dict) and model.get('name') == config['model']]
                    if not matches:
                        result = probe_result(started, prefix + '_MISSING')
                    elif not any(str(model.get('digest', '')).removeprefix('sha256:') == config['modelDigest'] for model in matches):
                        result = probe_result(started, prefix + '_IDENTITY_MISMATCH')
                    else:
                        result = probe_result(started)
    except TimeoutError:
        result = probe_result(started, prefix + '_TIMEOUT')
    except (OSError, http.client.HTTPException):
        result = probe_result(started, prefix + '_UNREACHABLE')
    except (ValueError, AttributeError):
        result = probe_result(started, prefix + '_RESPONSE_INVALID')
    finally:
        if timer:
            timer.cancel()
        cancellation.detach(sock)
        if response:
            response.close()
        connection.close()
    if cancellation.event.is_set():
        return probe_result(started, prefix + '_CANCELLED')
    if expired.is_set() or time.monotonic() - started >= 1:
        return probe_result(started, prefix + '_TIMEOUT')
    return result


def bounded_command(command, timeout, limit):
    """Collect system metadata with a total deadline and bounded pipe memory."""
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LC_ALL': 'C', 'LANG': 'C'})
    deadline = time.monotonic() + timeout
    output = bytearray()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise subprocess.TimeoutExpired(command, timeout)
            chunk = os.read(process.stdout.fileno(), min(65536, limit + 1 - len(output)))
            if not chunk:
                code = process.wait(timeout=max(.001, deadline - time.monotonic()))
                return subprocess.CompletedProcess(command, code, bytes(output))
            output.extend(chunk)
            if len(output) > limit:
                raise OverflowError('System metadata exceeds bound')
    finally:
        selector.close()
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=1)


def tcp_listener_pids(raw, port):
    """Darwin netstat names the owner of each TCP PCB, including reuse-port
    and IPv6 listeners. Unknown output is never accepted as ownership proof."""
    columns = None
    owners = set()
    for line in raw.decode('ascii', errors='strict').splitlines():
        if line.startswith('Proto '):
            columns = line.replace('Local Address', 'local_address').replace('Foreign Address', 'foreign_address').split()
            if len(set(columns)) != len(columns) or not {'Proto', 'local_address', '(state)', 'pid'}.issubset(columns):
                raise ValueError('Unrecognized TCP metadata columns')
            continue
        if not line.startswith(('tcp4 ', 'tcp6 ')):
            continue
        if columns is None:
            raise ValueError('TCP metadata header missing')
        values = line.split()
        if len(values) != len(columns):
            raise ValueError('Truncated TCP metadata')
        row = dict(zip(columns, values))
        if row['local_address'].rsplit('.', 1)[-1] == str(port) and row['(state)'] == 'LISTEN':
            if not row['pid'].isdigit() or int(row['pid']) < 1:
                raise ValueError('Listener owner unavailable')
            owners.add(int(row['pid']))
    if columns is None:
        raise ValueError('TCP metadata header missing')
    return owners


def owner_probe(config, pid):
    # The model response alone must not let a foreign listener impersonate our
    # child during a bind race. Native macOS installs include this system tool.
    started = time.monotonic()
    backend = 'netstat'
    try:
        try:
            result = bounded_command(['/usr/sbin/netstat', '-anv', '-p', 'tcp'], 1, 512 * 1024)
            if result.returncode != 0:
                raise ValueError('TCP metadata unavailable')
            owners = tcp_listener_pids(result.stdout, config['ollamaPort'])
            return probe_result(started, None if owners == {pid} else 'EMBEDDING_OWNER_MISMATCH', backend=backend)
        except (OSError, ValueError, OverflowError):
            # Compatibility fallback preserves the original exclusive-PID
            # check. It never narrows to -p, which could hide a foreign owner.
            backend = 'lsof'
        remaining = 1 - (time.monotonic() - started)
        if remaining <= 0:
            return probe_result(started, 'EMBEDDING_OWNER_PROBE_TIMEOUT', backend=backend)
        result = bounded_command(['/usr/sbin/lsof', '-nP', f"-iTCP:{config['ollamaPort']}", '-sTCP:LISTEN', '-Fp'], remaining, 8192)
        if len(result.stdout) > 8192 or result.returncode not in (0, 1):
            return probe_result(started, 'EMBEDDING_OWNER_PROBE_FAILED', backend=backend)
        if set(re.findall(rb'^p([0-9]+)$', result.stdout, re.M)) != {str(pid).encode()}:
            return probe_result(started, 'EMBEDDING_OWNER_MISMATCH', backend=backend)
        return probe_result(started, backend=backend)
    except subprocess.TimeoutExpired:
        return probe_result(started, 'EMBEDDING_OWNER_PROBE_TIMEOUT', backend=backend)
    except (OSError, OverflowError, subprocess.SubprocessError):
        return probe_result(started, 'EMBEDDING_OWNER_PROBE_FAILED', backend=backend)


def model_ready(config):
    return model_probe(config)['ok']


def port_owned(config, pid):
    return owner_probe(config, pid)['ok']


class EmbeddingWarmup:
    """One local inference per owned native-process lifetime, never a VLM call.

    Tags prove that weights exist, not that the inference engine has loaded them.
    Run independently so health and guardian/parent monitoring stay responsive.
    Closing the actual socket interrupts both header and body reads on cancel or
    the total deadline; an idle-read timeout alone would permit slow trickles.
    """
    def __init__(self, config):
        self.config = config
        self.lock = threading.Lock()
        self.connection = None
        self.socket = None
        self.cancelled = False
        self.expired = False
        self.result = {'ok': False, 'code': 'EMBEDDING_WARMUP_PENDING', 'elapsedMs': 0}
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def interrupt(self, expired=False):
        with self.lock:
            if expired:
                self.expired = True
            else:
                self.cancelled = True
            sock = self.socket
            if sock:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def run(self):
        started = time.monotonic()
        timeout = self.config.get('warmupTimeoutSeconds', DEFAULTS['warmupTimeoutSeconds'])
        timer = threading.Timer(timeout, lambda: self.interrupt(expired=True))
        timer.daemon = True
        connection = http.client.HTTPConnection('127.0.0.1', self.config['ollamaPort'], timeout=min(1, timeout))
        with self.lock:
            self.connection = connection
        result = probe_result(started, 'EMBEDDING_WARMUP_UNREACHABLE')
        timer.start()
        try:
            connection.connect()
            with self.lock:
                self.socket = connection.sock
                if self.cancelled or self.expired:
                    raise OSError('Warmup cancelled before send')
                connection.sock.settimeout(timeout)
            body = json.dumps({'model': self.config['model'], 'input': 'ok', 'keep_alive': -1})
            connection.request('POST', '/api/embed', body=body, headers={'Content-Type': 'application/json'})
            response = connection.getresponse()
            if response.status != 200:
                result = probe_result(started, 'EMBEDDING_WARMUP_HTTP', httpStatus=response.status)
            else:
                raw = response.read(262145)
                if len(raw) > 262144:
                    result = probe_result(started, 'EMBEDDING_WARMUP_RESPONSE_TOO_LARGE')
                else:
                    data = json.loads(raw)
                    vectors = data.get('embeddings')
                    dimension = self.config.get('embeddingDimension', DEFAULTS['embeddingDimension'])
                    if (data.get('model') != self.config['model'] or not isinstance(vectors, list) or len(vectors) != 1
                            or not isinstance(vectors[0], list) or len(vectors[0]) != dimension
                            or not all(type(value) in (int, float) and math.isfinite(value) for value in vectors[0])
                            or not any(value != 0 for value in vectors[0])):
                        result = probe_result(started, 'EMBEDDING_WARMUP_RESPONSE_INVALID')
                    else:
                        result = probe_result(started, dimensions=dimension)
        except (TimeoutError, socket.timeout):
            result = probe_result(started, 'EMBEDDING_WARMUP_TIMEOUT')
        except (OSError, http.client.HTTPException):
            result = probe_result(started, 'EMBEDDING_WARMUP_UNREACHABLE')
        except (ValueError, AttributeError, TypeError, OverflowError):
            result = probe_result(started, 'EMBEDDING_WARMUP_RESPONSE_INVALID')
        finally:
            timer.cancel()
            with self.lock:
                self.expired = self.expired or time.monotonic() - started >= timeout
                connection.close()
                self.connection = None
                self.socket = None
                self.result = probe_result(started, 'EMBEDDING_WARMUP_CANCELLED' if self.cancelled else 'EMBEDDING_WARMUP_TIMEOUT') if self.cancelled or self.expired else result


class HealthServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 4

    def __init__(self, helper):
        self.helper = helper
        self.slots = threading.BoundedSemaphore(4)
        super().__init__(('127.0.0.1', helper.config['healthPort']), Handler)
        self.timeout = .1

    def process_request(self, request, address):
        if not self.slots.acquire(False):
            request.close()
            return
        request.settimeout(1)
        super().process_request(request, address)

    def process_request_thread(self, request, address):
        def expire():
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            request.close()
        deadline = threading.Timer(2, expire)
        deadline.daemon = True
        deadline.start()
        try:
            super().process_request_thread(request, address)
        finally:
            deadline.cancel()
            self.slots.release()

    def handle_error(self, *_args):
        pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path != '/_rna/health':
            self.send_error(404)
            return
        helper = self.server.helper
        snapshot = helper.health_snapshot()
        ready = snapshot['ready']
        body = json.dumps({'ok': ready, 'managedHelper': {'id': os.environ[IDENTITY_KEYS[0]], 'token': os.environ[IDENTITY_KEYS[1]], 'fingerprint': os.environ[IDENTITY_KEYS[2]], 'pid': os.getpid()}, 'embedding': {**snapshot, 'model': helper.config['model'], 'modelDigest': helper.config['modelDigest'], 'cleanupUncertain': helper.cleanup_uncertain}}).encode()
        self.send_response(200 if ready else 503)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Helper:
    def __init__(self, config):
        self.config = config
        self.stopped = threading.Event()
        self.guardian_process = None
        self.child_pid = None
        self.cleanup_uncertain = False
        self.channel = None
        self.pending = bytearray()
        self.warmup = None
        self.probe_lock = threading.Lock()
        self.probe_thread = None
        self.probe_cancellation = None
        self.probe_snapshot = None
        self.probe_started_at = None
        self.next_probe_at = 0

    def current_child(self, pid, guardian):
        return (not self.stopped.is_set() and pid is not None and self.child_pid == pid
                and guardian is self.guardian_process and guardian is not None and guardian.poll() is None)

    def health_snapshot(self):
        # One atomic publication keeps readiness, diagnostics and child identity
        # from different probe generations out of the same HTTP response.
        with self.probe_lock:
            now = time.monotonic()
            snapshot = self.probe_snapshot
            alive = self.current_child(self.child_pid, self.guardian_process)
            same_child = snapshot is not None and self.current_child(snapshot['pid'], snapshot['guardian'])
            age = max(0, now - snapshot['started']) if snapshot else None
            fresh = age is not None and age <= READINESS_MAX_AGE_SECONDS
            ready = bool(alive and same_child and fresh and snapshot['ok'])
            probing = self.probe_thread is not None and self.probe_thread.is_alive()
            readiness = {**snapshot['readiness']} if snapshot else {}
            readiness.update({'code': 'EMBEDDING_PROBE_OK' if ready else (
                'EMBEDDING_CHILD_UNAVAILABLE' if not alive else 'EMBEDDING_PROBE_PENDING' if snapshot is None
                else 'EMBEDDING_PROBE_STALE' if not fresh or not same_child else 'EMBEDDING_PROBE_FAILED'),
                'probing': probing, 'ageMs': round(age * 1000) if age is not None else None,
                'maxAgeMs': round(READINESS_MAX_AGE_SECONDS * 1000),
                'activeProbeStartedAt': self.probe_started_at if probing else None})
            return {'childAlive': alive, 'ready': ready, 'readiness': readiness}

    def schedule_probe(self):
        with self.probe_lock:
            if (not self.current_child(self.child_pid, self.guardian_process) or time.monotonic() < self.next_probe_at
                    or (self.probe_thread is not None and self.probe_thread.is_alive())):
                return False
            cancellation = ProbeCancellation()
            self.probe_cancellation = cancellation
            self.probe_started_at = round(time.time() * 1000)
            self.probe_thread = threading.Thread(target=self.check_ready,
                args=(self.child_pid, self.guardian_process, time.monotonic(), self.probe_started_at, cancellation), daemon=True)
            self.probe_thread.start()
            return True

    def check_ready(self, pid, guardian, started, started_at, cancellation):
        # Only this single worker may perform probes or initiate warmup. The
        # accept/guardian/parent loop never waits for filesystem or model I/O.
        unchecked = lambda code: {'ok': False, 'code': code, 'elapsedMs': 0}
        owner = unchecked('EMBEDDING_OWNER_NOT_CHECKED')
        model = unchecked('EMBEDDING_MODEL_NOT_CHECKED')
        warmup = unchecked('EMBEDDING_WARMUP_NOT_STARTED')
        resident = unchecked('EMBEDDING_RESIDENT_NOT_CHECKED')
        try:
            owner = owner_probe(self.config, pid)
            if owner['ok'] and self.current_child(pid, guardian):
                model = model_probe(self.config, cancellation=cancellation)
            with self.probe_lock:
                if owner['ok'] and model['ok'] and self.current_child(pid, guardian) and self.warmup is None:
                    self.warmup = EmbeddingWarmup(self.config)
                if self.warmup:
                    with self.warmup.lock:
                        warmup = dict(self.warmup.result)
            if owner['ok'] and model['ok'] and warmup['ok'] and self.current_child(pid, guardian):
                resident = model_probe(self.config, loaded=True, cancellation=cancellation)
        except Exception:
            # Fixed diagnostic, never exception text containing provider data.
            owner = unchecked('EMBEDDING_PROBE_FAILED')
        finally:
            with self.probe_lock:
                if self.current_child(pid, guardian) and not cancellation.event.is_set():
                    self.probe_snapshot = {'pid': pid, 'guardian': guardian, 'started': started,
                        'ok': all(item['ok'] for item in (owner, model, warmup, resident)),
                        'readiness': {'owner': owner, 'model': model, 'warmup': warmup, 'resident': resident,
                            'checkedAt': round(time.time() * 1000), 'probeStartedAt': started_at}}
                # Refresh cadence is measured from the proof's start, just like
                # freshness. Completion+interval would create stale gaps even
                # for routine successful probes shorter than the interval.
                self.next_probe_at = started + PROBE_INTERVAL_SECONDS

    def start(self):
        port_available(self.config['ollamaPort'])
        self.server = HealthServer(self)  # health bind failure cannot leak Ollama
        parent, child = socket.socketpair()
        try:
            # Keep the guardian outside the helper's group: SIGKILL of the
            # wrapper/group must leave a living owner to clean the model tree.
            self.guardian_process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--guardian-fd', str(child.fileno()), '--guardian-owner', str(os.getpid())], pass_fds=(child.fileno(),), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        finally:
            child.close()
        self.channel = parent
        parent.settimeout(1)
        send_frame(parent, self.config)
        parent.setblocking(False)

    def receive(self):
        if self.channel is None:
            return
        try:
            data = self.channel.recv(4096)
        except BlockingIOError:
            return
        if not data:
            self.stopped.set()
            return
        self.pending.extend(data)
        if len(self.pending) > 8192:
            self.stopped.set()
            return
        while b'\n' in self.pending:
            line, _, self.pending = self.pending.partition(b'\n')
            event = json.loads(line)
            if event.get('event') == 'started' and type(event.get('pid')) is int:
                self.child_pid = event['pid']
            elif event.get('event') == 'stopping':
                self.stopped.set()
            elif event.get('event') == 'stopped':
                self.cleanup_uncertain = event.get('cleaned') is not True
                self.stopped.set()

    def close(self):
        self.stopped.set()
        with self.probe_lock:
            if self.probe_cancellation:
                self.probe_cancellation.cancel()
            warmup = self.warmup
        if warmup:
            warmup.interrupt()
        if hasattr(self, 'server'):
            self.server.server_close()
        if self.channel:
            try:
                self.channel.send(b'stop')
            except OSError:
                pass
            self.channel.close()  # EOF is the authoritative lifetime boundary
        process = self.guardian_process
        if process:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                # Never signal an old command PID after losing its guardian.
                self.cleanup_uncertain = True
            if process.returncode not in (0, None):
                self.cleanup_uncertain = True
        if self.probe_thread:
            self.probe_thread.join(timeout=2)
            if self.probe_thread.is_alive():
                self.cleanup_uncertain = True
        if warmup:
            warmup.thread.join(timeout=2)
            if warmup.thread.is_alive():
                self.cleanup_uncertain = True
        return not self.cleanup_uncertain


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config')
    parser.add_argument('--guardian-fd', type=int)
    parser.add_argument('--guardian-owner', type=int)
    args = parser.parse_args()
    if args.guardian_fd is not None:
        return guardian(args.guardian_fd, args.guardian_owner)
    if not args.config:
        raise ValueError('Configuration required')
    config, fingerprint = load_config(args.config)
    parent = await_managed_owner(fingerprint)
    helper = Helper(config)
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: helper.stopped.set())
    try:
        helper.start()
        while not helper.stopped.is_set() and os.getppid() == parent:
            helper.receive()
            if helper.guardian_process.poll() is not None:
                break
            helper.schedule_probe()
            helper.server.handle_request()
    finally:
        cleaned = helper.close()
    return 0 if cleaned else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        # Fixed code only: paths, provider payloads and managed tokens stay private.
        print('EMBEDDING_HELPER_START_FAILED', file=sys.stderr)
        sys.exit(1)
