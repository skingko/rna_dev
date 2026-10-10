import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('model_download',Path(__file__).resolve().parents[1]/'download-openviking-model.py')
MODULE=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(MODULE)


class VerifiedDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.cache=Path(self.temp.name)
        self.data=('真实模型下载协议fixture'.encode()*31);self.calls=[];self.mode='valid'
        test=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                value=self.headers.get('Range');test.calls.append(value)
                first,last=map(int,value.removeprefix('bytes=').split('-'));body=test.data[first:last+1]
                self.send_response(200 if test.mode=='ignore_range' else 206)
                self.send_header('Content-Range',f'bytes {first}-{last}/{len(test.data)}')
                if test.mode=='corrupt':body=bytes([body[0]^1])+body[1:]
                self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.patches=[patch.object(MODULE,'CACHE',self.cache),patch.object(MODULE,'BASE',f'http://127.0.0.1:{self.server.server_port}/'),patch.object(MODULE,'CHUNK',256),patch.object(MODULE.time,'sleep',return_value=None)]
        for item in self.patches:item.start()
        self.entry={'size':len(self.data),'digest':'sha256:'+hashlib.sha256(self.data).hexdigest()}
        self.target=self.cache/'blobs'/self.entry['digest'].replace(':','-')

    def tearDown(self):
        for item in self.patches:item.stop()
        self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()

    def download(self):
        with contextlib.redirect_stdout(io.StringIO()):MODULE.download_blob(self.entry)

    def test_real_http_ranges_publish_only_after_full_hash_and_cached_hit_never_downloads(self):
        self.download();self.assertEqual(self.target.read_bytes(),self.data)
        self.assertGreater(len(self.calls),1);self.assertEqual(self.target.stat().st_mode & 0o777,0o600)
        count=len(self.calls);self.download();self.assertEqual(len(self.calls),count)
        self.assertFalse(self.target.with_suffix('.part').exists())

    def test_ignored_range_never_publishes(self):
        self.mode='ignore_range'
        with self.assertRaisesRegex(RuntimeError,'unexpected range'):self.download()
        self.assertFalse(self.target.exists())

    def test_correct_ranges_with_corrupt_bytes_fail_complete_digest(self):
        self.mode='corrupt'
        with self.assertRaisesRegex(RuntimeError,'Full model SHA-256 mismatch'):self.download()
        self.assertFalse(self.target.exists())
        self.assertFalse(self.target.with_suffix('.progress.json').exists())
        self.mode='valid';self.download();self.assertEqual(self.target.read_bytes(),self.data)

    def test_resume_revalidates_saved_chunk_bytes_before_trusting_progress(self):
        self.target.parent.mkdir();partial=self.target.with_suffix('.part')
        partial.write_bytes(self.data[:256]+b'\0'*(len(self.data)-256))
        progress=self.target.with_suffix('.progress.json')
        MODULE.LOCAL.write_private(progress,{'0':hashlib.sha256(self.data[:256]).hexdigest(),'1':'wrong-stale-hash'})
        self.download();self.assertEqual(self.target.read_bytes(),self.data)
        self.assertNotIn('bytes=0-255',self.calls)
        self.assertIn('bytes=256-511',self.calls)


if __name__=='__main__':unittest.main()
