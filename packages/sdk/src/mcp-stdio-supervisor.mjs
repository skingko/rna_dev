import { spawn } from 'node:child_process';

// Each client owns this detached wrapper. Its server owns a separate process
// group. If the SDK host dies (including SIGKILL), stdin EOF or parent loss
// still reaches this wrapper, which can terminate that owned group.
const [parentText, command, ...args] = process.argv.slice(2);
const parentPid = Number(parentText);
if (!Number.isSafeInteger(parentPid) || parentPid < 1 || !command) process.exit(64);
const grouped = process.platform !== 'win32';
let closing = false, exited = false, cleanedGroup = false, exitCode = 0, termTimer, hardTimer;
const server = spawn(command, args, { shell: false, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
const kill = signal => {
  if (!server.pid || cleanedGroup) return;
  try { if (grouped) process.kill(-server.pid, signal); else server.kill(signal); } catch (error) { if (error.code !== 'ESRCH') { try { server.kill(signal); } catch {} } }
};
const killRemaining = () => { kill('SIGKILL'); cleanedGroup = true; };
const finish = () => {
  closing = true;
  clearInterval(parentWatch); clearTimeout(termTimer); clearTimeout(hardTimer);
  process.stdin.unpipe(server.stdin); process.stdin.destroy(); server.stdin.destroy();
  // Let Node drain writes to stdout/stderr, preserving standard pipe backpressure.
  process.exitCode = exitCode;
};
const stop = () => {
  if (closing) return;
  closing = true; process.stdin.unpipe(server.stdin); server.stdin.end(); if (!exited) kill('SIGTERM');
  termTimer = setTimeout(killRemaining, 500);
  hardTimer = setTimeout(() => { killRemaining(); process.exit(exited ? exitCode : 137); }, 1500);
};
const parentWatch = setInterval(() => { if (process.ppid !== parentPid) stop(); }, 250);
process.stdin.pipe(server.stdin);
server.stdout.pipe(process.stdout, { end: false });
server.stderr.pipe(process.stderr, { end: false });
process.stdin.on('end', stop); process.stdin.on('error', stop);
server.stdin.on('error', stop); process.stdout.on('error', stop); process.stderr.on('error', stop);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
server.once('error', () => { exitCode = 127; stop(); });
server.once('exit', (code, signal) => {
  exited = true; exitCode = code ?? ({ SIGINT: 130, SIGTERM: 143, SIGKILL: 137 }[signal] ?? 1);
  // Descendants may still hold stdout/stderr after their root exits.
  clearTimeout(termTimer); killRemaining();
});
server.once('close', finish);
