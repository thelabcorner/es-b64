// Runtime-only ESB64 entry: atob + btoa (with their memos). Everything else
// (utf8 codec, caps, install, benchmark) is pruned by the bundler's
// tree-shaking. Used for per-eval injection: a small vendor instead of the
// full one cuts the per-invocation compile.
import { btoaLane } from './encode';
import { atobLane } from './decode';

export function btoa(text: any): string {
  return btoaLane(text);
}

export function atob(text: any): string {
  return atobLane(text);
}
