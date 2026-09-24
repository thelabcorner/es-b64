// Capability probing: what does the host already expose for base64?
//
// The bare Illustrator engine has no atob/btoa at all (probed live,
// ExtendScript 4.5.6). Other hosts or injected polyfills (engine-state
// contamination, cf. ESON's JSON) may provide one - ESB64 never hardcodes
// availability: it fingerprints whatever exists.
import { B64Capabilities, MemoStats } from './types';
import { MEMO_ENTRIES as BTOA_ENTRIES, MEMO_MAX_CHARS as BTOA_MAX } from './encode';
import { MEMO_ENTRIES as ATOB_ENTRIES, MEMO_MAX_CHARS as ATOB_MAX } from './decode';

export function classifyGlobalFn(g: any, name: string): string {
  var fn: any = null;
  try {
    if (typeof g[name] === 'function') fn = g[name];
  } catch (e) {
    fn = null;
  }
  if (fn === null) return 'absent';
  var src = '';
  try {
    src = String(fn);
  } catch (e) {
    src = '';
  }
  if (src.indexOf('[native code]') >= 0) return 'native-looking';
  if (src.indexOf('ESB64') >= 0 || src.indexOf('ALPHA_CHARS') >= 0) return 'known ESB64';
  // Behavioral spot check: Node (>= 16) implements atob/btoa in JS (no
  // '[native code]' marker), so a source fingerprint alone under-classifies.
  // The forgiving-padding probe ('Zg' -> 'f') is a strong discriminator for
  // WHATWG-correct behavior.
  try {
    if (name === 'atob' && fn('Zg==') === 'f' && fn('') === '' && fn('Zg') === 'f') return 'functional';
    if (name === 'btoa' && fn('f') === 'Zg==' && fn('') === '' && fn('fo') === 'Zm8=') return 'functional';
  } catch (e) {
    // fall through
  }
  return 'unknown';
}

export function detectCaps(g: any): B64Capabilities {
  var atobCls = classifyGlobalFn(g, 'atob');
  var btoaCls = classifyGlobalFn(g, 'btoa');
  var memoStat = function (entries: number, maxChars: number): MemoStats {
    return { enabled: true, entries: entries, maxEntryChars: maxChars };
  };
  var usable = function (cls: string): boolean {
    return cls !== 'absent' && cls !== 'unknown';
  };
  return {
    nativeAtob: usable(atobCls),
    nativeBtoa: usable(btoaCls),
    atobClassification: atobCls,
    btoaClassification: btoaCls,
    engine: {
      globalAtobPresent: atobCls !== 'absent',
      globalBtoaPresent: btoaCls !== 'absent'
    },
    utf8: true,
    memo: {
      atob: memoStat(ATOB_ENTRIES, ATOB_MAX),
      btoa: memoStat(BTOA_ENTRIES, BTOA_MAX)
    }
  };
}

export function globalObject(): any {
  // ExtendScript's true global is $.global; Function("return this")() can
  // resolve to a caller-scope this inside a COM eval wrapper, so $.global
  // wins when present.
  try {
    if (typeof $ !== 'undefined' && $.global) return $.global;
  } catch (e) {
    // fall through
  }
  try {
    return (Function as any)('return this')();
  } catch (e) {
    return null;
  }
}
