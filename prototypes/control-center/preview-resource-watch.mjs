/** Watch only resources requested from this preview, including allowed files
 * not yet created. Metadata reads retain the workspace path/identity checks. */
export class PreviewResourceWatch {
  constructor({ inspect, changed, failed, intervalMs = 500, limit = 256 }) {
    this.inspect = inspect; this.changed = changed; this.failed = failed; this.limit = limit;
    this.resources = new Map(); this.closed = false; this.pending = null; this.truncated = false;
    this.timer = setInterval(() => void this.poll(), intervalMs); this.timer.unref?.();
  }
  add(path, version) {
    if (this.closed) return;
    if (!this.resources.has(path) && this.resources.size >= this.limit) { this.truncated = true; return; }
    // A response to a newer read must also invalidate existing viewing clients.
    const previous = this.resources.get(path);
    this.resources.set(path, version);
    if (previous !== undefined && previous !== version) this.changed();
  }
  poll() {
    if (this.closed || this.pending) return this.pending;
    this.pending = (async () => {
      let changed = false;
      for (const [path, previous] of [...this.resources]) {
        if (this.closed) return;
        let version;
        try { version = await this.inspect(path); }
        catch (error) {
          if (['ENOENT', 'ENOTDIR', 'WORKSPACE_NOT_FOUND'].includes(error.code)) version = 'missing';
          else { if (!this.closed) this.failed(error); return; }
        }
        if (this.closed) return;
        // A later completed response wins over an older in-flight stat.
        if (this.resources.get(path) !== previous) continue;
        if (previous !== version) { this.resources.set(path, version); changed = true; }
      }
      if (changed && !this.closed) this.changed();
    })().catch(error => { if (!this.closed) this.failed(error); }).finally(() => { this.pending = null; });
    return this.pending;
  }
  close() { this.closed = true; clearInterval(this.timer); this.resources.clear(); }
}
