// ESB64 shared types.

export interface B64Capabilities {
  nativeAtob: boolean;
  nativeBtoa: boolean;
  atobClassification: string; // 'absent' | 'native-looking' | 'known ESB64' | 'unknown'
  btoaClassification: string;
  engine: {
    globalAtobPresent: boolean;
    globalBtoaPresent: boolean;
  };
  utf8: boolean;
  memo: {
    atob: MemoStats;
    btoa: MemoStats;
  };
}

export interface MemoStats {
  enabled: boolean;
  entries: number;
  maxEntryChars: number;
}

export interface InstallOptions {
  // When true, the global atob/btoa are replaced even when a (possibly
  // injected) implementation already exists. Default false: true polyfill
  // semantics - only fill the gap.
  forceReplace?: boolean;
}

export interface BenchItem {
  lane: string;
  payload: string;
  iterations: number;
  medianUs: number;
  minUs: number;
  p95Us: number;
  opsPerSec: number;
  outputBytes: number;
  vsNative: number; // native lane median / our lane median; 0 when no native
}
