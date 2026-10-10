#!/usr/bin/env python3
"""Bounded, foreground-only HTTP transport to the real OpenViking container.

The Rna supervisor owns this process. Container lifecycle belongs to Docker.
Credentials travel over stdin; neither credentials nor HTTP payloads are logged.
"""
import argparse
import base64
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

REMOTE = r'''
import base64, json, sys, urllib.request, urllib.error
x=json.load(sys.stdin)
req=urllib.request.Request('http://127.0.0.1:1933'+x['path'], data=base64.b64decode(x['body']) if x['body'] else None, method=x['method'], headers=x['headers'])
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None
try:
    response=urllib.request.build_opener(NoRedirect()).open(req,timeout=x['timeout'])
except urllib.error.HTTPError as error:
    response=error
body=response.read(x['maxBytes']+1)
if len(body)>x['maxBytes']: raise ValueError('OV response exceeded relay limit')
print(json.dumps({'status':response.status,'content_type':response.headers.get('Content-Type','application/json'),'body':base64.b64encode(body).decode()}))
'''

DEFAULTS = {"schemaVersion": 1, "host": "127.0.0.1", "port": 1933,
            "container": "rna-openviking", "maxConcurrent": 8,
            "ioTimeoutSeconds": 5, "requestTimeoutSeconds": 80,
            "transportTimeoutSeconds": 70, "upstreamTimeoutSeconds": 65,
            "maxBytes": 2_000_000, "logMaxBytes": 1_048_576, "logBackups": 3}


def load_config(path):
    # Parse and fingerprint one read. Reopening for the hash would allow the
    # descriptor to acknowledge bytes different from the settings in memory.
    raw = Path(path).read_bytes()
    value = {**DEFAULTS, **json.loads(raw)}
    if value['schemaVersion'] != 1 or value['host'] != '127.0.0.1':
        raise ValueError('Relay configuration must use schema 1 and loopback')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value['container']):
        raise ValueError('Invalid container identity')
    if not isinstance(value.get('dockerHost'), str) or not value['dockerHost'].startswith('unix:///'):
        raise ValueError('An explicit local Docker Engine socket is required')
    if not os.path.isabs(value.get('dockerExecutable', '')) or not os.access(value['dockerExecutable'], os.X_OK):
        raise ValueError('An absolute Docker executable is required')
    if not os.path.isabs(value.get('logPath', '')):
        raise ValueError('An absolute logPath is required')
    for key, minimum, maximum in [('port', 1, 65535), ('maxConcurrent', 1, 32),
                                  ('maxBytes', 1024, 2_000_000), ('logMaxBytes', 1024, 4_194_304), ('logBackups', 1, 5)]:
        if type(value[key]) is not int or not minimum <= value[key] <= maximum:
            raise ValueError('Invalid bounded relay option: ' + key)
    for key in ('ioTimeoutSeconds', 'requestTimeoutSeconds', 'transportTimeoutSeconds', 'upstreamTimeoutSeconds'):
        if type(value[key]) not in (int, float) or not .05 <= value[key] <= 90:
            raise ValueError('Invalid bounded relay timeout')
    if not value['upstreamTimeoutSeconds'] < value['transportTimeoutSeconds'] < value['requestTimeoutSeconds']:
        raise ValueError('Upstream timeout must be shorter than transport and whole request deadlines')
    return value, hashlib.sha256(raw).hexdigest()


def make_logger(config):
    path = Path(config['logPath'])
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    logger = logging.getLogger('rna-openviking-relay-' + str(os.getpid()))
    logger.setLevel(logging.INFO)
    handler = RotatingFileHandler(path, maxBytes=config['logMaxBytes'], backupCount=config['logBackups'])
    os.chmod(path, 0o600)
    handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
    logger.addHandler(handler)
    logger.propagate = False
    return logger


def close_socket(connection):
    try:
        connection.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    connection.close()


def await_managed_owner(config_fingerprint):
    keys = ('RNA_MANAGED_HELPER_ID', 'RNA_MANAGED_HELPER_TOKEN', 'RNA_MANAGED_HELPER_FINGERPRINT', 'RNA_MANAGED_HELPER_OWNER_FILE')
    if not any(os.environ.get(key) for key in keys):
        return
    if not all(os.environ.get(key) for key in keys) or not os.path.isabs(os.environ[keys[3]]):
        raise ValueError('Managed helper ownership is incomplete')
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            owner = json.loads(Path(os.environ[keys[3]]).read_text())
            if owner.get('phase') == 'running' and owner.get('pid') == os.getpid() and owner.get('id') == os.environ[keys[0]] and owner.get('token') == os.environ[keys[1]] and owner.get('fingerprint') == os.environ[keys[2]]:
                if owner.get('descriptor', {}).get('configFingerprint') != config_fingerprint:
                    raise RuntimeError('RELAY_CONFIG_FINGERPRINT_MISMATCH: loaded configuration differs from the managed descriptor')
                return
        except (OSError, ValueError, AttributeError):
            pass
        time.sleep(.05)
    raise RuntimeError('Managed helper ownership was not durably acknowledged')


class RelayServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 16

    def __init__(self, config, logger):
        self.config, self.logger = config, logger
        self.slots = threading.BoundedSemaphore(config['maxConcurrent'])
        self.active, self.processes = set(), set()
        self.guard = threading.Lock()
        self.stopping = False
        super().__init__((config['host'], config['port']), Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.settimeout(.1)
            try:
                request.sendall(b'HTTP/1.0 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\nRetry-After: 1\r\n\r\n')
            except OSError:
                pass
            self.shutdown_request(request)
            self.logger.info('capacity_rejected')
            return
        request.settimeout(self.config['ioTimeoutSeconds'])
        with self.guard:
            self.active.add(request)
        try:
            super().process_request(request, client_address)
        except BaseException:
            with self.guard:
                self.active.discard(request)
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        # Idle socket timeout alone permits a slow client to retain a thread
        # indefinitely. The whole-request deadline also closes slow trickles.
        deadline = threading.Timer(self.config['requestTimeoutSeconds'], close_socket, args=(request,))
        deadline.daemon = True
        deadline.start()
        try:
            super().process_request_thread(request, client_address)
        finally:
            deadline.cancel()
            with self.guard:
                self.active.discard(request)
            self.slots.release()

    def handle_error(self, *_args):
        self.logger.info('request_failed')

    def transport(self, value):
        config = self.config
        env = {key: value for key, value in os.environ.items()
               if key not in {'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'}}
        command = [config['dockerExecutable'], '--host', config['dockerHost'], 'exec', '-i', config['container'], 'python', '-c', REMOTE]
        with self.guard:
            if self.stopping:
                raise OSError('Relay stopping')
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
            self.processes.add(process)
        selector = selectors.DefaultSelector()
        output = bytearray()
        pending = memoryview(json.dumps(value).encode())
        deadline = time.monotonic() + config['transportTimeoutSeconds']
        try:
            os.set_blocking(process.stdin.fileno(), False)
            os.set_blocking(process.stdout.fileno(), False)
            selector.register(process.stdin, selectors.EVENT_WRITE)
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, config['transportTimeoutSeconds'])
                for key, _ in selector.select(min(.1, remaining)):
                    if key.fileobj is process.stdin:
                        count = os.write(process.stdin.fileno(), pending[:65536])
                        pending = pending[count:]
                        if not pending:
                            selector.unregister(process.stdin)
                            process.stdin.close()
                    else:
                        chunk = os.read(process.stdout.fileno(), 65536)
                        if not chunk:
                            selector.unregister(process.stdout)
                        else:
                            output.extend(chunk)
                            if len(output) > (config['maxBytes'] * 4 // 3) + 8192:
                                raise ValueError('Transport output exceeded limit')
            if process.wait(timeout=max(.001, deadline-time.monotonic())) != 0:
                raise ValueError('Transport failed')
            return json.loads(output)
        finally:
            selector.close()
            if process.poll() is None:
                process.kill()
            process.wait()
            for pipe in (process.stdin, process.stdout):
                pipe.close()
            with self.guard:
                self.processes.discard(process)

    def close_owned(self):
        with self.guard:
            self.stopping = True
            connections, processes = list(self.active), list(self.processes)
        for connection in connections:
            close_socket(connection)
        for process in processes:
            if process.poll() is None:
                process.kill()
        for process in processes:
            process.wait(timeout=3)
        self.server_close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def relay(self):
        try:
            route = urlsplit(self.path)
            if self.command == 'GET' and self.path == '/_rna/health':
                identity = None
                if all(os.environ.get(key) for key in ('RNA_MANAGED_HELPER_ID', 'RNA_MANAGED_HELPER_TOKEN', 'RNA_MANAGED_HELPER_FINGERPRINT')):
                    identity = {'id': os.environ['RNA_MANAGED_HELPER_ID'], 'token': os.environ['RNA_MANAGED_HELPER_TOKEN'],
                                'fingerprint': os.environ['RNA_MANAGED_HELPER_FINGERPRINT'], 'pid': os.getpid()}
                body = json.dumps({'ok': True, 'managedHelper': identity}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if route.scheme or route.netloc or route.fragment or any(ord(char) < 32 for char in self.path) or not (route.path.startswith('/api/v1/') or route.path in ('/health', '/ready')):
                self.send_error(404)
                return
            if self.headers.get('Transfer-Encoding'):
                self.send_error(411)
                return
            lengths = self.headers.get_all('Content-Length', [])
            if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]+', lengths[0])):
                self.send_error(400)
                return
            length = int(lengths[0]) if lengths else 0
            config = self.server.config
            if length > config['maxBytes']:
                self.send_error(413)
                return
            body = self.rfile.read(length)
            if len(body) != length:
                self.send_error(400)
                return
            headers = {key: value for key, value in self.headers.items()
                       if key.lower() in {'x-api-key', 'authorization', 'content-type', 'x-openviking-actor-peer', 'x-openviking-account', 'x-openviking-user'}}
            response = self.server.transport({'path': self.path, 'method': self.command, 'headers': headers,
                'body': base64.b64encode(body).decode(), 'timeout': config['upstreamTimeoutSeconds'], 'maxBytes': config['maxBytes']})
            body = base64.b64decode(response['body'], validate=True)
            content_type = response.get('content_type', 'application/json')
            if len(body) > config['maxBytes'] or type(response['status']) is not int or not 100 <= response['status'] <= 599 or not isinstance(content_type, str) or '\r' in content_type or '\n' in content_type:
                raise ValueError('Invalid transport response')
            self.send_response(response['status'])
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.server.logger.info('client_disconnected')
        except (subprocess.SubprocessError, ValueError, KeyError, TypeError, OSError) as error:
            self.server.logger.info('transport_unavailable %s', type(error).__name__)
            try:
                self.send_error(502, 'Official OpenViking container transport unavailable')
            except OSError:
                pass

    do_GET = relay
    do_POST = relay
    do_PUT = relay
    do_PATCH = relay
    do_DELETE = relay


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config, config_fingerprint = load_config(args.config)
    # No listener or transport child is created until the supervisor has
    # durably recorded this exact PID and generation. A crashed spawn window
    # therefore cannot leave an unowned relay accepting credentials.
    await_managed_owner(config_fingerprint)
    logger = make_logger(config)
    server = RelayServer(config, logger)
    server.timeout = .25
    stopped = threading.Event()
    for name in (signal.SIGTERM, signal.SIGINT):
        signal.signal(name, lambda *_: stopped.set())
    logger.info('relay_started')
    bootstrap_parent = int(os.environ.get('RNA_RELAY_BOOTSTRAP_PARENT_PID', '0'))
    try:
        while not stopped.is_set():
            if bootstrap_parent and os.getppid() != bootstrap_parent:
                break
            server.handle_request()
    finally:
        server.close_owned()
        logger.info('relay_stopped')


if __name__ == '__main__':
    main()
