// Base64 alphabet and the decode lookup table.
//
// The decode table maps char codes 0..127 to 6-bit values (INVALID = -1).
// '=' (61) is intentionally NOT in the table; the atob lane tracks padding
// separately. All string scanning uses charCodeAt - the engine's charAt
// returns '' for U+0000 (NUL is treated as a terminator).
//
// ORDER MATTERS: DEC_TABLE is initialized at module load with buildDecTable(),
// so the constants it reads (INVALID) must be assigned BEFORE the table
// initializer runs (var hoisting would otherwise pass undefined).

export var INVALID = -1;
export var EQ = -2; // marker for '=' in the pre-decode value list
export var ALPHA_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export var DEC_TABLE: number[] = buildDecTable();

function buildDecTable(): number[] {
  var t: number[] = [];
  var i: number;
  for (i = 0; i < 128; i++) {
    t[i] = INVALID;
  }
  for (i = 0; i < 64; i++) {
    t[ALPHA_CHARS.charCodeAt(i)] = i;
  }
  return t;
}

// Single-char lookup for decoded bytes and codepoints: BYTE_CHARS[byte] ->
// 1-char string. Avoids per-byte String.fromCharCode calls and enables
// 1-push-per-char string emission (array writes are ~15-25 us each in this
// engine - the dominant cost, so pushes must be minimized).
export var BYTE_CHARS: string[] = buildByteChars();
function buildByteChars(): string[] {
  var t: string[] = [];
  var i: number;
  for (i = 0; i < 256; i++) {
    t[i] = String.fromCharCode(i);
  }
  return t;
}
