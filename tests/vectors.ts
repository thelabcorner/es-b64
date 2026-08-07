// ESB64 test corpus. Encode/round-trip vectors with hardcoded expectations
// (RFC 4648 §10 + WHATWG edge cases), plus UTF-8 cases with WHATWG semantics
// (lone surrogates -> U+FFFD, malformed sequences -> U+FFFD).
export interface B64Vector {
  name: string;
  input: any;        // btoa / atob input
  expect?: string;   // expected output (encode lanes)
  throws?: boolean;  // encode lanes: expect InvalidCharacterError
}

export interface Utf8Vector {
  name: string;
  input?: string;
  b64?: string;      // expected encodeUtf8
  noRoundtrip?: boolean; // lone surrogates normalize to U+FFFD (TextEncoder semantics)
  noRoundtripExpect?: string; // the normalization result when noRoundtrip
  byteB64?: string;  // for decodeUtf8/utf8Decode tests: base64 of the byte string
  expect?: string;   // expected decoded string
  invalidSeq?: boolean; // malformed UTF-8; WHATWG expectation hardcoded (Node's ICU-backed TextDecoder diverges on error handling)
}

// RFC 4648 §10 test vectors.
export function makeB64Vectors(): B64Vector[] {
  return [
    { name: 'empty', input: '', expect: '' },
    { name: 'rfc4648-f', input: 'f', expect: 'Zg==' },
    { name: 'rfc4648-fo', input: 'fo', expect: 'Zm8=' },
    { name: 'rfc4648-foo', input: 'foo', expect: 'Zm9v' },
    { name: 'rfc4648-foob', input: 'foob', expect: 'Zm9vYg==' },
    { name: 'rfc4648-fooba', input: 'fooba', expect: 'Zm9vYmE=' },
    { name: 'rfc4648-foobar', input: 'foobar', expect: 'Zm9vYmFy' },
    { name: 'singleA', input: 'A', expect: 'QQ==' },
    { name: 'latin1max', input: '\u00ff', expect: '/w==' },
    { name: 'nul', input: '\u0000', expect: 'AA==' },
    { name: 'nulNul', input: '\u0000\u0000', expect: 'AAA=' },
    { name: 'controlTab', input: '\t', expect: 'CQ==' },
    { name: 'del', input: '\u007f', expect: 'fw==' },
    { name: 'twoBytes', input: '\u00e9\u0080', expect: '6YA=' },
    { name: 'longLatin1', input: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', throws: false },
    { name: 'nonLatin1', input: '\u0100', throws: true },
    { name: 'unicodeLoneSurrogate', input: '\ud800', throws: true },
    { name: 'unicodeEmoji', input: '\ud83d\ude00', throws: true },
    { name: 'nonStringCoerce', input: 123, expect: 'MTIz' },
    { name: 'nullCoerce', input: null, expect: 'bnVsbA==' },
    { name: 'falseCoerce', input: false, expect: 'ZmFsc2U=' }
  ];
}

export interface AtobVector {
  name: string;
  input: any;
  expect?: string;
  throws?: boolean;
}

// WHATWG forgiving-base64 decode cases.
export function makeAtobVectors(): AtobVector[] {
  return [
    { name: 'empty', input: '', expect: '' },
    { name: 'rfc4648-f', input: 'Zg==', expect: 'f' },
    { name: 'rfc4648-fo', input: 'Zm8=', expect: 'fo' },
    { name: 'rfc4648-foo', input: 'Zm9v', expect: 'foo' },
    { name: 'rfc4648-foob', input: 'Zm9vYg==', expect: 'foob' },
    { name: 'rfc4648-fooba', input: 'Zm9vYmE=', expect: 'fooba' },
    { name: 'rfc4648-foobar', input: 'Zm9vYmFy', expect: 'foobar' },
    { name: 'missingPadding2', input: 'Zg', expect: 'f' },
    { name: 'missingPadding1', input: 'Zm8', expect: 'fo' },
    { name: 'missingPadding0', input: 'Zm9v', expect: 'foo' },
    { name: 'whitespaceSpace', input: 'Z m 8 =', expect: 'fo' },
    { name: 'whitespaceTabs', input: '\tZ\r\nm8\n=', expect: 'fo' },
    { name: 'whitespaceFormFeed', input: '\fZm8=\f', expect: 'fo' },
    { name: 'leadingWs', input: ' \nZm9v', expect: 'foo' },
    { name: 'internalPadding', input: 'Zg=A', throws: true },
    { name: 'triplePadding', input: 'A===', throws: true },
    { name: 'quadPadding', input: '====', throws: true },
    { name: 'singleEq', input: '=', throws: true },
    { name: 'eqThenData', input: '=AA', throws: true },
    { name: 'lengthOne', input: 'A', throws: true },
    { name: 'lengthFive', input: 'Zm9vY', throws: true },
    { name: 'invalidCharBang', input: 'Zm9v!', throws: true },
    { name: 'invalidCharDash', input: '-', throws: true },
    { name: 'invalidCharUnderscore', input: 'Zm9v_' , throws: true },
    { name: 'invalidCharHigh', input: '\u00e9', throws: true },
    { name: 'invalidCharNul', input: '\u0000', throws: true },
    { name: 'trailingEqData', input: 'AB==CD', throws: true },
    { name: 'nulDecode', input: 'AA==', expect: '\u0000' },
    { name: 'latin1Decode', input: '/w==', expect: '\u00ff' },
    { name: 'nulMid', input: 'AIAB', expect: '\u0000\u0080\u0001' },
    { name: 'nonStringCoerce', input: 5, throws: true },
    { name: 'underscoreReject', input: 'Zm9vYg', expect: 'foob' },
    // long padding runs (way beyond the WPT corpus's max of 5)
    { name: 'padRun1000', input: 'a' + new Array(1001).join('='), throws: true },
    { name: 'padRun1000ab', input: 'ab' + new Array(1001).join('='), throws: true },
    { name: 'padRun1000abcd', input: 'abcd' + new Array(1001).join('='), throws: true },
    { name: 'padRunMixedWs', input: 'Zg=' + new Array(100).join(' ='), throws: true },
    { name: 'delRejected', input: '\u007f', throws: true }
  ];
}

// UTF-8 lanes.
export function makeUtf8Vectors(): Utf8Vector[] {
  return [
    { name: 'empty', input: '', b64: '' },
    { name: 'ascii', input: 'hello', b64: 'aGVsbG8=' },
    { name: 'accent', input: '\u00e9', b64: 'w6k=' },
    { name: 'greek', input: '\u03c0', b64: 'z4A=' },
    { name: 'cjk', input: '\u65e5\u672c\u8a9e', b64: '5pel5pys6Kqe' },
    { name: 'emoji', input: '\ud83d\ude00', b64: '8J+YgA==' },
    { name: 'maxBmp', input: '\uffff', b64: '77+/' },
    { name: 'boundary7F', input: '\u007f', b64: 'fw==' },
    { name: 'boundary80', input: '\u0080', b64: 'woA=' },
    { name: 'boundary7FF', input: '\u07ff', b64: '378=' },
    { name: 'boundary800', input: '\u0800', b64: '4KCA' },
    { name: 'loneHighSurrogate', input: '\ud800', b64: '77+9', noRoundtrip: true, noRoundtripExpect: '\ufffd' },
    { name: 'loneLowSurrogate', input: '\udc00', b64: '77+9', noRoundtrip: true, noRoundtripExpect: '\ufffd' },
    { name: 'surrogatePlusChar', input: '\ud800a', b64: '77+9YQ==', noRoundtrip: true, noRoundtripExpect: '\ufffda' },
    { name: 'mixed', input: 'dieline \u00e9 \ud83d\ude00 \u65e5\u672c\u8a9e', b64: '' },
    // decode lanes
    { name: 'decodeAscii', byteB64: 'aGVsbG8=', expect: 'hello' },
    { name: 'decodeAccent', byteB64: 'w6k=', expect: '\u00e9' },
    { name: 'decodeEmoji', byteB64: '8J+YgA==', expect: '\ud83d\ude00' },
    { name: 'decodeReplacement', byteB64: '77+9', expect: '\ufffd' },
    { name: 'decodeTruncated4', byteB64: '8J+Y', expect: '\ufffd', invalidSeq: true },
    { name: 'decodeTruncated3', byteB64: 'w6', expect: '\ufffd', invalidSeq: true },
    { name: 'decodeOverlongC1', byteB64: 'wYE=', expect: '\ufffd\ufffd', invalidSeq: true },
    { name: 'decodeOverlongE0', byteB64: '4ICA', expect: '\ufffd\ufffd', invalidSeq: true },
    { name: 'decodeSurrogateEncoded', byteB64: '7aCA', expect: '\ufffd\ufffd', invalidSeq: true },
    { name: 'decodeOutOfRangeF4', byteB64: '9JCA', expect: '\ufffd\ufffd', invalidSeq: true },
    { name: 'decodeBadContinuation', byteB64: 'w5Av', expect: '\u00d0/', invalidSeq: true },
    { name: 'decodeStrayContinuation', byteB64: 'gA==', expect: '\ufffd', invalidSeq: true },
    { name: 'decodeNul', byteB64: 'AAA=', expect: '\u0000\u0000' },
    { name: 'decodeMaxBmp', byteB64: '77+/', expect: '\uffff' },
    { name: 'bomRoundtrip', input: '\ufeffabc', b64: '77u/YWJj' },
    { name: 'bomOnly', input: '\ufeff', b64: '77u/' },
    // astral boundaries (WHATWG: U+10000 and U+10FFFF, valid)
    { name: 'astralMin', input: '\ud800\udc00', b64: '8JCAgA==' },
    { name: 'astralMax', input: '\udbff\udfff', b64: '9I+/vw==' },
    { name: 'decodeMaxCodepoint', byteB64: '9I+/vw==', expect: '\udbff\udfff', invalidSeq: false },
    // WHATWG systematic malformed-sequence table (expectations per the
    // encoding spec; Node's ICU-backed TextDecoder diverges, hence hardcoded)
    { name: 'decOverlongNul', byteB64: 'wIA=', expect: '\ufffd\ufffd', invalidSeq: true },                  // C0 80
    { name: 'decOverlong4byte', byteB64: '8ICAgA==', expect: '\ufffd\ufffd\ufffd', invalidSeq: true },     // F0 80 80 80
    { name: 'decE0LowerBound', byteB64: '4J+/', expect: '\ufffd\ufffd', invalidSeq: true },                // E0 9F BF (9F < A0)
    { name: 'decEDUpperBound', byteB64: '7b+/', expect: '\ufffd\ufffd', invalidSeq: true },                // ED BF BF (BF > 9F)
    { name: 'decF5Start', byteB64: '9YCAgA==', expect: '\ufffd\ufffd\ufffd\ufffd', invalidSeq: true },     // F5 80 80 80
    { name: 'decFFStart', byteB64: '//4=', expect: '\ufffd\ufffd', invalidSeq: true },                     // FF FE
    { name: 'decTruncated4', byteB64: '8ICA', expect: '\ufffd\ufffd', invalidSeq: true },                  // F0 80 80 (truncated 4-byte)
    // (padding-run vectors live in makeAtobVectors - they are atob inputs)
  ];
}

export function makeMixedPayload(): string {
  return 'dieline export \u00e9\u00e8 \u65e5\u672c\u8a9e \ud83d\ude00 \u03c0 100% \u0000\u007f\u00ff';
}
