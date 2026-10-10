import { DomainError } from './store.mjs';
import { publicMind, patchMindEntry, deleteMindEntry, createMindEntry, MIND_COLLECTIONS } from './project-mind.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { agendaForUser } from './agenda-text.mjs';

// Project Mind API (plan v2 §8). GET /api/v2/projects/:id/mind;
// POST /api/v2/projects/:id/mind/agenda/:entryId/answer {text} (answers an awaiting_user item);
// POST /api/v2/projects/:id/mind/reconcile {dryRun?, force?} (judge-only reconciliation);
// POST /api/v2/projects/:id/mind/{lessons|agenda|commitments|notes} (user-authored);
// PATCH|DELETE /api/v2/projects/:id/mind/{lessons|agenda|commitments|threads|notes}/:entryId;
// POST /api/v2/sessions/:id/items/:itemId/feedback. api-v2 falls through
// unknown /api/v2/* paths, so these live behind one server hook.
const MIND = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/mind$/;
const ENTRY = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/mind\/(lessons|agenda|commitments|threads|notes)\/([A-Za-z0-9_-]{1,128})$/;
const RECONCILE = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/mind\/reconcile$/;
const ANSWER = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/mind\/agenda\/([A-Za-z0-9_-]{1,128})\/answer$/;
const COLLECTION = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/mind\/(lessons|agenda|commitments|notes)$/;
const FEEDBACK = /^\/api\/v2\/sessions\/([a-zA-Z0-9-]+)\/items\/([a-zA-Z0-9_-]+)\/feedback$/;
// POST /api/v2/sessions/:id/invitations/:invitationId {action: 'dismiss'|'answer', choice?, text?} (composer invitations).
const INVITATION = /^\/api\/v2\/sessions\/([a-zA-Z0-9-]+)\/invitations\/([a-zA-Z0-9-]+)$/;
// The service's code rides along (task_context_revoked, session_unavailable …), so the client can tell refusals apart.
const domain = error => error instanceof DomainError ? error : Object.assign(new DomainError(error.message, error.status ?? 400), typeof error.code === 'string' ? { code: error.code } : {});

export function createMindRoutes({ store, body, mind, invitations = null, now = Date.now }) {
  const project = id => store.state.projects.find(row => row.id === id) ?? (() => { throw new DomainError('项目不存在', 404); })();
  return async function handle(req, { pathname, url, send }) {
    if (!pathname.startsWith('/api/v2/')) return false;
    const all = pathname.match(MIND), entry = pathname.match(ENTRY), feedback = pathname.match(FEEDBACK);
    if (req.method === 'GET' && all) {
      const status = url.searchParams.get('status') ?? 'all';
      if (!['all', 'active'].includes(status)) throw new DomainError('status 必须为 all 或 active', 400);
      send(200, { ...publicMind(project(all[1]), { now: now(), status, sessions: store.state.sessions, language: interfaceLanguageOf(store.state) }), revision: store.state.revision }); return true;
    }
    // POST /api/v2/projects/:id/mind/commitments/ask: overdue promises are asked above the composer of the project conversation.
    const owed = pathname.match(/^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/mind\/commitments\/ask$/);
    if (req.method === 'POST' && owed) {
      project(owed[1]); await body(req);
      if (!invitations?.askOverdue) throw new DomainError('邀请服务未启用', 503);
      send(200, { ...invitations.askOverdue(owed[1]), revision: store.state.revision }); return true;
    }
    const reconcile = pathname.match(RECONCILE);
    if (req.method === 'POST' && reconcile) {
      project(reconcile[1]);
      if (!mind) throw new DomainError('项目心智服务未启用', 503);
      const input = await body(req);
      if (Object.keys(input).some(key => !['dryRun', 'force'].includes(key)) || input.dryRun !== undefined && typeof input.dryRun !== 'boolean' || input.force !== undefined && typeof input.force !== 'boolean') throw new DomainError('请求只能包含布尔值 dryRun 与 force', 400);
      try { send(200, { ...await mind.reconcile(reconcile[1], { dryRun: input.dryRun === true, force: input.force === true }), revision: store.state.revision }); } catch (error) { throw domain(error); }
      return true;
    }
    const answer = pathname.match(ANSWER);
    if (req.method === 'POST' && answer) {
      project(answer[1]);
      if (!mind) throw new DomainError('项目心智服务未启用', 503);
      const input = await body(req);
      try { send(200, { entry: structuredClone(agendaForUser(mind.answerAgenda(answer[1], answer[2], input), interfaceLanguageOf(store.state))), collection: 'agenda', revision: store.state.revision }); } catch (error) { throw domain(error); }
      return true;
    }
    const create = pathname.match(COLLECTION);
    if (req.method === 'POST' && create) {
      project(create[1]);
      const input = await body(req);
      let created;
      try { store.mutate(state => { created = createMindEntry(state.projects.find(row => row.id === create[1]), create[2], input, { now: now(), language: interfaceLanguageOf(state) }); }); }
      catch (error) { throw domain(error); }
      send(201, { entry: structuredClone(create[2] === 'agenda' ? agendaForUser(created, interfaceLanguageOf(store.state)) : created), collection: create[2], revision: store.state.revision }); return true;
    }
    if ((req.method === 'PATCH' || req.method === 'DELETE') && entry) {
      project(entry[1]);
      if (!MIND_COLLECTIONS.includes(entry[2])) throw new DomainError(inLanguage(interfaceLanguageOf(store.state), { zh: '未知的心智分类', en: 'Unknown mind category' }), 404);
      const input = req.method === 'PATCH' ? await body(req) : null;
      let result; const labels = [];
      try { store.mutate(state => { const target = state.projects.find(row => row.id === entry[1]); const language = interfaceLanguageOf(state); result = req.method === 'PATCH' ? patchMindEntry(target, entry[2], entry[3], input, { now: now(), labels, language }) : deleteMindEntry(target, entry[2], entry[3], { now: now(), language }); }); }
      catch (error) { throw domain(error); }
      // MIND-15: what the user just did to a row a mind.judge call had decided labels that call (committed first; a label never blocks the edit).
      if (labels.length) mind?.labelJudgements?.(labels);
      send(200, req.method === 'PATCH' ? { entry: structuredClone(entry[2] === 'agenda' ? agendaForUser(result, interfaceLanguageOf(store.state)) : result), collection: entry[2], revision: store.state.revision } : { deleted: entry[3], collection: entry[2], revision: store.state.revision }); return true;
    }
    if (req.method === 'POST' && feedback) {
      if (!mind) throw new DomainError('项目心智服务未启用', 503);
      const input = await body(req);
      let result;
      try { result = mind.feedback(feedback[1], feedback[2], input); } catch (error) { throw domain(error); }
      // A vote from the strip or the message footer answers that reply's feedback invitation.
      if (input.vote) invitations?.answeredFeedback(feedback[1], feedback[2]);
      send(200, { ...result, revision: store.state.revision });
      return true;
    }
    // The user's call on background work from the task page (same as answering its strip above the composer).
    const task = pathname.match(/^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/tasks\/([a-zA-Z0-9_.:-]+)$/);
    if (req.method === 'POST' && task) {
      if (!invitations) throw new DomainError('邀请服务未启用', 503);
      const input = await body(req);
      if (!input || typeof input !== 'object' || Object.keys(input).some(key => key !== 'choice') || typeof input.choice !== 'string') throw new DomainError('请求只能包含 choice', 400);
      try { send(200, await invitations.answerTask(task[1], task[2], input.choice)); } catch (error) { throw domain(error); }
      return true;
    }
    const invitation = pathname.match(INVITATION);
    if (req.method === 'POST' && invitation) {
      if (!invitations) throw new DomainError('邀请服务未启用', 503);
      const input = await body(req);
      try { send(200, await invitations.act(invitation[1], invitation[2], input)); } catch (error) { throw domain(error); }
      return true;
    }
    return false;
  };
}
