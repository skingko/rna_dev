import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const guardianFile = fileURLToPath(import.meta.url);
const grouped = process.platform !== 'win32';
const signalCode = signal => 128 + (osConstants.signals[signal] ?? 0);
const killGroup = (pid, signal) => {
  if (!pid) return;
  try {
    if (grouped) process.kill(-pid, signal);
    else {
      const taskkill = join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'taskkill.exe');
      const killer = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => { try { process.kill(pid, signal); } catch {} }); killer.unref();
    }
  } catch (error) { if (error.code !== 'ESRCH') { try { process.kill(pid, signal); } catch {} } }
};

/** A separate IPC channel owns lifetime: ending command stdin is ordinary EOF.
 * The returned ChildProcess exposes the original command outcome separately
 * from the guardian's own PID/exit, and stop() requests bounded group cleanup.
 */
export function spawnGuardedCommand(command, args, { cwd, env = process.env } = {}) {
  // The command keeps its requested environment, but Node preload variables
  // and dynamic-loader injection must not run inside the trusted guardian.
  const guardianEnv = { PATH: dirname(process.execPath) };
  for (const name of ['SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']) if (process.env[name]) guardianEnv[name] = process.env[name];
  const child = spawn(process.execPath, [guardianFile, '--rna-command-guardian', String(process.pid)], { cwd, env: guardianEnv, detached: grouped, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.commandResult = { started: false, startUncertain: false, pid: null, exitCode: null, signal: null, cleanedGroup: false, cleanupUncertain: false, outputIncomplete: false, error: null };
  let fallback, stopping = false, startDispatched = false;
  const noteUncertainty = () => {
    child.commandResult.cleanupUncertain ||= startDispatched && !child.commandResult.cleanedGroup;
    child.commandResult.startUncertain ||= startDispatched && !child.commandResult.started && !child.commandResult.error && !child.commandResult.cleanedGroup;
  };
  const send = message => { if (child.connected) child.send(message, error => { if (error) child.stop(); }); };
  child.stop = () => {
    if (stopping || child.exitCode !== null || child.signalCode !== null) return;
    stopping = true; send({ type: 'stop' });
    // The guardian normally escalates in 300ms and bounds drain to 1500ms.
    // A delayed parent fallback no longer owns the command's numeric PID or
    // group ID. If the guardian cannot confirm cleanup, report uncertainty;
    // never guess a stale command identity and signal an unrelated process.
    fallback = setTimeout(() => {
      noteUncertainty();
      child.commandResult.outputIncomplete = true;
      try { child.kill('SIGKILL'); } catch {}
      child.stdout.destroy(); child.stderr.destroy();
    }, 2200);
  };
  child.on('message', message => {
    if (message?.type === 'command_started' && Number.isSafeInteger(message.pid) && message.pid > 0) Object.assign(child.commandResult, { started: true, pid: message.pid });
    else if (message?.type === 'command_exit') Object.assign(child.commandResult, { exitCode: Number.isInteger(message.code) ? message.code : null, signal: typeof message.signal === 'string' ? message.signal : null });
    else if (message?.type === 'command_error') child.commandResult.error = Object.assign(new Error(message.message), { code: message.code });
    else if (message?.type === 'group_cleaned') child.commandResult.cleanedGroup = true;
    else if (message?.type === 'cleanup_uncertain') child.commandResult.cleanupUncertain = true;
    else if (message?.type === 'output_incomplete') child.commandResult.outputIncomplete = true;
  });
  child.once('spawn', () => { startDispatched = child.connected; send({ type: 'start', command, args, cwd, env }); });
  child.once('exit', (code, signal) => {
    const expected = child.commandResult.exitCode ?? (child.commandResult.signal ? signalCode(child.commandResult.signal) : null);
    if (child.commandResult.started && (expected === null || signal || code !== expected)) child.commandResult.outputIncomplete = true;
    noteUncertainty();
    child.commandResult.outputIncomplete ||= child.commandResult.startUncertain;
    // A disappeared guardian cannot drain a stalled reader. Bound close even
    // when the caller paused output, while explicitly marking the loss.
    if (child.commandResult.outputIncomplete) { child.stdout.destroy(); child.stderr.destroy(); }
    clearTimeout(fallback);
  });
  child.once('close', () => { clearTimeout(fallback); });
  return child;
}

function runGuardian(parentPid) {
  if (!Number.isSafeInteger(parentPid) || parentPid < 1 || !process.connected || process.ppid !== parentPid) { process.exitCode = 125; if (process.connected) process.disconnect(); return; }
  let command, stopping = false, exited = false, closed = false, cleaned = false, finishing = false;
  let exitCode = 125, termTimer, hardTimer, cleanupTimer, killRequested = false;
  let pendingMessages = 0, outputDrained = false;
  const exitWhenFlushed = () => {
    if (!finishing || !outputDrained || pendingMessages) return;
    clearTimeout(hardTimer);
    if (process.connected) { try { process.disconnect(); } catch {} }
    process.exit(exitCode);
  };
  const tell = (message, callback) => {
    if (!process.connected) { callback?.(); return; }
    pendingMessages++;
    const sent = () => { pendingMessages--; callback?.(); exitWhenFlushed(); };
    try { process.send(message, sent); } catch { sent(); }
  };
  const checkCleaned = () => {
    if (cleaned) return;
    let absent = !command?.pid;
    if (!absent) { try { process.kill(grouped ? -command.pid : command.pid, 0); } catch (error) { absent = error.code === 'ESRCH'; } }
    if (!absent) return;
    cleaned = true; clearInterval(cleanupTimer); tell({ type: 'group_cleaned' }); finish();
  };
  const killRemaining = () => {
    if (cleaned) return;
    // Signal once from the owning guardian's exit/stop path. Subsequent
    // polls only verify absence; a successful kill call is not proof of it.
    if (!killRequested) { killRequested = true; killGroup(command?.pid, 'SIGKILL'); }
    checkCleaned();
    if (!cleaned) cleanupTimer ??= setInterval(checkCleaned, 20);
  };
  const closeInput = () => { if (command) { process.stdin.unpipe(command.stdin); command.stdin.destroy(); } process.stdin.destroy(); };
  const finish = () => {
    if (finishing || !closed || !cleaned) return;
    finishing = true; closeInput(); clearTimeout(termTimer); clearTimeout(startTimer); clearInterval(parentWatch); clearInterval(cleanupTimer);
    // write callbacks run only after earlier pipe writes have drained. Keep
    // the hard deadline alive if the reader disappeared or stopped consuming.
    let pending = 2;
    const drained = () => { if (--pending) return; outputDrained = true; exitWhenFlushed(); };
    for (const output of [process.stdout, process.stderr]) { if (output.destroyed) drained(); else output.write('', drained); }
  };
  const deadline = () => {
    hardTimer ??= setTimeout(() => { tell({ type: 'output_incomplete' }); killRemaining(); if (!cleaned) tell({ type: 'cleanup_uncertain' }); closeInput(); process.exit(124); }, 1500);
  };
  const stop = () => {
    if (stopping) return;
    stopping = true; clearTimeout(startTimer); closeInput(); deadline();
    if (!command) { closed = true; cleaned = true; tell({ type: 'group_cleaned' }); finish(); return; }
    if (!exited) killGroup(command.pid, 'SIGTERM'); else killRemaining();
    termTimer = setTimeout(() => { killRemaining(); finish(); }, 300);
  };
  const parentWatch = setInterval(() => { if (process.ppid !== parentPid || !process.connected) stop(); }, 250);
  const startTimer = setTimeout(stop, 3000);
  process.on('disconnect', stop);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
  for (const output of [process.stdout, process.stderr]) output.on('error', () => { tell({ type: 'output_incomplete' }); stop(); });
  process.stdin.on('error', () => { command?.stdin.end(); });
  process.on('message', message => {
    if (message?.type === 'stop') { stop(); return; }
    if (message?.type !== 'start' || command || stopping) return;
    clearTimeout(startTimer);
    if (process.ppid !== parentPid || !process.connected) { stop(); return; }
    if (typeof message.command !== 'string' || !Array.isArray(message.args) || message.args.some(value => typeof value !== 'string')) { stop(); return; }
    try { command = spawn(message.command, message.args, { cwd: message.cwd, env: message.env, shell: false, detached: grouped, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { tell({ type: 'command_error', code: error.code || 'spawn_failed', message: `Command could not start (${error.code || 'spawn_failed'})` }); closed = true; stop(); return; }
    command.once('spawn', () => tell({ type: 'command_started', pid: command.pid }));
    command.once('error', error => { tell({ type: 'command_error', code: error.code || 'spawn_failed', message: `Command could not start (${error.code || 'spawn_failed'})` }); exitCode = 127; stop(); });
    // stdin EOF is a normal command input boundary; only IPC/parent loss stops
    // ownership. A program may close its own stdin and still produce output.
    command.stdin.on('error', () => { process.stdin.unpipe(command.stdin); process.stdin.destroy(); });
    process.stdin.pipe(command.stdin);
    command.stdout.pipe(process.stdout, { end: false }); command.stderr.pipe(process.stderr, { end: false });
    command.once('exit', (code, signal) => {
      exited = true; exitCode = code ?? signalCode(signal); tell({ type: 'command_exit', code, signal });
      // Ordinary descendants may keep stdio open after the root exits. Kill
      // that owned group immediately, before its numeric ID can be reused.
      killRemaining(); clearTimeout(termTimer); deadline();
    });
    command.once('close', () => { closed = true; if (!cleaned) killRemaining(); deadline(); finish(); });
  });
}

let ownEntry = false;
try { ownEntry = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(guardianFile); } catch {}
if (ownEntry && process.argv[2] === '--rna-command-guardian') runGuardian(Number(process.argv[3]));
