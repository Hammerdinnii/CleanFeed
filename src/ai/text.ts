import type { TextProfile } from './types';

/**
 * Text extraction & tokenization. Extraction walks the DOM instead of using
 * `innerText`, which would force a synchronous layout on every call.
 */
const BLOCK = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'SECTION',
  'ARTICLE', 'TR', 'TABLE', 'HEADER', 'FOOTER', 'FIGCAPTION',
]);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'BUTTON', 'TEXTAREA', 'INPUT', 'SELECT']);

export function extractText(root: Element | null | undefined, maxChars = 8000): string {
  if (!root) return '';
  let out = '';
  const walk = (node: Node) => {
    if (out.length >= maxChars) return;
    if (node.nodeType === 3) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName;
    if (SKIP.has(tag) || el.hasAttribute('data-cleanfeed-ui') || el.tagName.toLowerCase() === 'cleanfeed-bar') return;
    if (tag === 'BR') {
      out += '\n';
      return;
    }
    if (tag === 'IMG') {
      // Emoji are often <img alt="🚀">; keep them, they matter for formatting tells.
      const alt = el.getAttribute('alt');
      if (alt && alt.length <= 4) out += alt;
      return;
    }
    const block = BLOCK.has(tag);
    if (block && out && !out.endsWith('\n')) out += '\n';
    for (let c = el.firstChild; c; c = c.nextSibling) walk(c);
    if (block && !out.endsWith('\n')) out += '\n';
  };
  walk(root);
  return normalizeText(out).slice(0, maxChars);
}

export function normalizeText(s: string): string {
  return s
    .replace(/ /g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

export function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

/** Splits into sentences, keeping abbreviations like "e.g." mostly intact. */
export function sentences(text: string): string[] {
  const parts = text
    .replace(/\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|jr|sr|inc|ltd|u\.s)\./gi, (m) => m.replace(/\./g, '․'))
    .split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}"'“‘(\[])|\n+/u)
    .map((s) => s.replace(/․/g, '.').trim())
    .filter((s) => words(s).length > 0);
  return parts;
}

export function paragraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function profileText(text: string): TextProfile {
  const w = words(text);
  return { text, words: w, wordCount: w.length, sentences: sentences(text), paragraphs: paragraphs(text) };
}
