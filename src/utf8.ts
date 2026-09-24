// UTF-8 string codec (extended ESB64 lanes; not part of the atob/btoa spec).
//
// utf8Encode: string -> latin1 byte string. WHATWG TextEncoder semantics:
// lone surrogates encode as U+FFFD (EF BF BD), valid pairs as 4-byte
// sequences. No base64 here - the caller composes (encodeUtf8 = btoa of this).
//
// utf8Decode: latin1 byte string -> string. WHATWG UTF-8 decoder
// (https://encoding.spec.whatwg.org/#utf-8-decoder) with replacement:
// every malformed sequence (overlong, out-of-range, stray continuation,
// truncated at EOF) yields one U+FFFD per WHATWG error rules.
//
// ENCODER LANES. The engine's native escaping functions ARE a UTF-8 encoder:
// encodeURIComponent escapes non-ASCII to %XX UTF-8 bytes and unescape
// reverses that, so `unescape(encodeURIComponent(s))` is the UTF-8 byte
// string - measured 51x faster than the hand-rolled encoder in the live
// engine (28.6 ms vs 1456 ms on ~450 KB, ExtendScript 4.5.6). The ONLY
// semantic difference: encodeURIComponent throws URIError on lone surrogates
// while TextEncoder replaces them with U+FFFD. The fast lane therefore falls
// back to the hand-rolled encoder on URIError - the semantics never change.
// This is the eval-adjacent stroke the engine grants base64, analogous to
// ESON's eval-as-grammar-checker: a native kernel does the work, we keep the
// contract.
//
// ENGINE MIS-COMPILATION (verified live 2026-08-06): mixed bitwise | and &
// chains evaluate left-associatively (C-style), ignoring precedence -
// `128 | c & 63` computes `(128 | c) & 63`. This is the bitwise sibling of
// the documented ternary/&&-|| bugs. Byte builders must never mix | and &
// in one expression (esbuild would strip corrective parens); compute into
// temps with single-operator expressions instead. Arithmetic + is safe
// where the operand bits never overlap.
//
// PERFORMANCE: per-char emission goes through the BYTE_CHARS lookup as ONE
// concatenated string per char (1 array push per char; writes are
// ~15-25 us each in this engine), flushed as string chunks at 1024 entries
// (apply-style number flushing measured ~4x slower at 4096 vs 1024).
import { BYTE_CHARS } from './tables';
import { makeBigMemo, bigMemoKey, bigMemoGet, bigMemoSet, BIG_MEMO_MAX_CHARS, BigMemo } from './big-memo';

export function utf8Encode(text: any): string {
  var raw = String(text);
  try {
    if (typeof encodeURIComponent === 'function' && typeof unescape === 'function') {
      return unescape(encodeURIComponent(raw));
    }
  } catch (e) {
    // URIError on lone surrogates: fall through to the hand-rolled lane
  }
  return utf8EncodeHandrolled(raw);
}

export function utf8EncodeFast(text: any): string {
  // Caller-warranted lane: throws URIError on lone surrogates, no fallback.
  return unescape(encodeURIComponent(String(text)));
}

export function utf8EncodeHandrolled(text: any): string {
  var raw = String(text);
  var n = raw.length;
  if (n === 0) return '';
  var out: string[] = [];
  var ch = BYTE_CHARS;
  var i: number;
  var c: number;
  var next: number;
  var cp: number;
  var hi: number;
  var lo: number;
  // Per-char concat accumulation (rope-cheap in this engine, ~1.25 us/op)
  // + one chunk push per 1024 chars: array pushes are ~8-15 us each, so
  // per-char pushes would dominate. Verified: 1M-char concat in 16-char
  // pieces = 78 ms (linear, no quadratic blowup).
  var acc = '';
  for (i = 0; i < n; i++) {
    c = raw.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      if (i + 1 < n) {
        next = raw.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          cp = 0x10000 + ((c - 0xD800) << 10) + (next - 0xDC00);
          i++;
          hi = cp >> 18;
          acc = acc + ch[240 + hi];
          hi = (cp >> 12) & 63;
          acc = acc + ch[128 + hi];
          hi = (cp >> 6) & 63;
          acc = acc + ch[128 + hi];
          lo = cp & 63;
          acc = acc + ch[128 + lo];
        } else {
          acc = acc + ch[0xEF] + ch[0xBF] + ch[0xBD];
        }
      } else {
        acc = acc + ch[0xEF] + ch[0xBF] + ch[0xBD];
      }
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      acc = acc + ch[0xEF] + ch[0xBF] + ch[0xBD];
    } else if (c <= 0x7F) {
      acc = acc + ch[c];
    } else if (c <= 0x7FF) {
      hi = c >> 6;
      lo = c & 63;
      acc = acc + ch[192 + hi] + ch[128 + lo];
    } else {
      hi = c >> 12;
      acc = acc + ch[224 + hi];
      hi = (c >> 6) & 63;
      acc = acc + ch[128 + hi];
      lo = c & 63;
      acc = acc + ch[128 + lo];
    }
    if (acc.length >= 1024) {
      out[out.length] = acc;
      acc = '';
    }
  }
  if (acc.length > 0) out[out.length] = acc;
  return out.join('');
}

export function utf8Decode(bytesText: any): string {
  var raw = String(bytesText);
  var n = raw.length;
  if (n === 0) return '';
  // ASCII-IDENTITY FAST PATH: bytes 0x00-0x7F are all valid single-byte
  // UTF-8 sequences, so an all-ASCII byte string decodes to itself. One
  // native regex scan (measured ~6-8 us/MB) decides; the state machine is
  // skipped entirely on the dominant payload class (JSON/XML/COM envelopes).
  // Semantically exact: bytesNeeded can only become non-zero for b >= 0x80,
  // and the BOM (EF BB BF) is >= 0x80 so it falls through to the decoder.
  if (!HIGH_BYTE_RE.test(raw)) {
    return raw;
  }
  if (memoEligible(raw, n) && Object.prototype.hasOwnProperty.call(memoVals, raw)) {
    var hit: any = memoVals[raw];
    if (hit.err) throw hit.value;
    return hit.value;
  }
  var bk = '';
  if (n > MEMO_MAX_CHARS && n <= BIG_MEMO_MAX_CHARS) {
    bk = bigMemoKey('u', raw, n);
    var bhit: any = bigMemoGet(bigMemo, bk, raw);
    if (bhit !== undefined) {
      if (bhit.err) throw bhit.value;
      return bhit.value;
    }
  }
  var result: string;
  var ok = true;
  var err: Error | null = null;
  try {
    result = decodeBytes(raw, n);
  } catch (e) {
    ok = false;
    err = e as Error;
    result = '';
  }
  // On error the memo must store the ERROR OBJECT (the hit path re-throws
  // it); storing the empty result string would turn the re-throw into a
  // throw of '' - a silent error-type change.
  if (n > MEMO_MAX_CHARS && n <= BIG_MEMO_MAX_CHARS) {
    bigMemoSet(bigMemo, bk, raw, ok ? result : (err as Error), !ok);
  }
  setMemo(raw, ok ? result : (err as Error), !ok);
  if (!ok) throw err;
  return result;
}

// Native scan for any byte >= 0x80 (simple char class - safe).
var HIGH_BYTE_RE = /[\x80-\xff]/;

export var MEMO_ENTRIES = 8;
export var MEMO_MAX_CHARS = 1 << 15;

var memoKeys: string[] = [];
var memoVals: any = {};

// Big-payload tier: see big-memo.ts (hash-keyed, collision-checked).
var bigMemo: BigMemo = makeBigMemo();

function decodeBytes(raw: string, n: number): string {
  var out: string[] = [];
  var ch = BYTE_CHARS;
  var i: number;
  var b: number;
  var bytesNeeded = 0;
  var bytesSeen = 0;
  var cp = 0;
  var lower = 0x80;
  var upper = 0xBF;
  var acc = '';
  for (i = 0; i < n; i++) {
    b = raw.charCodeAt(i);
    if (bytesNeeded === 0) {
      if (b <= 0x7F) {
        acc = acc + ch[b];
      } else if (b >= 0xC2 && b <= 0xDF) {
        bytesNeeded = 1;
        cp = b & 0x1F;
        lower = 0x80;
        upper = 0xBF;
      } else if (b >= 0xE0 && b <= 0xEF) {
        bytesNeeded = 2;
        cp = b & 0x0F;
        lower = 0x80;
        upper = 0xBF;
        if (b === 0xE0) lower = 0xA0;
        if (b === 0xED) upper = 0x9F;
      } else if (b >= 0xF0 && b <= 0xF4) {
        bytesNeeded = 3;
        cp = b & 0x07;
        lower = 0x80;
        upper = 0xBF;
        if (b === 0xF0) lower = 0x90;
        if (b === 0xF4) upper = 0x8F;
      } else {
        acc = acc + FFFD;
      }
    } else if (b < lower || b > upper) {
      acc = acc + FFFD;
      bytesNeeded = 0;
      bytesSeen = 0;
      cp = 0;
      lower = 0x80;
      upper = 0xBF;
      // ASCII bytes and valid start bytes are reprocessed as a new sequence;
      // stray continuation bytes (0x80-0xBF) are discarded (WHATWG).
      if (b <= 0x7F || (b >= 0xC2 && b <= 0xDF) || (b >= 0xE0 && b <= 0xEF) || (b >= 0xF0 && b <= 0xF4)) {
        i--;
      }
    } else {
      // NOTE: never mix `<<` with `|`/`&` in one expression - the engine
      // evaluates & and | left-associatively at equal precedence (verified
      // live 2026-08-06), so `cp << 6 | b & 63` would compute
      // `((cp << 6) | b) & 63`. Split into temps; `+` is safe because the
      // low 6 bits are always 0 in cp << 6.
      var t = b & 63;
      cp = (cp << 6) + t;
      bytesSeen++;
      if (bytesSeen === bytesNeeded) {
        acc = acc + emitCodePoint(ch, cp);
        bytesNeeded = 0;
        bytesSeen = 0;
        cp = 0;
        lower = 0x80;
        upper = 0xBF;
      } else {
        lower = 0x80;
        upper = 0xBF;
      }
    }
    if (acc.length >= 2048) {
      out[out.length] = acc;
      acc = '';
    }
  }
  if (bytesNeeded > 0) {
    acc = acc + FFFD;
  }
  if (acc.length > 0) out[out.length] = acc;
  return out.join('');
}

var FFFD = String.fromCharCode(0xFFFD);

// Memo guards mirror encode/decode lanes: NUL-bearing property keys mis-hit
// in this engine; long keys (> ~80-90K chars) are pathological.
function memoEligible(raw: string, n: number): boolean {
  if (n > MEMO_MAX_CHARS || raw === '__proto__') return false;
  return raw.indexOf('\u0000') < 0;
}

function setMemo(raw: string, value: any, isError: boolean): void {
  if (!memoEligible(raw, raw.length)) return;
  if (!Object.prototype.hasOwnProperty.call(memoVals, raw)) {
    memoKeys[memoKeys.length] = raw;
    if (memoKeys.length > MEMO_ENTRIES) {
      delete memoVals[memoKeys[0]];
      memoKeys.shift();
    }
  }
  memoVals[raw] = { err: isError, value: value };
}

// Code point -> string: BMP via BYTE_CHARS when <= 0xFF, String.fromCharCode
// otherwise; supplementary plane as a surrogate pair (fromCharCode truncates
// code points > 0xFFFF).
function emitCodePoint(ch: string[], cp: number): string {
  if (cp >= 0x10000 && cp <= 0x10FFFF) {
    var c = cp - 0x10000;
    return (String.fromCharCode as any)(0xD800 + (c >> 10), 0xDC00 + (c & 0x3FF));
  } else if (cp <= 0xFF) {
    return ch[cp];
  }
  return String.fromCharCode(cp);
}
