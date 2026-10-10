import { createProjectEventInbox, type ProjectEvent, type ProjectEventInboxState } from '../src/project-events.js';
let durable: ProjectEventInboxState | undefined;
const inbox = createProjectEventInbox({ projectId: 'project', bindingId: 'workspace', state: durable,
  saveState: async (state, metadata) => { const next: number = metadata.nextRevision; durable = state; void next; } });
await inbox.registerSource({ id: 'files', revision: 1, kind: 'workspace' });
const receipt = await inbox.ingest({ sourceId: 'files', sourceRevision: 1, sequence: 1, kind: 'files_changed', summary: 'Report changed', data: { changes: [{ path: 'report.md', change: 'modified' }], totalChanges: 1, truncated: false } });
if (receipt.status === 'accepted' || receipt.status === 'coalesced') await inbox.checkpoint({ eventIds: [receipt.eventId], receiptId: 'observed' });
const event: ProjectEvent | undefined = inbox.pending()[0];
const instruction: false | undefined = event?.instruction;
const trust: 'untrusted' | undefined = event?.trust;
void [instruction, trust];
// @ts-expect-error external data cannot include arbitrary payloads or credentials
await inbox.ingest({ sourceId: 'files', sourceRevision: 1, sequence: 2, kind: 'files_changed', summary: 'Report changed', data: { payload: 'secret' } });
// @ts-expect-error evidence is not permission
const permission: true = event!.instruction;
void permission;
