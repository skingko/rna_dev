import { Script } from 'node:vm';

/**
 * The most one generated-script file read may return, and the most one execution may read in all. This module is the
 * one both the host (the API contract it prints, project-genome.mjs) and the restricted child (project-genome-worker.mjs,
 * the only enforcer) already load, so the number a script author is told and the number the worker enforces are one.
 *
 * The per-file bound is the host's own: tool-policy.mjs takes a guard's pre-write baseline of any file up to 1 MiB, and mu's
 * language-server hook reads files up to 2,000,000 bytes (references/mu kyrn lsp.ts maxFileBytes) and skips a larger one
 * rather than reporting on it. It used to be 64,000, which a project's own index or progress file outgrows (a 67,561 byte
 * index made a dedupe check report "missing or unreadable"; a novel's progress file is 119,948 bytes).
 * The per-execution budget is what 50 file operations could read before the per-file bound was raised (50 x 64,000):
 * the worker's memory ceiling (--max-old-space-size=64) is the one it always had, so no script that ran before can run
 * out of memory now, and a script that read many files still reads them all.
 */
export const GENOME_READ_LIMIT_BYTES = 1024 * 1024;
export const GENOME_READ_BUDGET_BYTES = 50 * 64000;

/** Parse exactly the same function body that the restricted child executes.
 * Compiling does not run generated code or load imports. Never strip wrappers:
 * rewriting arbitrary source would change what the author actually proposed. */
export function compileGenomeScript(script, input) {
  if (typeof script !== 'string' || !script.length || script.length > 16000) throw Object.assign(new Error('Generated script must be a nonempty function body within 16,000 characters'), { code: 'script_syntax', phase: 'compile' });
  try {
    return new Script(`(async (input, api) => { 'use strict';\n${script}\n})(JSON.parse(${JSON.stringify(JSON.stringify(input))}), api)`, { filename: 'generated-project-tool.mjs' });
  } catch (failure) {
    const line = Number(String(failure.stack).match(/^generated-project-tool\.mjs:(\d+)/)?.[1]);
    throw Object.assign(new Error(String(failure.message).slice(0, 500)), { code: 'script_syntax', phase: 'compile', ...(line > 1 ? { line: line - 1 } : {}) });
  }
}
