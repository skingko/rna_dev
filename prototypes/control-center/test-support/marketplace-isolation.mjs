import { ProjectEvolutionService as EvolutionService } from '../project-evolution-service.mjs';
import { ProjectInitializer as Initializer } from '../project-initializer.mjs';
import { bootstrapProject } from '../../../packages/sdk/src/index.mjs';

// Existing transport, metering, recovery and evaluation tests use scripted
// providers with no marketplace decisions. Keep them network-free explicitly;
// marketplace-first.test.mjs exercises the real policy and package acquisition.
const marketplaceService = { authoring: () => ({
  tools: ['marketplace_search', 'marketplace_read'].map(name => ({ name, id: name, description: 'External catalog omitted by this focused test fixture.', permission: 'read', effect: 'read', idempotent: true,
    parameters: { type: 'object', additionalProperties: false, properties: {} }, execute: () => { throw new Error('This focused test must not contact a marketplace'); } })),
  context: () => undefined, snapshot: () => ({ mode: 'explicit_test_isolation', searches: [], references: [], failures: [] })
}) };
export class ProjectEvolutionService extends EvolutionService {
  constructor(store, options = {}) { super(store, { marketplaceService, ...options }); }
}
// These scripted fixtures speak the full authoring artifact; production defaults to bootstrapProjectLite
// (covered by project-initializer-lite.test.mjs), so the full path is selected explicitly here.
export class ProjectInitializer extends Initializer {
  constructor(store, capabilities, options = {}) { super(store, capabilities, { marketplaceService, autoFoundation: false, generate: bootstrapProject, ...options }); }
}
