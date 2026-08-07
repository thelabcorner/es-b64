// ESB64 facade - base64 + UTF-8 codec layer for ExtendScript (ES3).
//
// Lanes:
//   btoa(text)          latin1 -> base64 (WHATWG btoa semantics; chars > 0xFF
//                       throw InvalidCharacterError). Alias: encodeLatin1.
//   atob(text)          base64 -> latin1 byte string, WHATWG forgiving-base64
//                       (whitespace stripped, missing padding tolerated,
//                       len%4==1 and invalid chars rejected). Alias: decodeLatin1.
//   encodeUtf8(text)    UTF-8 -> base64 (TextEncoder semantics: lone
//                       surrogates -> U+FFFD).
//   decodeUtf8(text)    base64 -> UTF-8 decoded string (WHATWG decoder,
//                       malformed sequences -> U+FFFD).
//   utf8Encode/utf8Decode  raw byte-string lanes (no base64).
//   capabilities()      runtime fingerprints (native atob/btoa classification)
//   install()           true-polyfill install of global atob/btoa (gap-fill
//                       only, unless forceReplace)
//   benchmark()         in-module quick benchmark (hires timer when present)
//
// Both atob and btoa memoize repeat payloads in an 8-entry LRU (string
// results are immutable, so memo hits are safe to share - unlike ESON's parse
// memo which returns shared object references). Payloads > 128 KiB skip the
// memo to bound memory.
import { B64Capabilities, BenchItem, InstallOptions } from './types';
import { btoaLane, btoaClearMemo } from './encode';
import { atobLane, atobClearMemo } from './decode';
import { utf8Encode, utf8Decode, utf8EncodeFast, utf8EncodeHandrolled } from './utf8';
import { detectCaps, globalObject } from './caps';

export function btoa(text: any): string {
  return btoaLane(text);
}

export function atob(text: any): string {
  return atobLane(text);
}

export function encodeLatin1(text: any): string {
  return btoaLane(text);
}

export function decodeLatin1(text: any): string {
  return atobLane(text);
}

export function encodeUtf8(text: any): string {
  return btoaLane(utf8Encode(text));
}

export function decodeUtf8(text: any): string {
  return utf8Decode(atobLane(text));
}

export { utf8Encode, utf8Decode, utf8EncodeFast, utf8EncodeHandrolled };

export function capabilities(): B64Capabilities {
  return detectCaps(globalObject());
}

export function install(options?: InstallOptions): B64Capabilities {
  var g = globalObject();
  if (!g) return detectCaps(g);
  var force = !!(options && options.forceReplace);
  var wantAtob = force || typeof g.atob !== 'function';
  var wantBtoa = force || typeof g.btoa !== 'function';
  if (wantAtob) {
    try {
      g.atob = atobLane;
    } catch (e) {
      // best-effort
    }
  }
  if (wantBtoa) {
    try {
      g.btoa = btoaLane;
    } catch (e) {
      // best-effort
    }
  }
  return detectCaps(g);
}

// ---- quick in-module benchmark -------------------------------------------------

function nowUs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now() * 1000;
  }
  if (typeof $ !== 'undefined' && $.hiresTimer) {
    return $.hiresTimer;
  }
  return Date.now() * 1000;
}

function timeLane(fn: () => void, iterations: number): number[] {
  var samples: number[] = [];
  var i: number;
  var t0: number;
  var t1: number;
  var d: number;
  for (i = 0; i < iterations; i++) {
    t0 = nowUs();
    fn();
    t1 = nowUs();
    d = t1 - t0;
    // Reject wrap-corrupted samples: $.hiresTimer is a signed 32-bit
    // microsecond counter that wraps every ~35.8 min and produces garbage
    // on the first read after a fresh eval (d < 0 || d > 10s).
    if (d > 0 && d < 10000000) samples[samples.length] = d;
  }
  return samples;
}

function median(samples: number[]): number {
  var s = samples.slice(0);
  s.sort(function (a: number, b: number): number { return a - b; });
  return s[Math.floor(s.length / 2)];
}

export function benchmark(iterations?: number): BenchItem[] {
  var it = iterations || 100;
  var g = globalObject();
  var nativeAtob = typeof g.atob === 'function' ? g.atob : null;
  var nativeBtoa = typeof g.btoa === 'function' ? g.btoa : null;

  // btoa/atob lanes are latin1-only by spec; unicode goes through the utf8
  // lanes below.
  var payload = '{"operation":"export-dieline","bend":35,"layers":12,"glyphs":"\u00e9\u00e8\u00ff\u0000\u007f\u00a9\u00ae"}';
  var payloadB64: string;
  try {
    payloadB64 = btoaLane(payload);
  } catch (e) {
    payloadB64 = '';
  }

  var out: BenchItem[] = [];
  var nativeUs: number;
  var ratio: number;

  var oursBtoa = timeLane(function (): void { btoaLane(payload); }, it);
  nativeUs = nativeBtoa ? median(timeLane(function (): void { nativeBtoa(payload); }, it)) : 0;
  ratio = nativeUs > 0 ? nativeUs / median(oursBtoa) : 0;
  out[out.length] = lane('btoa', 'latin1', it, oursBtoa, payloadB64.length, ratio);

  var oursAtob = timeLane(function (): void { atobLane(payloadB64); }, it);
  nativeUs = nativeAtob ? median(timeLane(function (): void { nativeAtob(payloadB64); }, it)) : 0;
  ratio = nativeUs > 0 ? nativeUs / median(oursAtob) : 0;
  out[out.length] = lane('atob', 'latin1', it, oursAtob, payload.length, ratio);

  var utf8Payload = 'dieline export: é 日本語 😀 नमस्ते العربية π 100%';
  var oursUtf8Enc = timeLane(function (): void { utf8Encode(utf8Payload); }, it);
  out[out.length] = lane('utf8Encode', 'unicode', it, oursUtf8Enc, utf8Payload.length, 0);

  var bytes = utf8Encode(utf8Payload);
  var oursUtf8Dec = timeLane(function (): void { utf8Decode(bytes); }, it);
  out[out.length] = lane('utf8Decode', 'unicode', it, oursUtf8Dec, bytes.length, 0);

  return out;
}

function lane(laneName: string, payload: string, iterations: number, samples: number[], outputBytes: number, vsNative: number): BenchItem {
  var sorted = samples.slice(0);
  sorted.sort(function (a: number, b: number): number { return a - b; });
  var medianUs = sorted[Math.floor(sorted.length / 2)];
  return {
    lane: laneName,
    payload: payload,
    iterations: iterations,
    medianUs: medianUs,
    minUs: sorted[0],
    p95Us: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    opsPerSec: medianUs > 0 ? 1000000 / medianUs : 0,
    outputBytes: outputBytes,
    vsNative: vsNative
  };
}

export { btoaLane, atobLane, btoaClearMemo, atobClearMemo, detectCaps, globalObject };
