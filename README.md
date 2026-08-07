<div align="center">

# ESB64: Base64 + UTF-8 for Adobe ExtendScript (ES3)

## ExtendScript Base64 = E.S.B64

### The drop-in `atob` / `btoa` library for Adobe Illustrator, InDesign, Photoshop & any ExtendScript host

[![WHATWG: forgiving-base64](https://img.shields.io/badge/base64-WHATWG%20forgiving%20base64-success)](https://infra.spec.whatwg.org/#forgiving-base64-decode)
[![WPT: base64.json](https://img.shields.io/badge/WPT-base64.json%2080%2F80%20vectors-purple)](https://github.com/web-platform-tests/wpt)
[![UTF-8: WHATWG](https://img.shields.io/badge/UTF-8-WHATWG%20TextEncoder%2FDecoder-success)](https://encoding.spec.whatwg.org/)
[![Adobe: Creative Suite](https://img.shields.io/badge/Adobe%20-Creative%20Suite-red?logo=adobe&logoColor=white)](https://extendscript.docsforadobe.dev/)
[![Engine](https://img.shields.io/badge/ExtendScript-ES3-green)](#compatibility)
[![Size](https://img.shields.io/badge/runtime-15.8%20KB-orange)](#installation)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL%203.0--or--later-blue)](https://www.gnu.org/licenses/gpl-3.0.html)

</div>

---

> **From the same team: [ESON](https://github.com/thelabcorner/eson) — strict JSON for ExtendScript, and [ArcFit.dev](https://arcfit.dev) — deterministic arc warp for Illustrator.**

---

## Why ESB64?

**ExtendScript ships no `atob`/`btoa` at all** (probed live on Illustrator 30.6.0 / ExtendScript 4.5.6: `typeof atob === "undefined"`). Every script that needs base64 — data-URL artwork, clipboard transport, socket/COM envelopes, binary job files — has to either hand-roll a codec (slow, easy to get wrong) or inject a polyfill. ESB64 is the polyfill, engineered specifically for the ES3 engine and hardened by differential fuzzing against V8's native `atob`/`btoa` (140,000+ checks, zero divergences) plus the WPT `base64.json` corpus that browsers themselves are tested against.

The codecs are **byte-identical to the browser/Node native implementations by construction**: btoa uses the RFC 4648 alphabet; atob implements the WHATWG forgiving-base64 decode (whitespace stripped, missing padding tolerated, `length % 4 == 1` and invalid characters rejected); the extended UTF-8 lanes implement the WHATWG TextEncoder/Decoder (lone surrogates → U+FFFD on encode; malformed sequences → U+FFFD on decode). Verified live in the Illustrator engine — not just parsed in Node.

---

## Features

- **Drop-in `atob`/`btoa`**: standard semantics, `InvalidCharacterError`-named errors. Installs the globals only when absent (true polyfill semantics — unlike ESON, which *replaces* the native JSON because the native one is permissive; a native base64, where it exists, is already spec-correct).
- **WHATWG forgiving-base64 `atob`**: strips ASCII whitespace, tolerates missing padding, rejects `length % 4 == 1` and non-alphabet characters. Matches the WPT `base64.json` corpus (80/80 vectors) that Chrome/Firefox/Safari test against.
- **Extended UTF-8 lanes** (`encodeUtf8` / `decodeUtf8`): round-trip any Unicode string through base64. WHATWG TextEncoder/Decoder semantics — lone surrogates become U+FFFD, malformed byte sequences become U+FFFD.
- **Fast UTF-8 encode via the engine's native escaping functions** (`unescape(encodeURIComponent(s))`), measured ~50× faster than the hand-rolled encoder on 450 KB in the live engine (28.6 ms vs 1456 ms). Falls back to the hand-rolled encoder on lone surrogates (where `encodeURIComponent` throws `URIError`), so the contract never changes.
- **Memoized, two-tier**: an 8-entry repeat cache (≤32 KiB inputs) keyed by the exact input skips the codec entirely on repeat payloads, plus a **big-payload tier** (≤2 MiB inputs, 2 entries) keyed by a short sample-hash with a full-string collision check (~1 µs on 1 MB — native memcmp). Big-memo hits measured ~1 ms for 1 MB (vs 1.51 s cold, ~1500×). NUL-bearing and `__proto__` inputs skip the small tier but are handled by the hash tier (its key is the hash, not the input).
- **Strict-charset, engine-safe**: every string scan is `charCodeAt`-based (the engine's `charAt` returns `""` for U+0000); output is built with arrays + `join` (loop concatenation is quadratic in this engine); no mixed bitwise `|`/`&` chains (the engine mis-compiles them — see below).
- **No runtime dependencies**: the production bundle is one file (facade + codec), ~28 KB.
- **Two builds**: full (`ESB64.jsx` — all lanes, capabilities, install, benchmark) and runtime (`vendor-esb64-runtime.js` — `atob`/`btoa` only, 15.8 KB) for per-eval injection.

---

## Which build should I use?

| | **Runtime build** | **Full build** |
|---|---|---|
| Files | `vendor-esb64-runtime.js` | `vendor-esb64.js`, `ESB64.jsx` |
| Size | 15.8 KB | 28.6 KB / 28.2 KB |
| API | `atob`, `btoa` only | `atob`, `btoa`, `encodeUtf8`, `decodeUtf8`, `utf8Encode`, `utf8Decode`, `capabilities`, `install`, `benchmark`, `classifyGlobalB64` |
| Installs global `atob`/`btoa` | yes | yes |
| Best for | per-eval injection, anything that only needs base64 | plugins/scripts that also need the UTF-8 codec, capability probing, or benchmarks |

**Rule of thumb:** if your script only ever calls `atob` and `btoa`, use the runtime build. Reach for the full build only when you need `encodeUtf8`/`decodeUtf8`, `capabilities()`, `install()`, or `benchmark()`.

### Runnable examples

The `examples/` folder ships five runnable, live-verified ExtendScript scripts:
each one loads the needed build relative to its own location (override with
the `ESB64_DIST` env var), runs self-checking demonstrations, and returns a
JSON report as its last-statement value — so they work both from File >
Scripts and from COM/automation (`eval --file examples/01-atob-btoa.jsx`).
Run `npm run build` first so `dist/` exists.

| Example | Build | Demonstrates |
|---|---|---|
| `01-atob-btoa.jsx` | runtime | gap-fill global install, RFC 4648 vectors, latin1 gate, memo |
| `02-forgiving-atob.jsx` | runtime | WHATWG forgiving-base64: whitespace, padding, WPT vectors |
| `03-utf8-codec.jsx` | full | `encodeUtf8`/`decodeUtf8`/`utf8Encode`/`utf8Decode`, malformed-input rules |
| `04-svg-data-url-batch.jsx` | full | export artboard → SVG → base64 data URL → byte-identical decode |
| `05-edge-cases.jsx` | full | NUL, `__proto__`-shaped payloads, 0..255 bytes, lone surrogates |

Each script writes its report to `%TEMP%\esb64example-0N-report.json` as well.

---

## Is there a base64 test corpus like JSONTestSuite?

Not a single canonical "must accept / must-reject" project like [nst/JSONTestSuite](https://github.com/nst/JSONTestSuite). The de-facto standards corpora are:

1. **RFC 4648 §10** — the canonical 7-vector sanity set (`f`, `fo`, `foo`, `foob`, `fooba`, `foobar`, and the empty string).
2. **`web-platform-tests` `fetch/data-urls/resources/base64.json`** — 80 vectors (whitespace, padding rules, invalid characters) with expected byte arrays or must-throw, the corpus the WPT `atob()` tests run against in every browser. Transcribed verbatim into `tests/wpt-b64-corpus.ts`.
3. **WPT `html/webappapis/atob/base64.any.js`** — behavior tests: btoa over all 258 code points, WebIDL coercions, atob IDL cases.
4. Implementation test suites (Go `encoding/base64`, Rust `base64` crate, Python stdlib, `base64-js`).

ESB64's test harness (Node) differential-fuzzes against the **native V8 `atob`/`btoa`** (140,000+ checks across 7 lanes, zero divergences) and runs the full WPT `base64.json` corpus. The live-engine verification (`node tests/esb64-live-verify.mjs`) re-runs a curated battery inside real Illustrator through the COM tool and compares against Node-side expectations computed from the same bundled core.

---

## Installation

### From the repo

```bash
npm install        # devDeps: esbuild, typescript
npm run build      # dist/ESB64.jsx + vendor-esb64.js + vendor-esb64-runtime.js + esb64-core.esm.mjs
npm test           # 411 Node assertions (WPT corpus + differential vs native + utf8)
npm run fuzz       # 140,000 differential fuzz checks vs V8 native atob/btoa, Buffer, TextDecoder
npm run live-verify  # battery inside real Illustrator via the COM tool (agent-skills)
```

### In an Illustrator / InDesign script

Drop-in vendor (gap-fill only — installs `atob`/`btoa` when absent, leaves a correct native alone):

```jsx
$.evalFile(File("C:/path/to/dist/vendor-esb64.js"));
// atob / btoa are now available (ESB64's), ESB64 facade is global
```

Facade only (leaves the global `atob`/`btoa` alone):

```jsx
$.evalFile(File("C:/path/to/dist/ESB64.jsx"));
var data = ESB64.atob(someText);
```

Per-eval injection (runtime build, smallest):

```jsx
// in a high-frequency automation loop, inject once:
$.evalFile(File("C:/path/to/dist/vendor-esb64-runtime.js"));
```

### In Node.js (for tests / automation)

```js
import * as ESB64 from "esb64";
```

---

## Quick Start

```jsx
// ---- atob / btoa (base64) -------------------------------------------
var bytes = ESB64.atob("SGVsbG8gV29ybGQ=");   // "Hello World"
var b64   = ESB64.btoa("Hello World");        // "SGVsbG8gV29ybGQ="

// malformed input THROWS (InvalidCharacterError), standard semantics:
try { ESB64.atob("SGVsbG8!"); } catch (e) { /* InvalidCharacterError */ }

// ---- extended UTF-8 codec (round-trips any Unicode) -----------------
var enc = ESB64.encodeUtf8("dieline \u00e9 \u65e5\u672c\u8a9e \ud83d\ude00");
var back = ESB64.decodeUtf8(enc);             // "dieline é 日本語 😀"

// lone surrogates normalize to U+FFFD on encode (TextEncoder semantics):
ESB64.encodeUtf8("\ud800");                   // "77+9" (EF BF BD)

// ---- install (gap-fill only) ----------------------------------------
ESB64.install();                              // installs globals only when absent
ESB64.install({ forceReplace: true });        // ...or replaces an existing impl

var caps = ESB64.capabilities();              // { nativeAtob, nativeBtoa, ... }

var items = ESB64.benchmark(50);              // in-module quick benchmark
```

---

## API Reference

> **Availability:** the runtime build exposes `atob` and `btoa` only. Every other method is full-build only.

### `atob(text)` / `btoa(text)`

Standard base64. `btoa` throws `InvalidCharacterError` on code points > U+00FF. `atob` implements WHATWG forgiving-base64 (strips ASCII whitespace, tolerates missing padding, rejects `length % 4 == 1` and non-alphabet chars). Both memoize repeat inputs in an 8-entry FIFO (LRU-style repeat cache) (string results are immutable, so hits are safe to share — unlike ESON's parse memo which returns shared object references).

### `encodeUtf8(text)` / `decodeUtf8(text)`

UTF-8 ↔ base64 round-trip for arbitrary Unicode. `encodeUtf8` uses the engine's native escaping functions for speed (~50× faster than hand-rolling) with a hand-rolled fallback on lone surrogates. `decodeUtf8` implements the WHATWG UTF-8 decoder. Both verified against Node's `Buffer`/`TextDecoder` on 720,000+ fuzz iterations.

### `utf8Encode(text)` / `utf8Decode(bytes)`

Raw byte-string lanes (no base64) — useful when you need the UTF-8 byte string itself.

### `capabilities()`

Re-probes the host. Returns `B64Capabilities`:

| Field | Type | Meaning |
|---|---|---|
| `nativeAtob` / `nativeBtoa` | boolean | a usable global atob/btoa exists (native, known-ESB64, or functionally verified) |
| `atobClassification` / `btoaClassification` | string | `'absent'` / `'native-looking'` / `'known ESB64'` / `'functional'` / `'unknown'` |
| `engine` | object | `{ globalAtobPresent, globalBtoaPresent }` |
| `utf8` | boolean | always true |
| `memo` | object | per-lane `{ enabled, entries, maxEntryChars }` |

The `functional` classification uses a behavioral spot-check (Node ≥ 16 implements atob/btoa in JS with no `[native code]` marker, so a source fingerprint alone under-classifies).

### `install(options?)`

Returns fresh `capabilities()` after applying options:

| Option | Effect |
|---|---|
| `forceReplace` | best-effort install of global atob/btoa even when one already exists |

### `benchmark(iterations?)`

Quick in-module benchmark. Lanes: `btoa` (latin1), `atob` (latin1), `utf8Encode` (Unicode), `utf8Decode` (Unicode). Each item: `{ lane, payload, iterations, medianUs, minUs, p95Us, opsPerSec, outputBytes, vsNative }` (`vsNative` is 0 in the engine, which has no native base64).

---

## Spec Conformance

**WHATWG forgiving-base64 decode** ([infra spec](https://infra.spec.whatwg.org/#forgiving-base64-decode)):

| Corpus | Result |
|---|---|
| RFC 4648 §10 vectors | 7/7 |
| WPT `fetch/data-urls/resources/base64.json` (80 vectors, transcribed verbatim) | **80/80** |
| Differential fuzz vs V8 native `atob`/`btoa` (144,000+ checks, 9 lanes) | **0 divergences** |
| Live engine (Illustrator 30.6.0 / ExtendScript 4.5.6) | **66/66** vectors |

**WHATWG TextEncoder/Decoder** ([encoding spec](https://encoding.spec.whatwg.org/)):

| Corpus | Result |
|---|---|
| UTF-8 encode fuzz vs Node `Buffer.from(x, 'utf8').toString('base64')` (20,000+ iters) | **0 divergences** |
| UTF-8 decode fuzz vs Node `TextDecoder` on *valid* byte streams (20,000+ iters) | **0 divergences** |
| Malformed-sequence expectations (overlong, out-of-range, stray continuation, truncated) | hardcoded per WHATWG (Node's ICU-backed `TextDecoder` diverges from WHATWG error grouping on malformed sequences — see below) |

### Known divergence: Node TextDecoder on malformed UTF-8

Node's `TextDecoder` is ICU-backed; ICU emits one U+FFFD per *bad byte*. The WHATWG algorithm groups some errors (e.g. `E0 80 80` → one U+FFFD for the bad start, one for the stray continuation = two U+FFFDs; ICU emits three). Browsers (V8) implement WHATWG exactly. ESB64 follows the spec, so its malformed-sequence expectations are hardcoded rather than oracle-differenced against Node.

---

## Performance

All numbers measured **live in the Illustrator engine** (ExtendScript 4.5.6, 30.6.0) via `probes/esb64-benchmark.jsx` and targeted microbenchmarks (median-of-N runs, `$.hiresTimer`, cold lanes with unique text per iteration so the memo never hits). Environment-specific — report your own numbers for your hardware.

### The optimization that matters: array writes are the enemy

Microbenchmarked in the engine (ExtendScript 4.5.6):

| Primitive | Measured cost |
|---|---|
| `arr[len] = x` / `arr.push(x)` / preallocated `arr[i] = x` | **~15-25 µs each** (the dominant cost in this engine) |
| `str.charCodeAt(i)` | ~0.76 µs |
| `String.fromCharCode.apply(null, arr)` @ 1024 args | ~0.66 µs/arg |
| `String.fromCharCode.apply(null, arr)` @ 4096 args | ~2.9 µs/arg (use 1024!) |
| string concat | ~0.2 µs |
| empty loop iteration | ~0.05 µs |

The original two-pass atob (values array + per-byte buffer + apply flush) did **47K+ array writes for 20 KB → 1.7 s**. The rewritten lane never builds a values array: it validates in a write-free scan, decodes in one pass emitting one 3-char string per quartet via lookup tables + concat (1 push per quartet), and joins string chunks. Same story for btoa (2-triple unroll = half the pushes).

### ESB64 operators (live engine, cold)

| Operator | Payload | Before | After | Δ |
|---|---|---|---|---|
| atob | 20 KB (27 KB b64) | 1.7 s | **~40-63 ms** | **~27-40×** |
| atob | 100 KB (133 KB b64) | ~6.7 s | **152 ms** | **~44×** |
| atob | 1 MB (1.33 MB b64) | ~67 s | **1.51 s** | **~44×** |
| atob (whitespace-bearing) | 100 KB | — | **195 ms** | native-strip path ≈ clean path |
| btoa | 20 KB | ~37 ms | **~24 ms** | ~1.5× |
| btoa | 540 KB | ~1.0 s | **325 ms** | **~3×** |
| btoa | 1 MB | ~1.9 s | **1.16 s** | ~1.6× |
| encodeUtf8 | 340 KB mixed Unicode | — | **206 ms** | — |
| decodeUtf8 | 1 MB **ASCII** | ~7.4 s | **1.51 s** | **~4.9×** (identity fast path; now atob-bound) |
| decodeUtf8 | 400 KB mixed Unicode | — | **2.35 s** | — |
| atob / btoa memo hit | 5 KB | — | **27-29 µs** | — |
| atob memo hit (big tier) | 1 MB | — | **0.97 ms** | vs 1.51 s cold: **~1560×** |
| btoa memo hit (big tier) | 1 MB | — | **1.07 ms** | vs 1.16 s cold: **~1080×** |
| decodeUtf8 memo hit (big tier) | 1 MB mixed | — | **1.94 ms** | vs ~2.4 s cold: **~1200×** |

### Large payloads and the hang question

The codec is **chunked by construction** — no giant intermediate arrays: the
decode emits 12-char strings into a 2048-entry buffer, joins chunks into an
output array, and joins once at the end (bounded transient memory, ~3-4× the
payload). Large inputs do not hang; they scale linearly:

| Payload | atob | btoa | Notes |
|---|---|---|---|
| 1 MB | 1.51 s | 1.16 s | measured |
| 10 MB | ~15 s | ~12 s | extrapolated |
| 30 MB | ~45 s | ~35 s | **approaches the COM tool's default 60 s per-operation deadline** |

Two caveats for very large payloads:

1. **The engine is blocked while the codec runs** (ES3 has no async). A 1 MB
   decode freezes the UI/COM session for ~1.5 s. For interactive contexts,
   keep per-call payloads bounded or drive the work from a background
   `app.scheduleTask` loop (caller-side chunking), never inside a UI event
   handler.
2. **The memo is two-tier**: ≤32 KiB payloads use the string-keyed tier (engine property-key pathology forbids longer keys); 32 KiB-2 MiB payloads use the hash-keyed tier (~1 ms hits on 1 MB, collision-checked with a native `===`, so a hash collision is a cache miss, never a wrong result). Inputs > 2 MiB are never memoized — if your workload decodes the same multi-MB blob repeatedly, cache the result at the call site.

The measured per-MB floor is the engine's `charCodeAt` scan (~1.0 s / 1.33 M
chars) — no faster char-access primitive exists in this engine (`charAt` is
NUL-broken), so ~1.2-1.3 s/MB is the practical atob floor here. The UTF-8
decode side has no such floor for ASCII: the identity fast path skips the
state machine entirely.

### UTF-8 encode: native fast path vs hand-rolled (450 KB mixed Unicode)

| Path | Latency | Δ |
|---|---|---|
| Native (`unescape(encodeURIComponent)`) | **28.6 ms** | — |
| Hand-rolled encoder | 1456 ms | **~51× slower** |

The fast path is why `encodeUtf8` defaults to the native lane with a hand-rolled fallback.

> **When NOT to use base64 for large payloads:** the btoa step dominates `encodeUtf8` at size (450 KB → 600 KB base64). For bulk binary transport where you control both ends, a length-prefixed byte string avoids the 33% btoa overhead. ESB64 is the right call for interchange (data URLs, JSON envelopes, anything that must be base64); a raw-byte transport is the right call when you don't. In this engine, any approach that avoids array writes is faster than any approach that doesn't.

---

## Compatibility

| Target | Status |
|---|---|
| ExtendScript (ES3): Illustrator, InDesign, Photoshop, After Effects, Premiere Pro, InCopy, Bridge | Bundles are ES3-safe (ES5 TypeScript target, esbuild `platform=neutral`) |
| Illustrator 30.6.0 / ExtendScript 4.5.6 | Verified live (probes + live-verify harness) |
| Node.js ≥ 18 | ESM core + test harnesses |
| Windows x86-64 | Development/test only (ExtendScript is Windows/macOS) |

---

## Engine quirks that shaped the design

All measured live on Illustrator 30.6.0 / ExtendScript 4.5.6. Several are not documented anywhere else we could find.

**String semantics**
- `String.prototype.charAt()` returns `""` for U+0000 (NUL is treated as a terminator); `charCodeAt()` works fine. Every string scanner uses `charCodeAt`.
- `Array.prototype.join` and `String.fromCharCode` preserve NUL correctly; `indexOf` works on NUL-containing strings.

**Parser mis-compilation (real, reproducible)**
- **Mixed bitwise `|`/`&` without parentheses mis-evaluate.** `128 | c & 63` evaluates as `(128 | c) & 63` (verified: é → C3 29 instead of C3 A9). Every byte builder is split into single-operator temporaries. *(This is the bitwise sibling of ESON's documented `&&`/`||` chain bug.)*
- **Chained ternaries compile left-assoc (C-style).** Restructure; never nest ternaries.
- **`String.fromCharCode` truncates code points > 0xFFFF** (mod 0x10000). Supplementary-plane code points must be emitted as a surrogate pair (`emitCodePoint`).

**Environment / object model**
- No native `atob`/`btoa` (probed live). No native `b64` anything — ESB64 fills the gap.
- **Array writes cost ~15-25 µs each** (measured: 27,000 `arr[i] = x` = 277-568 ms). The codec design minimizes writes: emit one concatenated string per quartet, never a values array. `String.fromCharCode.apply` is cheap at 1024 args (0.66 µs/arg) but 4× pricier at 4096 (2.9 µs/arg) — flushes chunk at 1024.
- **Native regex scans are ~140× faster than JS charCodeAt loops** (measured: `/[ \t\n\f\r]/.test(1.33 MB)` = 8 ms vs a JS scan = 1,143 ms). The atob whitespace path-picker, the btoa latin1-range gate, and the utf8Decode ASCII-identity gate are one native regex scan each; per-char validation stays in the loops only where the VALUE (not just presence) is needed. Simple char classes only — no alternation-star lookahead patterns (the documented hang risk).
- **A regex LITERAL with an unescaped `/` inside a character class is a SyntaxError in this engine** (verified live: `/[A-Za-z0-9+/]/` fails to parse, `/[A-Za-z0-9+\/]/` works; the parser treats the `/` as the terminator even inside `[...]`). Escape slashes inside classes.
- **`utf8Decode` has an ASCII-identity fast path**: an all-ASCII byte string IS its own UTF-8 decoding, so one native scan + identity return replaces the whole state machine (~1000× on pure-ASCII, verified: decodeUtf8 of 1 MB ASCII = 1.51 s, entirely atob-bound). BOMs (EF BB BF) are ≥ 0x80 and fall through correctly.
- **Small-piece string concat is rope-cheap** (~1.25 µs/op, linear to 1 MB; a 256-char-piece band measured anomalously slow — avoid mid-size piece concat). The UTF-8 lanes accumulate output via per-char concat + one chunk push per 2048 chars instead of per-char pushes.
- **`$.hiresTimer` is a signed 32-bit µs counter** — wraps every ~35.8 min and produces garbage on the first read after a fresh eval. Reject wrap-corrupted samples (`d < 0 || d > 10s`).
- **Object property keys longer than ~80-90K chars are pathological** (verified: a plain `o[100000-char-key] = 1` never returns; 80K-char keys cost 37 µs). The memo is capped at 32 KiB inputs — well below the pathology.
- **String-keyed property lookups terminate at NUL** (verified: `o['\u0000abc'] = 1; o['\u0000xyz']` returns `1`; the same holds mid-string). The memo skips NUL-bearing inputs. This means a NUL in the payload never corrupts another key's entry — but also that the NUL-bearing payload is never memoized (correctness over cache).
- `String.prototype.quote` is absent. `unescape`/`encodeURIComponent` are present (used by the fast UTF-8 lane). `decodeURIComponent` is present.
- Node's `TextDecoder` (ICU) strips a leading U+FEFF by default; the codec round-trips BOMs byte-exactly instead (a BOM is data, not a stream marker). The test oracles pass `ignoreBOM: true`.

**Bundling (esbuild 0.28.1)**
- esbuild strips "redundant" parentheses, including corrective parens around inner ternhens and around mixed bitwise chains. Source-level parens are not a fix for these — restructure the code.

---

## Development

```
npm install            # devDeps: esbuild, typescript
npm run typecheck      # tsc --noEmit (strict)
npm run build          # dist/ESB64.jsx + vendor-esb64.js + vendor-esb64-runtime.js + esb64-core.esm.mjs
npm test               # 411 Node assertions (WPT corpus + differential vs native + utf8)
npm run fuzz           # 140,000 differential fuzz checks vs V8 native + Buffer + TextDecoder
npm run live-verify    # 66-vector battery inside real Illustrator via the COM tool (agent-skills)
npm run benchmark      # Node-side benchmark pipeline + large-payload timing
```

Repository layout:

```
esb64/
  src/            TypeScript core (ES5 target, ES3-safe; tsc strict clean)
  tests/          Node harnesses (custom, no framework)
  probes/         live ExtendScript probes (capability, benchmark, big-payload)
  examples/       runnable ExtendScript examples (see "Runnable examples")
  dist/           generated bundles (gitignored; produced by npm run build)
```

---

## Security Model

- `btoa` is a pure byte transform — no eval, no native-code execution.
- `atob` is a pure byte transform — no eval, no native-code execution.
- The UTF-8 codec is a pure byte transform.
- The one native-kernel use (`unescape`/`encodeURIComponent`) is bounded: input is coerced with `String()`, output is the UTF-8 byte string, and lone surrogates (the only `encodeURIComponent` failure mode) fall back to the hand-rolled lane. The engine's escaping functions are not user-code-executable.
- The memo shares string results by reference. Strings are immutable in JS, so hits are safe to share (unlike ESON's parse memo, which clones on hit).
- The vendor installs `atob`/`btoa` as globals only when absent (`install({ forceReplace: true })` to override). A script that needs to guarantee its own codec can call the lanes directly via `ESB64.atob` / `ESB64.btoa`.

---

## Credits

ESB64 stands on the shoulders of the ExtendScript community:

- **[docsforadobe](https://github.com/docsforadobe) and the docsforadobe.dev community:** maintainers of the de-facto reference documentation for the ExtendScript runtime. Their reverse-engineering of the engine's object model, string semantics, and parser quirks made the measured findings in this README possible to write down at all. The `@Illustrator` [API reference](https://extendscript.docsforadobe.dev/) is the standard we benchmark "documented behavior" against.
- **[web-platform-tests](https://github.com/web-platform-tests/wpt):** the `base64.json` corpus (80 vectors) and the `atob` behavior tests, transcribed verbatim into this project's test suite.
- **Douglas Crockford / JSON-js:** the ExtendScript engineering patterns (ES3 shims, quadratic-concat avoidance, charCodeAt-based scanning) established by [ESON](https://github.com/thelabcorner/eson) carry over directly.

---

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) (ESB64 core).

---

<p align="center"><small>ESB64: ExtendScript Base64. Built for the engine, measured on the engine, byte-identical to the spec.</small></p>
