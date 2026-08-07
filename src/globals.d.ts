// Ambient declarations for host globals not present in lib.es5.
// All are runtime-guarded before use; declarations exist only for typechecking.

declare var performance: {
  now(): number;
};
declare var console: {
  log(...args: any[]): void;
  error(...args: any[]): void;
};
declare var $: {
  hiresTimer: number;
  global: any;
};
