import type { ProjectEvolutionSkillDelivery, ProjectEvolutionSearchFeedback, ProjectEvolutionSearchPolicy } from '@rna-agent/sdk';
import { validateProjectEvolutionSearchPolicy } from '@rna-agent/sdk';

const delivery: ProjectEvolutionSkillDelivery = {
  scope: 'selection_runtime_receipts', qualityClaim: 'none', observedExecutions: 1, expectedExecutions: 2, omittedItems: 0,
  items: [{ id: 'method', path: 'SKILL.md', catalogSubmitted: 1, resourceInventorySubmitted: 0, delivered: 0, notRequested: 1, contentNotSubmitted: 0, partialDelivery: 0, unknown: 0 }],
};
const feedback: ProjectEvolutionSearchFeedback = { reason: 'selection_incomplete', comparable: false, skillDelivery: delivery };
const policy: ProjectEvolutionSearchPolicy = { history: [] };
validateProjectEvolutionSearchPolicy(policy);
// @ts-expect-error Delivery counts never make a quality claim.
delivery.qualityClaim = 'improved';
// @ts-expect-error Confirmation content is not a discovery feedback field.
feedback.confirmationAnswer = 'private';
void feedback;
