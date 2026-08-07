// atob lane: base64 -> latin1 byte string, WHATWG forgiving-base64 semantics
// (https://infra.spec.whatwg.org/#forgiving-base64-decode).
//
// PERFORMANCE (measured live, ExtendScript 4.5.6): decodeFast unrolls 8
// quartets per push (32 chars -> one fromCharCode(24 args) call) into a
// pre-sized, REUSED buf array (new Array(FLUSH_AT), index counter, never
// reallocated) flushed at FLUSH_AT=128. Two independent findings drive this:
// (1) Array.prototype.join() is superlinear past a few hundred elements
// (measured 0.07 us/elem at 128 vs 25.6 us/elem at 32768 - a ~365x
// per-element blowup), so many small joins beat one big one; a flush of
// 2048 (the previous value) already sits partway up that curve. (2) a
// multi-arg String.fromCharCode(...) call beats building the same chunk via
// CH[]-lookup + concat-chain by ~37% once it amortizes over enough work
// (24 args here) - it was neutral-to-worse at the smaller 12-arg width the
// encode lane uses, so this trade is decode-specific; do not port it to
// encode.ts without re-measuring. Combined, this measured ~21% faster than
// the previous 16-char/flush=2048/CH[]+concat design at 200 KB, with
// byte-identical output verified at every step. charCodeAt itself is an
// unbeatable floor in this engine (measured against replace-callback,
// exec-loop, arithmetic extraction, and packed-value tables - all lost);
// none of the above touches the input scan, only the output-side cost.
//
// Two paths:
//   fast:   no ASCII whitespace (one native regex scan to decide) - the
//           common case; gate on length/padding rules, decode straight
//           through with inline charset checks.
//   general: whitespace-bearing input; single pass that skips whitespace,
//           tracks padding and validates inline.
// Both share the DT/CH lookup tables and the chunked string emit.
import { DEC_TABLE, BYTE_CHARS } from './tables';
import { invalidCharacter } from './encode';
import { makeBigMemo, bigMemoKey, bigMemoGet, bigMemoSet, BIG_MEMO_MAX_CHARS, BigMemo } from './big-memo';

export var MEMO_ENTRIES = 8;
// See encode.ts: property keys > ~80-90K chars hang this engine, so the memo
// is capped at 32 KiB inputs.
export var MEMO_MAX_CHARS = 1 << 15;
// buf flush threshold for decodeFast - see the PERFORMANCE note above.
var FLUSH_AT = 128;

var memoKeys: string[] = [];
var memoVals: any = {};

// Single-char lookup for decoded bytes: CH[byte] -> 1-char string.
var CH: string[] = BYTE_CHARS;

// Big-payload tier: see big-memo.ts (hash-keyed, collision-checked).
var bigMemo: BigMemo = makeBigMemo();

export function atobClearMemo(): void {
  memoKeys = [];
  memoVals = {};
}

export function atobLane(text: any): string {
  var raw = String(text);
  var n = raw.length;
  if (n === 0) return '';
  if (memoEligible(raw, n) && Object.prototype.hasOwnProperty.call(memoVals, raw)) {
    var hit: any = memoVals[raw];
    if (hit.err) throw hit.value;
    return hit.value;
  }
  var bk = '';
  if (n > MEMO_MAX_CHARS && n <= BIG_MEMO_MAX_CHARS) {
    bk = bigMemoKey('d', raw, n);
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
    if (WS_RE.test(raw)) {
      // Whitespace path: strip natively, then the fast path's gates and
      // charset regex validate the cleaned text (spec strips whitespace
      // before applying length/padding rules - exact order preserved).
      var stripped = raw.replace(WS_RE_G, '');
      result = decodeFast(stripped, stripped.length);
    } else {
      result = decodeFast(raw, n);
    }
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

function fail(raw: string, msg: string): never {
  throw invalidCharacter(msg);
}

// One native scan to pick the path. The JS charCodeAt loop for this measured
// 1,143 ms on 1.33 MB while the regex scans in 8 ms (~141x faster) - the
// engine's regex engine runs natively. Simple char class, no alternation-star
// lookahead patterns (the documented hang risk), so it is linear and safe.
var WS_RE = /[ \t\n\f\r]/;
var WS_RE_G = /[ \t\n\f\r]/g;

// Anchored charset gate: base64 alphabet, padding only at the end, run of at
// most two '='. Single char class inside the star, no alternation, no
// lookahead - linear and safe. When it passes, every body char is guaranteed
// in [A-Za-z0-9+/], so the decode loops need NO per-char validation (the
// 32-comparison check block measured ~0.3-1.3 s/MB of interpreter work).
// NOTE: the '/' inside the class MUST be escaped - this engine's regex-literal
// parser treats an unescaped '/' in a class as the terminator (verified live
// 2026-08-06: /[A-Za-z0-9+/]/ is a SyntaxError; /[A-Za-z0-9+\/]/ parses).
var B64_RE = /^[A-Za-z0-9+\/]*={0,2}$/;

// No-whitespace path: validate length/padding/charset upfront with O(1)
// gates + one native regex, then decode straight through with NO per-char
// validation (the regex guarantees every body char is in the alphabet).
function decodeFast(raw: string, n: number): string {
  if ((n & 3) === 1) {
    fail(raw, 'atob: the string to be decoded is not correctly encoded');
  }
  if (!B64_RE.test(raw)) {
    fail(raw, 'atob: the string to be decoded is not correctly encoded');
  }
  // A trailing '=' is only legal when the length is a multiple of 4 (the
  // strip rule fires at n % 4 == 0; otherwise '=' is an invalid character).
  if (n >= 1 && raw.charCodeAt(n - 1) === 61 && (n & 3) !== 0) {
    fail(raw, 'atob: the string to be decoded is not correctly encoded');
  }
  var strip = 0;
  if ((n & 3) === 0) {
    if (raw.charCodeAt(n - 1) === 61) {
      strip = (n >= 2 && raw.charCodeAt(n - 2) === 61) ? 2 : 1;
    }
  }
  var body = n - strip;
  if ((body & 3) === 1) {
    fail(raw, 'atob: the string to be decoded is not correctly encoded');
  }
  var out: string[] = [];
  var buf: string[] = new Array(FLUSH_AT);
  var bi = 0;
  var i: number;
  var p0: number;
  var p1: number;
  var p2: number;
  var p3: number;
  var p4: number;
  var p5: number;
  var p6: number;
  var p7: number;
  var p8: number;
  var p9: number;
  var p10: number;
  var p11: number;
  var p12: number;
  var p13: number;
  var p14: number;
  var p15: number;
  var q0: number;
  var q1: number;
  var q2: number;
  var q3: number;
  var q4: number;
  var q5: number;
  var q6: number;
  var q7: number;
  var q8: number;
  var q9: number;
  var q10: number;
  var q11: number;
  var q12: number;
  var q13: number;
  var q14: number;
  var q15: number;
  // Unrolled 8 quartets per push (32 chars -> one fromCharCode(24 args)
  // call) - see the PERFORMANCE note above. No validation here - B64_RE
  // guarantees all lookups are valid.
  var main32 = body - 31;
  for (i = 0; i < main32; i += 32) {
    p0 = DEC_TABLE[raw.charCodeAt(i)];
    p1 = DEC_TABLE[raw.charCodeAt(i + 1)];
    p2 = DEC_TABLE[raw.charCodeAt(i + 2)];
    p3 = DEC_TABLE[raw.charCodeAt(i + 3)];
    p4 = DEC_TABLE[raw.charCodeAt(i + 4)];
    p5 = DEC_TABLE[raw.charCodeAt(i + 5)];
    p6 = DEC_TABLE[raw.charCodeAt(i + 6)];
    p7 = DEC_TABLE[raw.charCodeAt(i + 7)];
    p8 = DEC_TABLE[raw.charCodeAt(i + 8)];
    p9 = DEC_TABLE[raw.charCodeAt(i + 9)];
    p10 = DEC_TABLE[raw.charCodeAt(i + 10)];
    p11 = DEC_TABLE[raw.charCodeAt(i + 11)];
    p12 = DEC_TABLE[raw.charCodeAt(i + 12)];
    p13 = DEC_TABLE[raw.charCodeAt(i + 13)];
    p14 = DEC_TABLE[raw.charCodeAt(i + 14)];
    p15 = DEC_TABLE[raw.charCodeAt(i + 15)];
    q0 = DEC_TABLE[raw.charCodeAt(i + 16)];
    q1 = DEC_TABLE[raw.charCodeAt(i + 17)];
    q2 = DEC_TABLE[raw.charCodeAt(i + 18)];
    q3 = DEC_TABLE[raw.charCodeAt(i + 19)];
    q4 = DEC_TABLE[raw.charCodeAt(i + 20)];
    q5 = DEC_TABLE[raw.charCodeAt(i + 21)];
    q6 = DEC_TABLE[raw.charCodeAt(i + 22)];
    q7 = DEC_TABLE[raw.charCodeAt(i + 23)];
    q8 = DEC_TABLE[raw.charCodeAt(i + 24)];
    q9 = DEC_TABLE[raw.charCodeAt(i + 25)];
    q10 = DEC_TABLE[raw.charCodeAt(i + 26)];
    q11 = DEC_TABLE[raw.charCodeAt(i + 27)];
    q12 = DEC_TABLE[raw.charCodeAt(i + 28)];
    q13 = DEC_TABLE[raw.charCodeAt(i + 29)];
    q14 = DEC_TABLE[raw.charCodeAt(i + 30)];
    q15 = DEC_TABLE[raw.charCodeAt(i + 31)];
    buf[bi++] = String.fromCharCode(
      (p0 << 2) + (p1 >> 4), ((p1 & 15) << 4) + (p2 >> 2), ((p2 & 3) << 6) + p3,
      (p4 << 2) + (p5 >> 4), ((p5 & 15) << 4) + (p6 >> 2), ((p6 & 3) << 6) + p7,
      (p8 << 2) + (p9 >> 4), ((p9 & 15) << 4) + (p10 >> 2), ((p10 & 3) << 6) + p11,
      (p12 << 2) + (p13 >> 4), ((p13 & 15) << 4) + (p14 >> 2), ((p14 & 3) << 6) + p15,
      (q0 << 2) + (q1 >> 4), ((q1 & 15) << 4) + (q2 >> 2), ((q2 & 3) << 6) + q3,
      (q4 << 2) + (q5 >> 4), ((q5 & 15) << 4) + (q6 >> 2), ((q6 & 3) << 6) + q7,
      (q8 << 2) + (q9 >> 4), ((q9 & 15) << 4) + (q10 >> 2), ((q10 & 3) << 6) + q11,
      (q12 << 2) + (q13 >> 4), ((q13 & 15) << 4) + (q14 >> 2), ((q14 & 3) << 6) + q15
    );
    if (bi >= FLUSH_AT) {
      out[out.length] = buf.join('');
      bi = 0;
    }
  }
  // leftover quartets (0-7 after the unrolled loop)
  for (; i + 3 < body; i += 4) {
    p0 = DEC_TABLE[raw.charCodeAt(i)];
    p1 = DEC_TABLE[raw.charCodeAt(i + 1)];
    p2 = DEC_TABLE[raw.charCodeAt(i + 2)];
    p3 = DEC_TABLE[raw.charCodeAt(i + 3)];
    buf[bi++] = CH[(p0 << 2) + (p1 >> 4)] + CH[((p1 & 15) << 4) + (p2 >> 2)] + CH[((p2 & 3) << 6) + p3];
    if (bi >= FLUSH_AT) {
      out[out.length] = buf.join('');
      bi = 0;
    }
  }
  var rem = body & 3;
  if (rem === 2) {
    p0 = DEC_TABLE[raw.charCodeAt(body - 2)];
    p1 = DEC_TABLE[raw.charCodeAt(body - 1)];
    buf[bi++] = CH[(p0 << 2) + (p1 >> 4)];
  } else if (rem === 3) {
    p0 = DEC_TABLE[raw.charCodeAt(body - 3)];
    p1 = DEC_TABLE[raw.charCodeAt(body - 2)];
    p2 = DEC_TABLE[raw.charCodeAt(body - 1)];
    buf[bi++] = CH[(p0 << 2) + (p1 >> 4)] + CH[((p1 & 15) << 4) + (p2 >> 2)];
  }
  if (bi > 0) {
    buf.length = bi;
    out[out.length] = buf.join('');
  }
  return out.join('');
}

// See encode.ts: NUL-bearing property keys mis-hit in this engine, so the
// memo skips them entirely.
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
