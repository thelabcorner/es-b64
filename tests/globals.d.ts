// Ambient declarations for the Node harness environment. The native atob/btoa
// (Node >= 16, WHATWG forgiving-base64), Buffer and TextDecoder are the
// differential oracles; the ESM core's own functions are imported under
// aliases in the test entries so the bare names resolve to the natives.

declare var atob: (s: string) => string;
declare var btoa: (s: string) => string;
declare var Buffer: any;
declare var TextDecoder: any;
declare var process: {
  exit(code?: number): void;
};
declare var ESB64_FUZZ_ARGS: string[]; // provisioned by tests/fuzz.mjs
