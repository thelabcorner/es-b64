// btoa lane: latin1 string -> base64 (3 bytes -> 4 chars).
//
// Standard semantics: every char must be in the Latin1 range (0x00-0xFF),
// otherwise an InvalidCharacterError-named Error is thrown. Input is coerced
// with String(text). charCodeAt-based (NUL-safe), builds the output with
// arrays + join (loop concatenation is quadratic in this engine).
//
// PERFORMANCE (measured live, ExtendScript 4.5.6): encodeLoop unrolls 8
// triples per push (24 chars -> one 32-char string via A[]+concat) into a
// pre-sized, REUSED buf array (new Array(FLUSH_AT), index counter, never
// reallocated) flushed at FLUSH_AT=128, using a 64-entry single-char lookup
// array instead of charAt. The flush size and reused buffer both follow
// from the same root cause documented in decode.ts: Array.prototype.join()
// is superlinear past a few hundred elements (0.07 us/elem at 128 vs
// 25.6 us/elem at 32768), so a small flush beats the previous 2048, and
// avoiding buf=[] reallocation on every flush avoids paying for growth the
// engine doesn't amortize. Measured ~23% faster than the previous 4-triple/
// flush=2048/growing-array design at 150 KB, byte-identical output.
// UNLIKE decode.ts, fromCharCode was measured NEUTRAL-TO-WORSE here (this
// call amortizes over less work per call at matching unroll widths); keep
// A[]+concat and do not swap it without re-measuring.
import { ALPHA_CHARS } from './tables';
import { makeBigMemo, bigMemoKey, bigMemoGet, bigMemoSet, BIG_MEMO_MAX_CHARS, BigMemo } from './big-memo';

export var MEMO_ENTRIES = 8;
// Memo inputs capped at 32 KiB. Larger payloads skip the memo: object
// property keys longer than ~80-90K chars are PATHOLOGICAL in this engine
// (verified live 2026-08-06: a plain `o[100000-char-key] = 1` never
// returns, while 80K-char keys cost 37 us). The memo is for repeat small
// payloads (COM envelopes); big payloads must not touch it.
export var MEMO_MAX_CHARS = 1 << 15;
// buf flush threshold for encodeLoop - see the PERFORMANCE note above.
var FLUSH_AT = 128;

var memoKeys: string[] = [];
var memoVals: any = {};

// Big-payload tier: inputs above the small memo cap are keyed by a short
// sample-hash (safe key) with a full-string collision check (~1 us on 1 MB).
var bigMemo: BigMemo = makeBigMemo();

// Single-char lookup for the base64 alphabet: A[i] -> 1-char string.
var A: string[] = buildAlphaTable();
function buildAlphaTable(): string[] {
  var t: string[] = [];
  var i: number;
  for (i = 0; i < 64; i++) {
    t[i] = ALPHA_CHARS.charAt(i);
  }
  return t;
}

// Latin1-range pre-validation. One native regex scan (measured ~6 ms on
// 1 MB vs ~200+ ms of per-char comparisons) replaces the per-char c > 255
// checks in the hot loop. Simple negated char class - linear, safe (no
// alternation-star lookahead patterns).
var NON_LATIN1_RE = /[^\x00-\xff]/;

export function btoaClearMemo(): void {
  memoKeys = [];
  memoVals = {};
}

export function invalidCharacter(msg: string): Error {
  var e: any = new Error(msg);
  try {
    e.name = 'InvalidCharacterError';
  } catch (ignore) {
    // name assignment is best-effort
  }
  return e;
}

export function btoaLane(text: any): string {
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
    bk = bigMemoKey('e', raw, n);
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
    if (NON_LATIN1_RE.test(raw)) {
      failLatin1();
    }
    result = encodeLoop(raw, n);
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
  setMemo(raw, n, ok ? result : (err as Error), !ok);
  if (!ok) throw err;
  return result;
}

function encodeLoop(raw: string, n: number): string {
  var out: string[] = [];
  var buf: string[] = new Array(FLUSH_AT);
  var bi = 0;
  var i = 0;
  var c0: number;
  var c1: number;
  var c2: number;
  var c3: number;
  var c4: number;
  var c5: number;
  var c6: number;
  var c7: number;
  var c8: number;
  var c9: number;
  var c10: number;
  var c11: number;
  var c12: number;
  var c13: number;
  var c14: number;
  var c15: number;
  var c16: number;
  var c17: number;
  var c18: number;
  var c19: number;
  var c20: number;
  var c21: number;
  var c22: number;
  var c23: number;
  // latin1 already validated by NON_LATIN1_RE - no per-char checks here.
  // 8-triple unroll (24 chars -> one 32-char string per push) - see the
  // PERFORMANCE note above.
  while (i + 23 < n) {
    c0 = raw.charCodeAt(i);
    c1 = raw.charCodeAt(i + 1);
    c2 = raw.charCodeAt(i + 2);
    c3 = raw.charCodeAt(i + 3);
    c4 = raw.charCodeAt(i + 4);
    c5 = raw.charCodeAt(i + 5);
    c6 = raw.charCodeAt(i + 6);
    c7 = raw.charCodeAt(i + 7);
    c8 = raw.charCodeAt(i + 8);
    c9 = raw.charCodeAt(i + 9);
    c10 = raw.charCodeAt(i + 10);
    c11 = raw.charCodeAt(i + 11);
    c12 = raw.charCodeAt(i + 12);
    c13 = raw.charCodeAt(i + 13);
    c14 = raw.charCodeAt(i + 14);
    c15 = raw.charCodeAt(i + 15);
    c16 = raw.charCodeAt(i + 16);
    c17 = raw.charCodeAt(i + 17);
    c18 = raw.charCodeAt(i + 18);
    c19 = raw.charCodeAt(i + 19);
    c20 = raw.charCodeAt(i + 20);
    c21 = raw.charCodeAt(i + 21);
    c22 = raw.charCodeAt(i + 22);
    c23 = raw.charCodeAt(i + 23);
    buf[bi++] = A[c0 >> 2] + A[((c0 & 3) << 4) + (c1 >> 4)] +
      A[((c1 & 15) << 2) + (c2 >> 6)] + A[c2 & 63] +
      A[c3 >> 2] + A[((c3 & 3) << 4) + (c4 >> 4)] +
      A[((c4 & 15) << 2) + (c5 >> 6)] + A[c5 & 63] +
      A[c6 >> 2] + A[((c6 & 3) << 4) + (c7 >> 4)] +
      A[((c7 & 15) << 2) + (c8 >> 6)] + A[c8 & 63] +
      A[c9 >> 2] + A[((c9 & 3) << 4) + (c10 >> 4)] +
      A[((c10 & 15) << 2) + (c11 >> 6)] + A[c11 & 63] +
      A[c12 >> 2] + A[((c12 & 3) << 4) + (c13 >> 4)] +
      A[((c13 & 15) << 2) + (c14 >> 6)] + A[c14 & 63] +
      A[c15 >> 2] + A[((c15 & 3) << 4) + (c16 >> 4)] +
      A[((c16 & 15) << 2) + (c17 >> 6)] + A[c17 & 63] +
      A[c18 >> 2] + A[((c18 & 3) << 4) + (c19 >> 4)] +
      A[((c19 & 15) << 2) + (c20 >> 6)] + A[c20 & 63] +
      A[c21 >> 2] + A[((c21 & 3) << 4) + (c22 >> 4)] +
      A[((c22 & 15) << 2) + (c23 >> 6)] + A[c23 & 63];
    if (bi >= FLUSH_AT) {
      out[out.length] = buf.join('');
      bi = 0;
    }
    i += 24;
  }
  while (i < n) {
    c0 = raw.charCodeAt(i);
    c1 = i + 1 < n ? raw.charCodeAt(i + 1) : -1;
    c2 = i + 2 < n ? raw.charCodeAt(i + 2) : -1;
    buf[bi++] = A[c0 >> 2] + A[((c0 & 3) << 4) + (c1 >= 0 ? c1 >> 4 : 0)] +
      (c1 >= 0 ? A[((c1 & 15) << 2) + (c2 >= 0 ? c2 >> 6 : 0)] : '=') +
      (c2 >= 0 ? A[c2 & 63] : '=');
    if (bi >= FLUSH_AT) {
      out[out.length] = buf.join('');
      bi = 0;
    }
    i += 3;
  }
  if (bi > 0) {
    buf.length = bi;
    out[out.length] = buf.join('');
  }
  return out.join('');
}

function failLatin1(): never {
  throw invalidCharacter('btoa: the string to be encoded contains characters outside of the Latin1 range');
}

// MEMO ELIGIBILITY. Object property keys containing U+0000 are unsafe in
// this engine: property lookups and hasOwnProperty compare only up to the
// NUL (verified live 2026-08-06 - o['\u0000abc'] then o['\u0000xyz'] returns
// the first value, and the same holds mid-string), so a NUL-bearing key
// could mis-hit or clobber another key. Skip the memo for such inputs.
function memoEligible(raw: string, n: number): boolean {
  if (n > MEMO_MAX_CHARS || raw === '__proto__') return false;
  return raw.indexOf('\u0000') < 0;
}

function setMemo(raw: string, n: number, value: any, isError: boolean): void {
  if (!memoEligible(raw, n)) return;
  if (!Object.prototype.hasOwnProperty.call(memoVals, raw)) {
    memoKeys[memoKeys.length] = raw;
    if (memoKeys.length > MEMO_ENTRIES) {
      delete memoVals[memoKeys[0]];
      memoKeys.shift();
    }
  }
  memoVals[raw] = { err: isError, value: value };
}
