// ESB64 runtime ExtendScript entry — side-effect-only, atob+btoa slim facade
// for per-eval injection (utf8 codec / caps / install / benchmark pruned).
// Mirrors src/jsx-entry.ts: named imports only, explicit facade, assigned to
// $.global['ESB64']. ESTC config uses a dummy globalName (`__ESB64_RUNTIME_ENTRY__`).
import { atob, atobLane, btoa, btoaLane, btoaClearMemo, atobClearMemo } from './index';

function makeRuntimeFacade(): any {
  return {
    atob: atob,
    btoa: btoa,
    atobLane: atobLane,
    btoaLane: btoaLane,
    btoaClearMemo: btoaClearMemo,
    atobClearMemo: atobClearMemo
  };
}

var __esb64RuntimeGlobal: any = null;
try { if (typeof $ !== 'undefined' && $.global) { __esb64RuntimeGlobal = $.global; } } catch (e) { /* ignore */ }
if (!__esb64RuntimeGlobal) {
  try { __esb64RuntimeGlobal = (Function as any)('return this')(); } catch (e2) { /* ignore */ }
}
if (__esb64RuntimeGlobal) {
  __esb64RuntimeGlobal['ESB64'] = makeRuntimeFacade();
}
