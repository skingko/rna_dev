/* Copy-on-write drafts over an immutable committed state.
 *
 * Committed state is deeply frozen plain JSON data and never changes in
 * place, so a new generation shares every untouched subtree with the previous
 * one (object identity doubles as "unchanged" for the shard encoder).
 *
 * A draft is an ordinary mutable object or array (no Proxy: structuredClone,
 * JSON, spread and Array methods behave normally). Primitive fields are copied;
 * container fields are enumerable accessors that, on first read or write,
 * become ordinary data properties holding a draft of the committed child. An
 * array draft eagerly drafts its elements. Nothing is copied that the caller
 * does not reach, and a reached-but-unchanged subtree finalizes back to the
 * identical committed object. Abandoning a draft (an exception, a failed
 * persist) leaves the committed state untouched: that is the rollback.
 *
 * Finalizing never freezes an object the caller holds: changed drafts and
 * private values are copied into new committed objects, so a draft or value
 * the caller keeps after a commit stays mutable and detached. */
// bases: draft -> committed base; touched:
// drafts whose container field was read or assigned (an untouched draft can
// only differ from its base in primitive fields or its key list).
const bases = new WeakMap(), touched = new WeakSet(), sealed = new WeakSet(), descriptors = new Map();
const plain = value => { const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; };
const container = value => value !== null && typeof value === 'object' && (Array.isArray(value) || plain(value));
export const isCommitted = value => sealed.has(value);
export const isDraft = value => bases.has(value);
const own = value => ({ value, writable: true, enumerable: true, configurable: true });
function field(key) {
  let descriptor = descriptors.get(key);
  if (!descriptor) {
    descriptor = { enumerable: true, configurable: true,
      get() { const child = draft(bases.get(this)?.[key]); touched.add(this); Object.defineProperty(this, key, own(child)); return child; },
      set(value) { touched.add(this); Object.defineProperty(this, key, own(value)); } };
    descriptors.set(key, descriptor);
  }
  return descriptor;
}
/** A mutable, lazily materialized copy of a committed value. Uncommitted
 * values (already private to the caller) are returned unchanged. */
export function draft(base) {
  if (!sealed.has(base)) return base;
  let value;
  if (Array.isArray(base)) { value = new Array(base.length); for (let i = 0; i < base.length; i++) value[i] = draft(base[i]); }
  else {
    value = Object.getPrototypeOf(base) === null ? Object.create(null) : {};
    for (const key of Object.keys(base)) { const child = base[key]; if (sealed.has(child)) Object.defineProperty(value, key, field(key)); else if (key === '__proto__') Object.defineProperty(value, key, own(child)); else value[key] = child; }
  }
  bases.set(value, base);
  return value;
}
const commit = value => { sealed.add(value); return Object.freeze(value); };
/** Deep-freeze a private value tree into committed state, in place (used once
 * for a freshly loaded state nobody else references). */
export function seal(value) {
  if (!container(value) || sealed.has(value)) return value;
  if (Array.isArray(value)) for (let i = 0; i < value.length; i++) value[i] = seal(value[i]);
  else for (const key of Object.keys(value)) { const child = seal(value[key]); if (child !== value[key]) value[key] = child; }
  return commit(value);
}
// The committed value of one field of a draft or private object.
function member(value, base, key, finals) {
  if (base && sealed.has(base[key])) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (descriptor.get) return base[key]; return finalize(descriptor.value, finals); }
  return finalize(value[key], finals);
}
/** The committed value of a draft or private value tree. Unchanged drafts
 * resolve to their committed base; anything else is copied into new frozen
 * objects. `finals` memoizes per source object (shared references stay shared). */
export function finalize(value, finals = new Map()) {
  if (!container(value) || sealed.has(value)) return value;
  const memo = finals.get(value); if (memo !== undefined) return memo;
  const base = bases.get(value);
  let result;
  if (Array.isArray(value)) {
    let same = Array.isArray(base) && base.length === value.length;
    for (let i = 0; i < value.length; i++) { const next = finalize(value[i], finals); if (same && next !== base[i]) same = false; }
    result = same ? base : commit(Array.from(value, item => finalize(item, finals)));
  } else {
    const keys = Object.keys(value), baseKeys = base && !Array.isArray(base) ? Object.keys(base) : null;
    let same = baseKeys !== null && baseKeys.length === keys.length;
    // Fast path: a draft none of whose container fields was reached is
    // unchanged when its keys and primitive fields are.
    if (same && !touched.has(value)) {
      for (let i = 0; same && i < keys.length; i++) { const key = keys[i]; if (baseKeys[i] !== key || (sealed.has(base[key]) ? !Object.getOwnPropertyDescriptor(value, key).get : value[key] !== base[key])) same = false; }
      if (same) { finals.set(value, base); return base; }
      same = true;
    }
    for (let i = 0; i < keys.length; i++) { const next = member(value, base, keys[i], finals); if (same && (baseKeys[i] !== keys[i] || base[keys[i]] !== next)) same = false; }
    if (same) result = base;
    else {
      const out = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
      for (const key of keys) { const next = member(value, base, key, finals); if (key === '__proto__') Object.defineProperty(out, key, own(next)); else out[key] = next; }
      result = commit(out);
    }
  }
  finals.set(value, result);
  return result;
}
