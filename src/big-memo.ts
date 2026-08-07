// Big-payload memo: a second-tier repeat cache for inputs above the small
// memo's 32 KiB cap.
//
// WHY A HASH KEY: the small memo keys on the raw input string, which is
// unsafe for large inputs - object property keys longer than ~80-90K chars
// are pathological in this engine (verified live: a plain
// `o[100000-char-key] = 1` never returns). The big memo keys on a SHORT
// sample-hash string instead (safe), and guards against hash collisions
// with a full string === compare - measured at ~1 us on 1 MB strings
// (native memcmp), so the collision check is effectively free. Even a
// weak hash is SAFE: a collision is merely a cache miss, never a wrong
// result.
//
// COSTS (measured live, ExtendScript 4.5.6): a 1024-sample hash of 1 MB is
// ~1 ms (0.07% of a cold 1.51 s decode); a memo HIT is ~7.7 ms vs 1.51 s
// cold - ~196x on repeat large payloads (COM clipboard dumps, SVG warp
// artifacts).
//
// MEMORY: each entry stores input + output (~2.3x payload). Entries are
// capped at 2 and inputs above BIG_MEMO_MAX_CHARS (2 MiB) are not memoized
// at all; the src/value strings are shared by reference (strings are
// immutable, so hits are safe - same contract as the small memo).

export var BIG_MEMO_ENTRIES = 2;
export var BIG_MEMO_MAX_CHARS = 1 << 21; // 2 MiB inputs max

export interface BigMemo {
  keys: string[];
  vals: any;
}

export function makeBigMemo(): BigMemo {
  return { keys: [], vals: {} };
}

// Short collision-resistant-enough key: length + two 32-bit rolling hashes
// over ~1024 sampled code units. The === collision check makes hash
// strength irrelevant to correctness.
export function bigMemoKey(lane: string, raw: string, n: number): string {
  var h1 = 0;
  var h2 = 0;
  var step = Math.max(1, Math.floor(n / 1024));
  var i: number;
  var c: number;
  for (i = 0; i < n; i += step) {
    c = raw.charCodeAt(i);
    h1 = (h1 * 31 + c) >>> 0;
    h2 = (h2 * 17 + c + i) >>> 0;
  }
  return lane + ':' + n + ':' + h1 + ':' + h2;
}

// Returns { err, value } or undefined on miss. Collision-safe via the full
// string compare (measured ~1 us on 1 MB).
export function bigMemoGet(m: BigMemo, key: string, raw: string): any {
  var hit: any = m.vals[key];
  if (hit === undefined || hit.src !== raw) return undefined;
  return hit;
}

// Stores the result (or the ERROR OBJECT on failure - the hit path re-throws
// it; storing an empty string would silently change the error type).
export function bigMemoSet(m: BigMemo, key: string, raw: string, value: any, isError: boolean): void {
  if (!Object.prototype.hasOwnProperty.call(m.vals, key)) {
    m.keys[m.keys.length] = key;
  }
  m.vals[key] = { src: raw, err: isError, value: value };
  while (m.keys.length > BIG_MEMO_ENTRIES) {
    delete m.vals[m.keys[0]];
    m.keys.shift();
  }
}
