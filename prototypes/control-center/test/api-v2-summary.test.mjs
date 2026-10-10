import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { projectDetail, projectSummary } from '../api-v2.mjs';
import { geneTree } from '../project-genes.mjs';

// UX audit 2026-10-03 (F45): the evolution tab's dot reads the project summary, which the web keeps live without
// fetching the gene tree; a gene being formed or checked shows there by the same rule as geneTree.forming.
test('the project summary says when a gene is forming, by the gene tree\'s own rule', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-api-v2-summary-')), store = new Store(join(dir, 'private', 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project } = store.createProject({ name: 'Forming', workspace: dir, initiative: { enabled: false } });
  const now = Date.parse('2026-10-03T08:00:00Z'), current = () => store.state.projects.find(row => row.id === project.id);
  assert.equal(projectSummary(store, current(), { now }).genesForming, false);
  const gene = (status, minutesAgo) => ({ id: `guard:${status}-${minutesAgo}`, layer: 'guard', key: `${status}-${minutesAgo}`, status, title: 't', createdAt: new Date(now - 3600000).toISOString(), updatedAt: new Date(now - minutesAgo * 60000).toISOString(), history: [] });
  for (const [genes, forming] of [[[gene('testing', 2)], true], [[gene('proposed', 14)], true], [[gene('testing', 16)], false], [[gene('trial', 1), gene('active', 1)], false]]) {
    store.mutate(state => { state.projects.find(row => row.id === project.id).genes = { genes, generations: [] }; });
    assert.equal(projectSummary(store, current(), { now }).genesForming, forming, JSON.stringify(genes.map(row => row.id)));
    assert.equal(geneTree(current(), { now }).forming, forming, 'the tree agrees');
  }
});

// C2-f: a planning receipt stored before its next run was put in local words ("；下次 <UTC instant>") reads in local
// plain time wherever the project is projected (the v2 project route the task page reads, and the legacy state); the
// stored row stays as it was. The index row never carries them (up to 4,096 rows; A5).
test('the project projections word older planning receipts\' next run in local plain time; the stored rows stay', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-api-v2-receipts-')), store = new Store(join(dir, 'private', 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project } = store.createProject({ name: 'Receipts', workspace: dir, initiative: { enabled: false } });
  const raw = '已自主安排任务「每日 AI 新闻」；下次 2026-10-03T01:00:00.000Z。这是任务安排回执，尚不代表工作已完成。';
  store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id);
    target.schedules = [{ id: 'daily-news', title: '每日 AI 新闻', enabled: false, nextRunAt: null, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }];
    target.scheduleManagementReceipts = [{ actionId: 'plan-1', scheduleId: 'daily-news', summary: raw }];
  });
  const current = () => store.state.projects.find(row => row.id === project.id), shown = '已自主安排任务「每日 AI 新闻」；下次 10月3日 09:00。这是任务安排回执，尚不代表工作已完成。';
  assert.equal(projectDetail(store, current()).scheduleManagementReceipts[0].summary, shown);
  assert.equal(projectSummary(store, current()).scheduleManagementReceipts, undefined);
  assert.equal(store.get().projects.find(row => row.id === project.id).scheduleManagementReceipts[0].summary, shown);
  store.interfaceLanguage('en');
  assert.equal(projectDetail(store, current()).scheduleManagementReceipts[0].summary, 'Set up the task “每日 AI 新闻”; next run Oct 3, 09:00. This is a scheduling receipt; the work itself is not done yet.');
  assert.equal(current().scheduleManagementReceipts[0].summary, raw, 'read time only');
});
