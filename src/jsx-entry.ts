// ESB64 ExtendScript entry — side-effect-only. No exported binding (that would
// force esbuild to emit the module-helper family that legacy ExtendScript
// cannot run). Named imports only (never `import * as`); assemble the facade
// explicitly and assign to $.global['ESB64']. The ESTC config uses a dummy
// globalName (`__ESB64_ENTRY__`) so the bundle carries zero module helpers.
import {
  atob, atobLane, btoa, btoaLane, btoaClearMemo, atobClearMemo, benchmark,
  capabilities, decodeLatin1, decodeUtf8, detectCaps, encodeLatin1, encodeUtf8,
  globalObject, install, utf8Decode, utf8Encode, utf8EncodeFast, utf8EncodeHandrolled
} from './index';

function makeFacade(): any {
  return {
    atob: atob,
    btoa: btoa,
    decodeLatin1: decodeLatin1,
    encodeLatin1: encodeLatin1,
    decodeUtf8: decodeUtf8,
    encodeUtf8: encodeUtf8,
    utf8Decode: utf8Decode,
    utf8Encode: utf8Encode,
    utf8EncodeFast: utf8EncodeFast,
    utf8EncodeHandrolled: utf8EncodeHandrolled,
    capabilities: capabilities,
    install: install,
    benchmark: benchmark,
    // Raw lane exports (used by the accel adapter / advanced callers).
    atobLane: atobLane,
    btoaLane: btoaLane,
    btoaClearMemo: btoaClearMemo,
    atobClearMemo: atobClearMemo,
    detectCaps: detectCaps,
    globalObject: globalObject
  };
}

var __esb64Global: any = null;
try { if (typeof $ !== 'undefined' && $.global) { __esb64Global = $.global; } } catch (e) { /* ignore */ }
if (!__esb64Global) {
  try { __esb64Global = (Function as any)('return this')(); } catch (e2) { /* ignore */ }
}
if (__esb64Global) {
  __esb64Global['ESB64'] = makeFacade();
}
