import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { freshRealUsage, migrateRealBudgets, reserveRealTokens, chargeRealTokens, releaseRealTokens, realBudgetRemaining } from '../budget-service.mjs';
import { readStateFile, readStateText } from '../state-shards.mjs';
const now = Date.parse('2026-09-24T12:00:00Z');
const state = () => ({ settings: { realTokenBudget: null, tokenBudget: 100000 }, usage: { day: '2026-09-24', tokens: 104990, usd: 1 }, realUsage: freshRealUsage(now), sessions: [], projects: [] });
test('uncapped real usage remains measured and separate from exhausted demo counters', () => {
  const s = state(); reserveRealTokens(s, 'request:a', 900000, { now }); chargeRealTokens(s, 200000, { now }); releaseRealTokens(s, 'request:a', { now });
  assert.equal(realBudgetRemaining(s, { now }), Infinity); assert.equal(s.realUsage.tokens, 200000); assert.equal(s.realUsage.reportedTokens, 200000); assert.equal(s.usage.tokens, 104990);
});
test('independent reservations enforce an explicit cap and reconcile without double charging', () => {
  const s = state(); s.settings.realTokenBudget = 100;
  reserveRealTokens(s, 'request:a', 60, { now }); assert.throws(() => reserveRealTokens(s, 'initialize:p', 41, { now }), { code: 'budget' });
  reserveRealTokens(s, 'initialize:p', 40, { now }); assert.equal(realBudgetRemaining(s, { now }), 0);
  releaseRealTokens(s, 'request:a', { now }); chargeRealTokens(s, 20, { now });
  assert.equal(realBudgetRemaining(s, { now }), 40); assert.equal(s.realUsage.tokens, 20); assert.equal(s.realUsage.reservedTokens, 40);
  s.settings.realTokenBudget = 1; reserveRealTokens(s, 'initialize:p', 30, { now }); // Existing reservation can shrink after a cap edit.
  releaseRealTokens(s, 'initialize:p', { now }); assert.equal(s.realUsage.reservedTokens, 0);
});
test('UTC day rollover resets consumption but preserves concurrent request reservations', () => {
  const s = state(); s.settings.realTokenBudget = 100; chargeRealTokens(s, 50, { now }); reserveRealTokens(s, 'request:a', 40, { now });
  const tomorrow = now + 86400000; assert.equal(realBudgetRemaining(s, { now: tomorrow }), 60);
  releaseRealTokens(s, 'request:a', { now: tomorrow }); chargeRealTokens(s, 20, { now: tomorrow }); assert.equal(s.realUsage.tokens, 20);
});
test('migration archives ambiguous mixed history and only reconstructs dated real receipts', () => {
  const s = state(); delete s.realUsage; delete s.settings.realTokenBudget;
  s.sessions = [{ turns: [{ modelConfig: { execution: 'rna' }, completedAt: new Date(now).toISOString(), usage: { totalTokens: 50 } }, { modelConfig: { execution: 'simulation' }, completedAt: new Date(now).toISOString(), usage: { totalTokens: 1000 } }] }];
  s.projects = [{ simulated: false, initiative: { tokenBudget: 50000 }, initialization: { completedAt: new Date(now).toISOString(), usage: { totalTokens: 20 } } }, { simulated: false, initiative: { tokenBudget: 76543 } }, { simulated: true, initiative: { tokenBudget: 50000 } }];
  migrateRealBudgets(s, now); assert.equal(s.settings.realTokenBudget, null); assert.equal(s.realUsage.tokens, 70); assert.equal(s.realUsage.coverage, 'partial-legacy'); assert.equal(s.usage.tokens, 0); assert.equal(s.budgetMigration.legacyUsage.tokens, 104990);
  assert.deepEqual(s.projects.map(p => p.initiative.tokenBudget), [null, 76543, 50000]); migrateRealBudgets(s, now); assert.equal(s.realUsage.tokens, 70);
});
test('known explicit real caps are retained, interrupted requests become estimates only once', () => {
  const s = state(); s.settings.realTokenBudget = 1234; reserveRealTokens(s, 'request:a', 100, { now }); reserveRealTokens(s, 'initiative:p', 200, { now });
  migrateRealBudgets(s, now); assert.equal(s.settings.realTokenBudget, 1234); assert.equal(s.realUsage.reportedTokens, 0); assert.equal(s.realUsage.estimatedTokens, 100); assert.equal(s.realUsage.reservedTokens, 200);
  migrateRealBudgets(s, now); assert.equal(s.realUsage.tokens, 100);
});
test('Store persists unlimited default, explicit real limits and nullable project cap independently of demo settings', t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-budget-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json'), store = new Store(file); assert.equal(store.state.settings.realTokenBudget, null);
  store.settings({ realTokenBudget: 1000, tokenBudget: 2 }); assert.equal(store.state.settings.tokenBudget, 2);
  assert.throws(() => store.settings({ realTokenBudget: -1 })); assert.throws(() => store.settings({ realTokenBudget: 1.2 }));
  const { project } = store.createProject({ name: 'Budget test', workspace: directory }); assert.equal(project.initiative.tokenBudget, null);
  store.updateProject(project.id, { initiative: { tokenBudget: 100 } }); store.updateProject(project.id, { initiative: { tokenBudget: null } });
  assert.equal(new Store(file).state.settings.realTokenBudget, 1000); store.settings({ realTokenBudget: null }); assert.equal(new Store(file).state.settings.realTokenBudget, null);
  const legacy = readStateFile(file).state; delete legacy.realUsage; delete legacy.settings.realTokenBudget; legacy.usage.tokens = 104990; writeFileSync(file, JSON.stringify(legacy));
  const migrated = new Store(file); assert.equal(migrated.state.settings.realTokenBudget, null); assert.equal(migrated.state.budgetMigration.legacyUsage.tokens, 104990);
});
