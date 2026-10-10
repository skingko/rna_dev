import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserLiveView } from '../browser-live-view.mjs';

// A fake Chrome DevTools endpoint: answers commands, lets the test push events.
function fakeChrome() {
  const sockets = [], sent = [];
  class FakeSocket {
    constructor(url) { this.url = url; sockets.push(this); queueMicrotask(() => this.onopen?.()); }
    send(text) {
      const message = JSON.parse(text); sent.push(message);
      const result = message.method === 'Target.attachToTarget' ? { sessionId: `S-${message.params.targetId}` } : {};
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) }));
    }
    close() { this.closed = true; }
    push(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  const fetchImpl = async url => ({ json: async () => ({ webSocketDebuggerUrl: `${url.replace('http', 'ws').replace('/json/version', '')}/devtools/browser/x` }) });
  return { sockets, sent, FakeSocket, fetchImpl };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

test('frames of the page the agent opened reach the panel; it follows the agent to a new page', async () => {
  const chrome = fakeChrome(), view = new BrowserLiveView({ fetchImpl: chrome.fetchImpl, WebSocketImpl: chrome.FakeSocket, fps: 50 }), events = [];
  view.attach(9555);
  const unsubscribe = view.subscribe(event => events.push(event));
  await tick(); assert.equal(chrome.sockets[0].url, 'ws://127.0.0.1:9555/devtools/browser/x');
  const ws = chrome.sockets[0];
  ws.push({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T1', type: 'page', url: 'about:blank', title: '' } } });
  await tick();
  assert.ok(chrome.sent.some(row => row.method === 'Page.startScreencast' && row.sessionId === 'S-T1'));
  ws.push({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'T1', type: 'page', url: 'http://127.0.0.1:5173/', title: 'Game' } } });
  ws.push({ sessionId: 'S-T1', method: 'Page.screencastFrame', params: { data: 'AAAA', sessionId: 7, metadata: { deviceWidth: 1280, deviceHeight: 900 } } });
  await tick();
  assert.ok(chrome.sent.some(row => row.method === 'Page.screencastFrameAck' && row.params.sessionId === 7));
  const frame = events.findLast(event => event.type === 'frame');
  assert.deepEqual([frame.data, frame.url, frame.title, frame.width], ['AAAA', 'http://127.0.0.1:5173/', 'Game', 1280]);
  // A new tab: the view moves there and lets go of the old one.
  ws.push({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T2', type: 'page', url: 'http://127.0.0.1:5173/level2', title: 'Level 2' } } });
  await tick();
  assert.ok(chrome.sent.some(row => row.method === 'Target.detachFromTarget' && row.params.sessionId === 'S-T1'));
  assert.ok(chrome.sent.some(row => row.method === 'Page.startScreencast' && row.sessionId === 'S-T2'));
  assert.equal(view.state().url, 'http://127.0.0.1:5173/level2');
  unsubscribe(); view.close();
});

test('nobody watching and no tool running: no connection; a late viewer gets the last frame at once', async () => {
  const chrome = fakeChrome(), view = new BrowserLiveView({ fetchImpl: chrome.fetchImpl, WebSocketImpl: chrome.FakeSocket, fps: 50 });
  view.attach(9556); await tick();
  assert.equal(chrome.sockets.length, 0, 'idle browser is not mirrored');
  view.begin({ name: 'browser_navigate', detail: 'http://127.0.0.1:5173/' }); await tick();
  const ws = chrome.sockets[0];
  ws.push({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T1', type: 'page', url: 'http://127.0.0.1:5173/', title: 'Game' } } });
  await tick();
  ws.push({ sessionId: 'S-T1', method: 'Page.screencastFrame', params: { data: 'BBBB', sessionId: 1, metadata: {} } });
  view.end(); await tick();
  const events = []; view.subscribe(event => events.push(event));
  assert.deepEqual(events.map(event => event.type), ['state', 'frame']); assert.equal(events[1].data, 'BBBB');
  view.detach(); assert.equal(view.state().live, false); assert.equal(view.last.data, 'BBBB', 'the last frame stays after the browser closes');
  view.close();
});
