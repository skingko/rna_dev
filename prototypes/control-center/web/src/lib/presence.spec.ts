import { test } from 'vitest'
import assert from 'node:assert/strict'
import { presenceReporter, type PresenceBody } from './presence'

function fixture() {
  let now = 1_000_000, here = true, next = 0
  const sent: PresenceBody[] = []
  const reporter = presenceReporter({ send: async body => { sent.push(body); return { receiptId: `r${++next}` } }, here: () => here, now: () => now })
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { reporter, sent, settle, advance: (ms: number) => { now += ms }, leave: () => { here = false }, back: () => { here = true } }
}

test('reading the conversation counts as being here: claimed at once, renewed slowly, released with its receipt', async () => {
  const f = fixture()
  f.reporter.check(); await f.settle()
  assert.deepEqual(f.sent, [{ typing: false, visible: true }])
  f.advance(5000); f.reporter.check(); f.advance(5000); f.reporter.check()
  assert.equal(f.sent.length, 1, 'no request every tick')
  f.advance(20_000); f.reporter.check(); await f.settle()
  assert.equal(f.sent.length, 2, 'renewed before the daemon lets it lapse')
  f.leave(); f.reporter.check(); f.reporter.check()
  assert.deepEqual(f.sent.slice(2), [{ typing: false, visible: false, expectedReceiptId: 'r2' }], 'released once, only if still ours')
  f.back(); f.reporter.check()
  assert.deepEqual(f.sent.at(-1), { typing: false, visible: true })
})

test('typing reports stay fresher than the reading heartbeat, and closing releases presence', async () => {
  const f = fixture()
  f.reporter.typed(); f.reporter.typed(); await f.settle()
  assert.deepEqual(f.sent, [{ typing: true, visible: true }], 'typing is throttled')
  f.advance(4000); f.reporter.check()
  assert.equal(f.sent.length, 1, 'a heartbeat never overwrites a live typing report')
  f.advance(7000); f.reporter.check(); await f.settle()
  assert.deepEqual(f.sent.at(-1), { typing: false, visible: true }, 'after typing lapses, reading takes over and clears the typing flag')
  f.reporter.stop(); f.reporter.stop(); f.reporter.check(); f.reporter.typed()
  assert.deepEqual(f.sent.at(-1), { typing: false, visible: false, expectedReceiptId: 'r2' })
  assert.equal(f.sent.length, 3, 'nothing after stop')
})

test('a window that was never in front claims nothing and releases nothing', () => {
  const f = fixture()
  f.leave(); f.reporter.check(); f.reporter.stop()
  assert.deepEqual(f.sent, [])
})
