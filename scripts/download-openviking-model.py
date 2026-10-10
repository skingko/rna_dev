#!/usr/bin/env python3
"""Download only the pinned official BGE-M3 model; publish after full SHA-256 verification."""
import concurrent.futures
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('ov_local', ROOT/'scripts/openviking-local.py')
LOCAL = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(LOCAL)
BASE = 'https://registry.ollama.ai/v2/library/bge-m3/'
CACHE = ROOT/'deploy/openviking/.runtime/semantic/ollama-models'
CHUNK = 8*1024*1024


def digest(path):
    value=hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda:source.read(1024*1024),b''):value.update(chunk)
    return 'sha256:'+value.hexdigest()


def download_blob(entry):
    identity=entry['digest']; size=entry['size']; target=CACHE/'blobs'/identity.replace(':','-')
    target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    if target.exists() and target.stat().st_size==size and digest(target)==identity:
        print('Verified cached blob '+identity[:19],flush=True);return
    temporary=target.with_suffix('.part'); progress=target.with_suffix('.progress.json')
    completed=json.loads(progress.read_text()) if progress.exists() and temporary.exists() else {}
    fd=os.open(temporary,os.O_RDWR|os.O_CREAT,0o600);os.ftruncate(fd,size)
    lock=threading.Lock(); stopped=threading.Event(); started=time.monotonic()
    try:
        def chunk(index):
            if stopped.is_set():raise RuntimeError('Download cancelled after a failed range')
            start=index*CHUNK; end=min(size,start+CHUNK)-1; expected=end-start+1
            old=completed.get(str(index))
            if old and hashlib.sha256(os.pread(fd,expected,start)).hexdigest()==old:return
            for attempt in range(3):
                if stopped.is_set():raise RuntimeError('Download cancelled after a failed range')
                chunk_started=time.monotonic()
                try:
                    # Some network caches incorrectly reuse a ranged response
                    # across Range headers. A public per-range query prevents
                    # this; Content-Range remains mandatory, never trusted by size.
                    url=BASE+'blobs/'+identity+f'?rna_part={start}-{end}-{attempt}'
                    request=urllib.request.Request(url,headers={'Range':f'bytes={start}-{end}','Cache-Control':'no-cache'})
                    hashed=hashlib.sha256();received=0
                    with urllib.request.urlopen(request,timeout=40) as response:
                        if response.status!=206 or response.headers.get('Content-Range')!=f'bytes {start}-{end}/{size}':
                            raise RuntimeError('Official download returned an unexpected range')
                        while received<expected:
                            if time.monotonic()-chunk_started>180:raise TimeoutError('Chunk deadline exceeded')
                            data=response.read(min(1024*1024,expected-received))
                            if not data:raise RuntimeError('Truncated model range')
                            hashed.update(data); written=0
                            while written<len(data):written+=os.pwrite(fd,data[written:],start+received+written)
                            received+=len(data)
                    with lock:
                        os.fsync(fd); completed[str(index)]=hashed.hexdigest();LOCAL.write_private(progress,completed)
                        print(f'BGE-M3 {min(size,len(completed)*CHUNK)/1e6:.1f}/{size/1e6:.1f} MB; {time.monotonic()-started:.0f}s',flush=True)
                    return
                except Exception:
                    if attempt==2:
                        stopped.set();raise
                    time.sleep(2**(attempt+1))
        # Independent ranges keep RAM bounded (at most 8 x 1 MiB read buffers).
        # Each attempt is bounded by a request timeout and whole-chunk deadline.
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(chunk,range((size+CHUNK-1)//CHUNK)))
        os.fsync(fd)
    finally:os.close(fd)
    if temporary.stat().st_size!=size or digest(temporary)!=identity:
        # Per-range hashes prove disk continuity, not publisher authenticity.
        # A failed global hash must not make the same invalid chunks resumable.
        progress.unlink(missing_ok=True)
        raise RuntimeError('Full model SHA-256 mismatch; partial download was not published')
    os.replace(temporary,target);progress.unlink(missing_ok=True)
    print('Verified full official blob '+identity,flush=True)


def prepare_model_store():
    CACHE.mkdir(parents=True,exist_ok=True,mode=0o700)
    with urllib.request.urlopen(BASE+'manifests/latest',timeout=40) as response:raw=response.read(1024*1024)
    if 'sha256:'+hashlib.sha256(raw).hexdigest()!=LOCAL.MODEL_DIGEST:
        raise RuntimeError('Official model manifest changed; refusing unpinned weights')
    manifest=json.loads(raw)
    for item in [manifest['config'],*manifest['layers']]:download_blob(item)
    path=CACHE/'manifests/registry.ollama.ai/library/bge-m3/latest'
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=path.with_name(path.name+'.tmp')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'wb') as output:output.write(raw);output.flush();os.fsync(output.fileno())
    os.replace(temporary,path)
    fd=os.open(path.parent,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)
    print('Pinned BGE-M3 model store verified and ready: '+str(CACHE),flush=True)


def main():
    CACHE.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd=os.open(CACHE/'.download.lock',os.O_RDWR|os.O_CREAT,0o600)
    try:
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('Another model download already owns this destination')
        prepare_model_store()
    finally:os.close(fd)


if __name__=='__main__':main()
