// Serialized as a builtin-only `node -e` program. It deliberately does not
// import application code: an import denied by macOS must still yield a receipt.
// Reads never execute SDK/host modules or inspect credentials/project contents.
export function nativeProbeMain() {
  const fs = require('node:fs'), path = require('node:path');
  const input = JSON.parse(process.argv[1]), started = Date.now(), checks = [];
  const classify = error => ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EIO'].includes(error?.code) ? error.code : 'READ_FAILED';
  const check = (name, target, directory = false) => {
    let fd;
    try {
      const info = fs.lstatSync(target);
      if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || !directory && info.nlink !== 1) throw Object.assign(new Error(), { code: 'ELOOP' });
      if (directory) {
        // Opening and enumerating proves this native context can traverse the
        // directory; names are discarded, never copied into the receipt.
        const dir = fs.opendirSync(target); try { dir.readSync(); } finally { dir.closeSync(); }
      } else {
        fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error(), { code: 'ELOOP' });
        fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
      }
      checks.push({ name, ok: true });
    } catch (error) { checks.push({ name, ok: false, errorCode: classify(error) }); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  check('runtime_directory', input.hostDirectory, true);
  check('supervisor_entry', path.join(input.hostDirectory, 'daemon-supervisor.mjs'));
  check('host_entry', path.join(input.hostDirectory, 'server.mjs'));
  check('sdk_entry', input.sdkEntry);
  check('state_directory', path.dirname(input.stateFile), true);
  check('application_state', input.stateFile);
  check('service_directory', input.serviceDirectory, true);
  check('service_configuration', path.join(input.serviceDirectory, 'config.json'));
  const status = checks.every(row => row.ok) ? 'passed' : checks.some(row => ['EACCES', 'EPERM'].includes(row.errorCode)) ? 'access_denied' : 'failed';
  const receipt = { schemaVersion: 1, probeId: input.probeId, operationId: input.operationId, candidateId: input.candidateId, digest: input.digest,
    nonce: input.nonce, pid: process.pid, status, checks, elapsedMs: Math.min(60000, Date.now() - started) };
  // Written whole, then renamed into place: the host polls this path and must never read a half-written receipt.
  const partial = `${input.receipt}.${process.pid}.partial`;
  const fd = fs.openSync(partial, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(receipt)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(partial, input.receipt);
}

export const NATIVE_PROBE_SOURCE = `(${nativeProbeMain.toString()})();`;
