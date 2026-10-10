import { interfaceLanguageOf } from './interface-language.mjs';
import { DomainError } from './store.mjs';
import { geneTree, geneDetail, geneLevel, userRetireNote, GENE_LAYERS } from './project-genes.mjs';
import { readProjectInstructions } from './project-instructions.mjs';

// Evolution v3 API. GET /api/v2/projects/:id/genes → the tree; GET …/genes/:geneId → one gene in full;
// POST /api/v2/projects/:id/genes/:geneId {action: 'confirm'|'revoke'|'rewrite'|'deep_check', text?}.
// api-v2 falls through unknown /api/v2/* paths, so these live behind one server hook.
const TREE = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/genes$/;
// Gene ids contain ':' (guard:…, lesson:…); clients percent-encode them, so the segment is decoded here.
const GENE = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/genes\/([^/]{1,400})$/;
const GENE_ID = /^[A-Za-z0-9_:.-]{1,160}$/;
// D3: GET /api/v2/projects/:id/genes/observability[?view=status] → the evolution's measurements (read-only, counts and codes), or the lanes' state alone.
const OBSERVABILITY = /^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/genes\/observability$/;
const geneIdOf = raw => { let value; try { value = decodeURIComponent(raw); } catch { value = null; } if (!value || !GENE_ID.test(value)) throw new DomainError('基因标识无效', 400); return value; };
const domain = error => error instanceof DomainError ? error : new DomainError(error.message, error.status ?? 400);

export function createGeneRoutes({ store, body, genes, mind = null, deepCheck = null, now = Date.now }) {
  const project = id => store.state.projects.find(row => row.id === id && !row.archivedAt) ?? (() => { throw new DomainError('项目不存在', 404); })();
  return async function handle(req, { pathname, send, url = null }) {
    if (!pathname.startsWith('/api/v2/')) return false;
    const watch = pathname.match(OBSERVABILITY);
    if (req.method === 'GET' && watch) {
      project(watch[1]);
      const view = (url?.searchParams ?? new URL(req.url ?? '/', 'http://localhost').searchParams).get('view');
      if (view !== null && view !== 'status') throw new DomainError('view 只能是 status', 400);
      const body = view === 'status' ? genes.evolutionStatus?.(watch[1]) : genes.observability?.(watch[1]);
      if (!body) throw new DomainError('进化观测未启用', 503);
      send(200, { ...body, revision: store.state.revision }); return true;
    }
    const tree = pathname.match(TREE);
    if (req.method === 'GET' && tree) {
      const target = project(tree[1]);
      let genome = null; try { genome = await genes.genes.activeGenome(target); } catch { genome = null; }
      const instructions = await readProjectInstructions(target.workspace).catch(() => null);
      const language = interfaceLanguageOf(store.state);
      send(200, { ...geneTree(target, { genome, instructions, now: now(), language }), revision: store.state.revision });
      // Skill descriptions that are not one short line in the interface language get a one-line summary, once, in the background.
      if (genome) void genes.plainSummaries?.(target.id, genome, language).catch(() => {});
      return true;
    }
    const gene = pathname.match(GENE);
    if (gene) gene[2] = geneIdOf(gene[2]);
    if (req.method === 'GET' && gene) {
      const target = project(gene[1]);
      let genome = null; try { genome = await genes.genes.activeGenome(target); } catch { genome = null; }
      const instructions = await readProjectInstructions(target.workspace).catch(() => null);
      const detail = geneDetail(target, gene[2], { genome, instructions, language: interfaceLanguageOf(store.state) });
      if (!detail) throw new DomainError('基因不存在', 404);
      send(200, { ...detail, revision: store.state.revision }); return true;
    }
    if (req.method === 'POST' && gene) {
      const target = project(gene[1]), input = await body(req);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'text'].includes(key)) || !['confirm', 'revoke', 'rewrite', 'deep_check'].includes(input.action) || input.action === 'rewrite' && (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1000) || input.action !== 'rewrite' && input.text !== undefined) throw new DomainError('请求只能包含 action（confirm、revoke 或 rewrite）以及 rewrite 时的 text', 400);
      const [layer, key] = gene[2].split(':');
      if (!GENE_LAYERS.includes(layer) && !['lesson', 'skill-patch', 'skill-merge'].includes(layer)) throw new DomainError('未知的基因', 404);
      try {
        if (layer === 'lesson') {
          if (!mind) throw new DomainError('项目心智服务未启用', 503);
          const lesson = target.mind?.lessons?.find(row => row.id === key); if (!lesson) throw new DomainError('基因不存在', 404);
          mind.answerLessonInvitation(target.id, key, { choice: input.action === 'revoke' ? 'revoke' : input.action === 'rewrite' ? 'rewrite' : 'confirm', ...(input.text ? { text: input.text.trim() } : {}) });
          send(200, { geneId: gene[2], action: input.action, revision: store.state.revision }); return true;
        }
        const record = (target.genes?.genes ?? []).find(row => row.id === gene[2]);
        if (!record) throw new DomainError('这一层的基因由项目能力包定义，目前只能停用守卫', 409);
        if (input.action === 'deep_check') { if (!deepCheck) throw new DomainError('深入检查未启用', 503); const started = deepCheck.start(target.id, gene[2]); send(202, { geneId: gene[2], action: 'deep_check', ...started, revision: store.state.revision }); return true; }
        if (input.action === 'revoke') {
          // The system strand's button reads 已解决: its history says the user confirmed it, in the interface language.
          const reason = userRetireNote(record.layer ?? layer, interfaceLanguageOf(store.state));
          const result = await (typeof genes.retireByUser === 'function' ? genes.retireByUser(target.id, gene[2], reason) : genes.genes.retireGene(target.id, gene[2], { reason }));
          send(200, { geneId: gene[2], action: 'revoke', ...result, revision: store.state.revision }); return true;
        }
        // The user's 对 also labels the judgments that admitted the gene (EVO-13: labels come from the user or an outcome).
        if (input.action === 'confirm') { if (typeof genes.confirmByUser === 'function') genes.confirmByUser(target.id, gene[2]); else genes.genes.record(target.id, gene[2], row => { row.confirmations = (row.confirmations ?? (row.confirmedAt ? 1 : 0)) + 1; if (row.status === 'trial') row.status = 'active'; row.confirmedAt = new Date(now()).toISOString(); row.level = geneLevel(row); }); send(200, { geneId: gene[2], action: 'confirm', revision: store.state.revision }); return true; }
        genes.genes.record(target.id, gene[2], row => { row.summary = input.text.trim().slice(0, 200); row.editedAt = new Date(now()).toISOString(); });
        send(200, { geneId: gene[2], action: 'rewrite', revision: store.state.revision }); return true;
      } catch (error) { throw domain(error); }
    }
    return false;
  };
}
