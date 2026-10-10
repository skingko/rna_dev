import { realpathSync, statSync, existsSync } from 'node:fs';
import { readdir, stat, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

function invalid(message, status = 400, code = 'invalid_workspace') {
  return Object.assign(new Error(message), { status, code });
}

// Same identity rule as Harness: a real, absolute directory, with symlinks resolved.
export function canonicalDirectory(path) {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0') || !isAbsolute(path)) throw invalid('请选择或输入真实目录的绝对路径');
  try {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw invalid('所选路径不是目录');
    return canonical;
  } catch (error) {
    if (error.status) throw error;
    throw invalid(error.code === 'ENOENT' ? '目录不存在，请选择现有目录或先新建文件夹' : '无法访问此目录，请检查系统文件访问权限', error.code === 'ENOENT' ? 404 : 403);
  }
}

// Legacy projects used a cwd-relative label. Match the existing RuntimeController
// and CapabilityService resolution without rewriting the historical record.
export function registeredWorkspacePath(value) {
  if (typeof value !== 'string') throw invalid('工作目录必须为文本');
  if (isAbsolute(value)) return value;
  const root = resolve(import.meta.dirname, '../..');
  if (value === 'Pi_agent') return root;
  return existsSync(resolve(root, value)) ? resolve(root, value) : resolve(value);
}

export function workspaceText(value, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw invalid(`工作目录必须为 1–${max} 字符的路径`);
  return value; // Whitespace is legal in an actual filename; trimming changes identity.
}

export function matchingWorkspaces(projects, canonical) {
  return projects.filter(project => {
    try { return canonicalDirectory(registeredWorkspacePath(project.workspace)) === canonical; }
    catch { return false; } // Missing historical folders stay registered; never recreate/migrate them.
  });
}

export async function browseDirectories(input = {}) {
  const path = canonicalDirectory(input.path ?? homedir());
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('无效的目录分页位置');
  const rows = await readdir(path, { withFileTypes: true }).catch(() => { throw invalid('无法浏览此目录，请检查系统文件访问权限', 403); });
  const candidates = rows.filter(row => (input.hidden === true || !row.name.startsWith('.')) && (row.isDirectory() || row.isSymbolicLink())).sort((a, b) => a.name.localeCompare(b.name));
  // Bound metadata reads per request. Symlink targets are checked before listing as a folder.
  const page = candidates.slice(offset, offset + 200);
  const entries = (await Promise.all(page.map(async row => {
    const child = join(path, row.name);
    if (row.isSymbolicLink() && !await stat(child).then(value => value.isDirectory(), () => false)) return null;
    return { name: row.name, path: child, symlink: row.isSymbolicLink() };
  }))).filter(Boolean);
  return { path, name: basename(path) || path, parent: dirname(path) === path ? null : dirname(path), entries, nextOffset: offset + page.length < candidates.length ? offset + page.length : null };
}

export async function createDirectory(input) {
  const parent = canonicalDirectory(input.parent), name = input.name;
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[/\\\0]/.test(name) || name.length > 255) throw invalid('请输入单个文件夹名称，不能包含路径分隔符');
  const path = join(parent, name);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { throw invalid(error.code === 'EEXIST' ? '此名称已存在' : '无法创建文件夹，请检查系统文件访问权限', error.code === 'EEXIST' ? 409 : 403); }
  return { path: canonicalDirectory(path) };
}
