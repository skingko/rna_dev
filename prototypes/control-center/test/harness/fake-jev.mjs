// D4 scenario harness: a fake JEV (TypeSafe System One) server on 127.0.0.1, reached through TYPESAFE_ENDPOINT, the
// host's own endpoint override (decision-service.mjs `endpoint()`), with an obviously synthetic key. It answers the
// typed questions on the wire (`noul`, `choice`, `score`) and records every call: `state` and `questions` are what the
// host asked, so a scenario can assert which judgments ran and on what.
//
// By default JEV abstains: noul 0.5, an even choice, a score with no confidence. The kernel turns each of those into
// "no verdict" (decisionVerdict), so every judgment takes its documented fallback. A scenario answers a question by id
// with `answer(id, value)` (a probability for noul, an option id for choice, a level for score) or a function of
// (question, body); `answerAll(fn)` sees every question.

import http from 'node:http';

export const SYNTHETIC_JEV_KEY = 'scenario-synthetic-jev-key-not-a-secret';

function abstain(question) {
  if (question.type === 'noul') return { type: 'noul', noul: 0.5 };
  if (question.type === 'choice') {
    const options = Object.keys(question.criteria ?? {}), escape = options.find(option => ['none', 'unknown'].includes(option));
    if (escape) return { type: 'choice', choice: escape, probabilities: Object.fromEntries(options.map(option => [option, option === escape ? 1 : 0])) };
    const share = 1 / Math.max(1, options.length);
    return { type: 'choice', choice: options[0], probabilities: Object.fromEntries(options.map(option => [option, share])) };
  }
  return { type: 'score', score: 0, confidence: 0 };
}
function answerOf(question, value) {
  if (value && typeof value === 'object') return value;
  if (question.type === 'noul') return { type: 'noul', noul: Number(value) };
  if (question.type === 'choice') { const options = Object.keys(question.criteria ?? {}); return { type: 'choice', choice: value, probabilities: Object.fromEntries(options.map(option => [option, option === value ? 0.98 : 0.02 / Math.max(1, options.length - 1)])) }; }
  return { type: 'score', score: Number(value), confidence: 0.98 };
}

export async function createFakeJev() {
  const answers = new Map();
  let all = null;
  const jev = {
    calls: [],
    answer(id, value) { answers.set(id, value); return jev; },
    answerAll(fn) { all = fn; return jev; },
    /** Calls that asked a question id (any of `ids`). */
    asked: (...ids) => jev.calls.filter(call => ids.some(id => Object.hasOwn(call.questions ?? {}, id))),
  };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); return res.end('{}'); }
    jev.calls.push({ at: Date.now(), authorization: req.headers.authorization === `Bearer ${SYNTHETIC_JEV_KEY}`, model: body.model, state: body.state, questions: body.questions });
    const out = {};
    for (const [id, question] of Object.entries(body.questions ?? {})) {
      let value = all ? all(id, question, body) : undefined;
      if (value === undefined && answers.has(id)) { const fixed = answers.get(id); value = typeof fixed === 'function' ? fixed(question, body) : fixed; }
      out[id] = value === undefined ? abstain(question) : answerOf(question, value);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ answers: out, usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 0 } }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  jev.endpoint = `http://127.0.0.1:${server.address().port}/v1/systemone`;
  jev.close = async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); };
  return jev;
}
