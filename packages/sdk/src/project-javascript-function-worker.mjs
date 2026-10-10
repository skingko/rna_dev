// Standalone worker, sent to Node through --eval with an empty credential env
// and the permission model enabled. It imports no workspace or package code.
import { createContext, Script, SourceTextModule } from 'node:vm';
import { types } from 'node:util';

const finish = response => { process.stdout.write(JSON.stringify(response)); };
let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 160000) { finish({ ok: false, code: 'artifact_function_input_limit' }); process.exit(0); }
}
let request;
try { request = JSON.parse(raw); } catch { finish({ ok: false, code: 'artifact_function_input_invalid' }); process.exit(0); }
if (!request || Object.keys(request).sort().join(',') !== 'args,exportName,source' || typeof request.source !== 'string' ||
    Buffer.byteLength(request.source) > 64000 || typeof request.exportName !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/.test(request.exportName) || !Array.isArray(request.args)) {
  finish({ ok: false, code: 'artifact_function_input_invalid' }); process.exit(0);
}
const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
// Only realm-local built-ins and data are visible. Capture the intrinsics
// before authored code runs, so mutating JSON/Object/Array cannot replace the
// verifier. Return primitive JSON text; never call authored getters from host.
new Script(`const __rnaFunctionCheck = (() => {
  const parse = JSON.parse, stringify = JSON.stringify, apply = Reflect.apply;
  const prototype = Object.getPrototypeOf, descriptors = Object.getOwnPropertyDescriptors;
  const keys = Object.keys, symbols = Object.getOwnPropertySymbols, array = Array.isArray, has = Object.hasOwn;
  const plain = Object.prototype, promise = Promise.prototype, finite = Number.isFinite;
  let value, status = 'artifact_export_unavailable';
  return (namespace, name, argsText, phase) => {
    if (phase === 'status') return status;
    if (phase === 'invoke') {
      let fn;
      try { fn = namespace[name]; } catch { status = 'artifact_export_unavailable'; return; }
      if (typeof fn !== 'function') { status = 'artifact_export_not_function'; return; }
      try { value = apply(fn, undefined, parse(argsText)); status = 'ready'; return value; }
      catch { status = 'artifact_function_threw'; return; }
    }
    try { if (value && prototype(value) === promise) return '{"ok":false,"code":"artifact_async_result"}'; }
    catch { return '{"ok":false,"code":"artifact_non_json_result"}'; }
    const ancestors = []; let nodes = 0, characters = 0;
    const encode = (item, depth) => {
      if (++nodes > 8192 || depth > 32) throw 0;
      if (item === null) return 'null';
      if (typeof item === 'boolean') return item ? 'true' : 'false';
      if (typeof item === 'number') { if (!finite(item)) throw 0; return stringify(item); }
      if (typeof item === 'string') { characters += item.length; if (characters > 64000) throw 0; return stringify(item); }
      if (!item || typeof item !== 'object') throw 0;
      for (let i = 0; i < ancestors.length; i++) if (ancestors[i] === item) throw 0;
      const isArray = array(item), proto = prototype(item);
      if (!isArray && proto !== plain && proto !== null || symbols(item).length) throw 0;
      ancestors[ancestors.length] = item;
      const props = descriptors(item), names = keys(props); let encoded = isArray ? '[' : '{', count = 0;
      if (isArray) {
        const length = props.length.value;
        if (length > 8192 || names.length !== length + 1) throw 0;
        for (let i = 0; i < length; i++) {
          const descriptor = props[i]; if (!descriptor || !has(descriptor, 'value') || !descriptor.enumerable) throw 0;
          encoded += (i ? ',' : '') + encode(descriptor.value, depth + 1);
        }
      } else {
        for (let i = 0; i < names.length; i++) {
          const name = names[i], descriptor = props[name];
          if (!has(descriptor, 'value') || !descriptor.enumerable) throw 0;
          encoded += (count++ ? ',' : '') + stringify(name) + ':' + encode(descriptor.value, depth + 1);
        }
      }
      ancestors.length--; encoded += isArray ? ']' : '}';
      if (encoded.length > 64000) throw 0;
      return encoded;
    };
    try { const encoded = encode(value, 0); return '{"ok":true,"encoded":' + stringify(encoded) + '}'; }
    catch { return '{"ok":false,"code":"artifact_non_json_result"}'; }
  };
})();`).runInContext(context, { timeout: 250 });
const importError = new Script('new Error("Artifact imports are unavailable")').runInContext(context, { timeout: 250 });
let importsAttempted = false, module;
try {
  module = new SourceTextModule(request.source, { context, identifier: 'rna-artifact.mjs',
    importModuleDynamically: () => { importsAttempted = true; return Promise.reject(importError); } });
} catch { finish({ ok: false, code: 'artifact_invalid_syntax' }); process.exit(0); }
if (module.dependencySpecifiers.length) { finish({ ok: false, code: 'artifact_import_denied' }); process.exit(0); }
try {
  await module.link(() => { throw importError; });
  context.__rnaImportedNamespace = module.namespace;
  new Script('const __rnaArtifactNamespace = globalThis.__rnaImportedNamespace; delete globalThis.__rnaImportedNamespace; delete globalThis.console;').runInContext(context, { timeout: 250 });
  const evaluation = module.evaluate({ timeout: 500 });
  new Script('').runInContext(context, { timeout: 500 });
  await evaluation;
}
catch { finish({ ok: false, code: importsAttempted ? 'artifact_import_denied' : 'artifact_module_failed' }); process.exit(0); }
if (importsAttempted) { finish({ ok: false, code: 'artifact_import_denied' }); process.exit(0); }
try {
  // Namespace and function objects originate in this context. Arguments cross
  // only as a primitive string and are parsed by the captured realm JSON.parse.
  const invocation = `__rnaFunctionCheck(__rnaArtifactNamespace, ${JSON.stringify(request.exportName)}, ${JSON.stringify(JSON.stringify(request.args))}, 'invoke')`;
  const value = new Script(invocation).runInContext(context, { timeout: 500 });
  const status = new Script(`__rnaFunctionCheck(null, null, null, 'status')`).runInContext(context, { timeout: 250 });
  if (status !== 'ready') { finish({ ok: false, code: codesForStatus(status) }); process.exit(0); }
  // Native Promise branding does not execute authored getters and still
  // rejects async returns whose visible prototype was deliberately replaced.
  // No host callback/object is ever made available to the authored realm.
  if (types.isPromise(value)) { finish({ ok: false, code: 'artifact_async_result' }); process.exit(0); }
  const response = new Script(`__rnaFunctionCheck(null, null, null, 'serialize')`).runInContext(context, { timeout: 500 });
  if (importsAttempted) finish({ ok: false, code: 'artifact_import_denied' });
  else if (typeof response !== 'string' || Buffer.byteLength(response) > 96000) finish({ ok: false, code: 'artifact_result_limit' });
  else {
    const parsed = JSON.parse(response);
    if (parsed.ok && Buffer.byteLength(parsed.encoded) > 64000) finish({ ok: false, code: 'artifact_result_limit' });
    else finish(parsed);
  }
} catch { finish({ ok: false, code: 'artifact_function_timeout' }); }

function codesForStatus(status) { return ['artifact_export_unavailable', 'artifact_export_not_function', 'artifact_function_threw'].includes(status) ? status : 'artifact_function_threw'; }
