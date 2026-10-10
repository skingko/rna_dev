import { revokeLearningSources, type LearningReview, type LearningState } from '@rna-agent/sdk';

const review: LearningReview = { id: 'r', status: 'completed', episodeKeys: [], sourceIds: ['scope:old'], startedAt: 1,
  sourceRevoked: true, statusBeforeRevocation: 'completed', result: { status: 'rejected', versionId: 'v' } };
const state: LearningState = { schemaVersion: 1, episodes: [], reviews: [review], seen: [], nextReviewAt: 0 };
const revoked = revokeLearningSources(state, ['scope:old']);
const priorStatus: LearningReview['status'] | undefined = revoked.reviews[0]?.statusBeforeRevocation;
void priorStatus;
