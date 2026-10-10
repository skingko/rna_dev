import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THINKING_REBASE_REASONS } from '../src/anthropic-history.mjs';
import * as context from '../src/context.mjs';
import { MIND_ROW_SOURCES, MIND_ROW_SOURCE_CHARS } from '../src/decision-state.mjs';

// The SDK's typings follow what the revocation work (C4) added to it: a host written against index.d.ts sees `revokeContext`, the
// `context_revoke` event, source ids on updates and compaction records, and the `revoked` rebase and fold reasons. There is no type
// checker over a JavaScript package, so this reads the declarations against the runtime.
const declarations = readFileSync(new URL('../src/index.d.ts', import.meta.url), 'utf8');
const stateDeclarations = readFileSync(new URL('../src/decision-state.d.ts', import.meta.url), 'utf8');

test('THINKING_REBASE_REASONS is declared with every reason the runtime has, revoked included', () => {
  const declared = /export const THINKING_REBASE_REASONS: ReadonlyArray<([^>]+)>;/.exec(declarations)?.[1];
  assert.ok(declared, 'the declaration exists');
  assert.deepEqual([...declared.matchAll(/'([a-z_]+)'/g)].map(row => row[1]).sort(), [...THINKING_REBASE_REASONS].sort());
  assert.ok(THINKING_REBASE_REASONS.includes('revoked'));
});

test('the revocation surface is declared: the hook field, the event, source ids on updates and compaction records, the helpers', () => {
  for (const name of ['revokeTargets', 'compactionSources', 'compactionTainted']) assert.equal(typeof context[name], 'function', `${name} exists`), assert.match(declarations, new RegExp(`export function ${name}\\(`), `${name} is declared`);
  assert.match(declarations, new RegExp(`export const COMPACTION_SOURCE_IDS_LIMIT: ${context.COMPACTION_SOURCE_IDS_LIMIT};`), 'the cap is declared with its value');
  assert.match(declarations, /export interface ContextRevocation \{ id\?: string; contextKeys\?: string\[\]; sourceIds\?: string\[\]; before\?: number \}/);
  assert.match(declarations, /revokeContext\?: ContextRevocation\[\]/, 'the request hook may return it');
  assert.match(declarations, /\| \{ type: 'context_revoke'; transient: true; ids: string\[\]; folded: number; summaries: string\[\]; withdrawn: string\[\] \}/, 'the event is in SessionEvent');
  assert.match(declarations, /export type ContextUpdate = ContextAttachment & \{[^}]*sourceIds\?: string\[\]/, 'updates carry source ids');
  assert.match(declarations, /sourceIds\?: string\[\]; sourceIdsTruncated\?: boolean;/, 'compaction records list the ids they archived');
  assert.match(declarations, /code: 'stale_base' \| 'not_smaller' \| 'superseded' \| 'revoked'/, 'a prepared summary can be discarded as revoked');
  assert.equal(typeof context.SUMMARY_WITHDRAWN_TEXT, 'string'); assert.match(declarations, /export const SUMMARY_WITHDRAWN_TEXT: string;/);
  assert.match(declarations, /export type CompactionTrigger = [^;]*'revoked';/, 'a withdrawal record has its own trigger'); assert.match(declarations, /withdrew\?: string;/);
  assert.match(declarations, /foldedContextText\(key: string, kind\?: 'superseded' \| 'turn' \| 'revoked'\)/);
  assert.match(stateDeclarations, new RegExp(`MIND_ROW_SOURCES: ${MIND_ROW_SOURCES};`)); assert.match(stateDeclarations, new RegExp(`MIND_ROW_SOURCE_CHARS: ${MIND_ROW_SOURCE_CHARS};`));
});
