import { validateToolArguments } from './capabilities.mjs';

export class UserInteractionError extends Error {
  constructor(message, code = 'invalid_interaction') { super(message); this.name = 'UserInteractionError'; this.code = code; }
}
const identifier = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' };
export const userQuestionSchema = { type: 'object', additionalProperties: false, required: ['id', 'question'], properties: {
  id: identifier, question: { type: 'string', minLength: 1, maxLength: 2000 }, header: { type: 'string', maxLength: 80 }, detail: { type: 'string', maxLength: 8000 },
  options: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: { id: identifier, label: { type: 'string', minLength: 1, maxLength: 160 }, description: { type: 'string', maxLength: 600 } } } },
  multiSelect: { type: 'boolean' }, allowCustom: { type: 'boolean' }
} };
export const userQuestionsSchema = { type: 'object', additionalProperties: false, required: ['questions'], properties: { questions: { type: 'array', minItems: 1, maxItems: 3, items: userQuestionSchema } } };
export function validateUserQuestions(input) {
  try { validateToolArguments(userQuestionsSchema, input); } catch { throw new UserInteractionError('Provide one to three valid structured questions.'); }
  const ids = new Set();
  for (const question of input.questions) {
    if (!question.question.trim() || ids.has(question.id)) throw new UserInteractionError('Question IDs must be unique and questions must not be blank.');
    ids.add(question.id); const options = question.options ?? [];
    if (new Set(options.map(option => option.id)).size !== options.length || options.some(option => !option.label.trim())) throw new UserInteractionError('Option IDs must be unique and labels must not be blank.');
    if (!options.length && question.allowCustom === false) throw new UserInteractionError('A question without options must allow a text answer.');
  }
  return structuredClone(input.questions).map(question => ({ ...question, multiSelect: question.multiSelect === true, allowCustom: question.allowCustom !== false }));
}
export function validateUserAnswers(questions, input) {
  const fail = () => { throw new UserInteractionError('Answer each question once, using only its offered options and permitted text.', 'invalid_answer'); };
  if (!Array.isArray(input) || input.length !== questions.length) fail();
  const seen = new Set(), answers = [];
  for (const answer of input) {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).some(key => !['id', 'selected', 'custom'].includes(key))) fail();
    const question = questions.find(question => question.id === answer.id);
    if (!question || seen.has(answer.id) || !Array.isArray(answer.selected) || answer.selected.length > 8 || new Set(answer.selected).size !== answer.selected.length || answer.selected.some(id => !(question.options ?? []).some(option => option.id === id)) || !question.multiSelect && answer.selected.length > 1) fail();
    if (answer.custom !== undefined && (typeof answer.custom !== 'string' || answer.custom.length > 4000 || question.allowCustom === false)) fail();
    const custom = answer.custom?.trim(); if (!answer.selected.length && !custom) fail();
    seen.add(answer.id); answers.push({ id: answer.id, selected: [...answer.selected], ...(custom ? { custom } : {}) });
  }
  return questions.map(question => answers.find(answer => answer.id === question.id));
}
/** A host-scoped interaction seam. It neither grants capabilities nor interprets an answer as authorization. */
export function createAskUserTool({ ask } = {}) {
  return { id: 'ask_user', name: 'ask_user', permission: 'read', effect: 'read', idempotent: true, interaction: true,
    description: 'Ask the user for a concrete decision, confirmation or missing information using interactive choices instead of asking them to type a choice into chat. The current task waits for the structured answer. Provide stable question/option IDs; allow a supplementary text answer. This tool never grants or changes permissions: use the host permission workflow for capability grants. Do not ask again for authorization already provided.',
    parameters: userQuestionsSchema,
    async execute(callId, input, signal) {
      if (signal?.aborted) throw new UserInteractionError('The question was interrupted before an answer was accepted.', 'interaction_interrupted');
      const questions = validateUserQuestions(input);
      if (typeof ask !== 'function') throw new UserInteractionError('This runtime has no user interaction surface.', 'interaction_unavailable');
      let onAbort;
      const interrupted = new Promise((_, reject) => { onAbort = () => reject(new UserInteractionError('Waiting for the user was interrupted.', 'interaction_interrupted')); signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort(); });
      let answer;
      try { answer = await Promise.race([Promise.resolve().then(() => { if (signal?.aborted) throw new UserInteractionError('Waiting for the user was interrupted.', 'interaction_interrupted'); return ask({ toolCallId: callId, questions, signal }); }), interrupted]); }
      finally { signal?.removeEventListener('abort', onAbort); }
      // The host judged that a careful default will do (ask.necessity): continue without waiting.
      if (answer?.status === 'not_asked' && answer.reason === 'known') return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_asked', permissionChanged: false, instruction: 'The host did not show this question: the answer is already in the project notes, preferences or lessons in your context. Use it and carry on, naming in a few words what you went by so the user can correct it.' }) }], details: { interaction: true, status: 'not_asked', reason: 'known' } };
      if (answer?.status === 'not_asked') return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_asked', permissionChanged: false, instruction: 'The host did not show this question: a careful, easily changed default exists and waiting for the user is not needed. Choose the option a careful expert would pick, carry on, and state that assumption in one short sentence of your reply so the user can change it.' }) }], details: { interaction: true, status: 'not_asked' } };
      if (!answer || !['answered', 'cancelled'].includes(answer.status)) throw new UserInteractionError('The interaction surface returned no accepted answer.', 'invalid_answer');
      const result = answer.status === 'answered' ? { status: 'answered', answers: validateUserAnswers(questions, answer.answers), permissionChanged: false } : { status: 'cancelled', answers: [], permissionChanged: false };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { interaction: true, status: result.status } };
    }
  };
}
