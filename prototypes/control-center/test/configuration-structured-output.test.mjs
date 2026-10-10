import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { resolveModel } from '../configuration.mjs';
import { ProjectLearningController } from '../project-learning-controller.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { getProjectEvolutionIdentity } from '../project-evolution-identity.mjs';

const flags = ['supportsJsonObject', 'supportsToolChoiceNone'];
const model = { id: 'custom-json-model', name: 'Custom fixture', contextWindow: 64000, maxOutputTokens: 4000, reasoning: ['off'] };
function fixture(t, compat) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-json-compat-')), file = join(directory, 'state.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(file), provider = store.configurationService.provider(null, { name: 'Isolated gateway', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-key-never-public', models: [{ ...model, ...(compat === undefined ? {} : { compat }) }] });
  const selection = { providerId: provider.id, modelId: model.id, reasoning: 'off' };
  store.configurationService.update({ defaultModel: selection });
  return { store, file, providerId: provider.id, selection, resolve: () => resolveModel(store.state.configuration, selection), update: row => store.configurationService.provider(provider.id, { models: [{ ...model, ...row }] }) };
}

test('explicit JSON output capabilities survive public configuration, durable reload and resolved session snapshots', t => {
  const compat = { supportsJsonObject: true, supportsToolChoiceNone: true }, app = fixture(t, compat), session = app.store.createSession({});
  assert.deepEqual(app.resolve().compat, compat); assert.deepEqual(session.modelConfig.compat, compat);
  assert.deepEqual(app.store.configurationService.public().providers.find(row => row.id === app.providerId).models[0].compat, compat);
  const reopened = new Store(app.file);
  assert.deepEqual(resolveModel(reopened.state.configuration, app.selection).compat, compat);
  for (const content of [readFileSync(app.file, 'utf8'), JSON.stringify(reopened.configurationService.public()), JSON.stringify(session.modelConfig)]) assert.equal(content.includes('fixture-key-never-public'), false);
  const copy = app.resolve(); copy.compat.supportsJsonObject = false; assert.equal(app.resolve().compat.supportsJsonObject, true, 'model resolution returns a snapshot, not shared capability references');
});

test('JSON capability updates distinguish omission, explicit false and explicit removal without restoring stale declarations', t => {
  const app = fixture(t, { supportsJsonObject: true, supportsToolChoiceNone: true }), session = app.store.createSession({});
  const secretsBefore = readFileSync(`${app.file}.secrets`, 'utf8');
  app.update({ name: 'Rename only' }); assert.equal(app.resolve().compat.supportsJsonObject, true, 'omitting compat in a model patch retains saved declarations');
  app.update({ compat: { supportsJsonObject: false, supportsToolChoiceNone: false } });
  assert.deepEqual(app.resolve().compat, { supportsJsonObject: false, supportsToolChoiceNone: false });
  assert.deepEqual(app.store.state.sessions.find(row => row.id === session.id).modelConfig.compat, app.resolve().compat, 'idle session refreshes its model contract');
  app.update({ compat: { supportsToolChoiceNone: true } });
  assert.equal(Object.hasOwn(app.resolve().compat, 'supportsJsonObject'), false); assert.equal(app.resolve().compat.supportsToolChoiceNone, true);
  app.update({ compat: {} }); assert.deepEqual(app.resolve().compat, {});
  assert.deepEqual(resolveModel(new Store(app.file).state.configuration, app.selection).compat, {});
  assert.equal(readFileSync(`${app.file}.secrets`, 'utf8'), secretsBefore);
});

test('unknown gateways remain undeclared and invalid JSON compatibility flags cannot alter configuration or credentials', t => {
  const app = fixture(t); assert.equal(app.resolve().compat, undefined);
  const before = readFileSync(app.file, 'utf8'), secrets = readFileSync(`${app.file}.secrets`, 'utf8');
  for (const key of flags) for (const value of ['true', 1, null, {}, []]) {
    assert.throws(() => app.update({ compat: { [key]: value } }), /布尔值/);
    assert.equal(readFileSync(app.file, 'utf8'), before); assert.equal(readFileSync(`${app.file}.secrets`, 'utf8'), secrets);
  }
  assert.throws(() => app.update({ compat: { arbitraryRequestField: true } }), /兼容配置/);
  assert.equal(app.resolve().compat, undefined);
});

test('JSON capability changes invalidate learning, initiative and evolution identities even within the same provider revision', t => {
  const app = fixture(t), project = app.store.createProject({ name: 'Identity fixture' }).project;
  const currentProject = () => app.store.state.projects.find(row => row.id === project.id);
  const revision = app.store.state.configuration.providers.find(row => row.id === app.providerId).updatedAt;
  for (const flag of flags) {
    const identities = [];
    for (const compat of [{}, { [flag]: false }, { [flag]: true }]) {
      app.update({ compat });
      // Reproduce two updates with identical timestamp precision; the contract
      // itself must invalidate the scope, not only provider.updatedAt.
      app.store.mutate(state => { state.configuration.providers.find(row => row.id === app.providerId).updatedAt = revision; });
      const selected = app.resolve(), p = currentProject();
      identities.push({ learning: ProjectLearningController.prototype.scope.call({ store: app.store }, p, selected),
        // The initiative's privacy scope never depends on the model; its drift identity (what the coordinator froze) does.
        initiative: ProjectInitiativeController.prototype.drift.call({ store: app.store }, p, selected),
        evolution: getProjectEvolutionIdentity(p, { model: selected }).modelHash });
    }
    for (const lane of ['learning', 'initiative', 'evolution']) assert.equal(new Set(identities.map(row => row[lane])).size, 3, `${flag}: ${lane} must distinguish unset / false / true`);
  }
});

test('changing JSON compatibility preserves the already-running session model contract', t => {
  const app = fixture(t, { supportsJsonObject: true, supportsToolChoiceNone: true }), session = app.store.createSession({});
  app.store.mutate(state => { state.sessions.find(row => row.id === session.id).activeTurnId = 'isolated-running-turn'; });
  app.update({ compat: { supportsJsonObject: false, supportsToolChoiceNone: false } });
  assert.equal(app.resolve().compat.supportsJsonObject, false);
  assert.deepEqual(app.store.state.sessions.find(row => row.id === session.id).modelConfig.compat, { supportsJsonObject: true, supportsToolChoiceNone: true });
});

test('undeclared, empty and cache/token compatibility leave the initiative drift identity alone; the privacy scope never depends on the model', t => {
  const app = fixture(t), project = app.store.createProject({ name: 'Legacy identity fixture' }).project;
  const p = app.store.state.projects.find(row => row.id === project.id), selected = app.resolve();
  const drift = compat => ProjectInitiativeController.prototype.drift.call({ store: app.store }, p, { ...selected, ...(compat ? { compat } : {}) });
  const scope = compat => ProjectInitiativeController.prototype.scope.call({ store: app.store }, p, { ...selected, ...(compat ? { compat } : {}) });
  const baseline = drift(undefined), privacy = scope(undefined);
  for (const compat of [{}, { maxTokensField: 'max_tokens' }, { supportsPromptCacheKey: true, supportsUsageInStreaming: false }, { maxTokensField: 'max_tokens', supportsLongCacheRetention: true }]) { assert.equal(drift(compat), baseline); assert.equal(scope(compat), privacy); }
  assert.notEqual(drift({ supportsJsonObject: false }), baseline, 'explicit false is a changed contract, not absence');
  assert.equal(scope({ supportsJsonObject: false }), privacy, 'a model contract change is drift, never a privacy boundary');
});
