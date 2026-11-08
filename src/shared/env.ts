/**
 * Build-time constants injected by esbuild (`define`). The `typeof` guards keep
 * these modules importable from unit tests, which run without the bundler.
 */
declare const __TARGET__: 'chrome' | 'firefox';
declare const __DEV__: boolean;
declare const __VERSION__: string;
declare const __HAS_ONNX__: boolean;

export type BrowserTarget = 'chrome' | 'firefox';

export const TARGET: BrowserTarget = typeof __TARGET__ !== 'undefined' ? __TARGET__ : 'chrome';
export const IS_FIREFOX = TARGET === 'firefox';
export const IS_CHROME = TARGET === 'chrome';
export const DEV: boolean = typeof __DEV__ !== 'undefined' ? __DEV__ : true;
export const VERSION: string = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0-test';
/** False when the extension was built with `--no-onnx` (lean build without ONNX Runtime). */
export const HAS_ONNX: boolean = typeof __HAS_ONNX__ !== 'undefined' ? __HAS_ONNX__ : true;
