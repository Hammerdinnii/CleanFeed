import type { Signal, TextPatternDef } from '../../shared/types';
import { clamp } from '../../shared/util';
import { DEFAULT_PATTERNS } from '../patterns/default-patterns';
import type { TextProfile } from '../types';

/**
 * Detector: phrase & pattern matching for common AI writing tells, plus two
 * structural features (em-dash density, "staccato" one-line paragraphs).
 *
 * Scoring (tuned for low false positives):
 *   evidence = Σ weight · diminishing(hits)      per pattern, capped by maxHits
 *            + structural evidence
 *   evidence is normalized sub-linearly by length (longer texts naturally
 *   contain more incidental hits) and damped for short texts;
 *   score = 1 − exp(−evidence / 2.8)
 *
 * "Strong" patterns (chatbot boilerplate, leftover citation markers) yield a
 * high score on their own.
 */
export interface CompiledPattern {
  def: TextPatternDef;
  re: RegExp;
}

/** Merges user overrides (same id) and custom patterns onto the defaults. */
export function resolvePatterns(user: TextPatternDef[] | null | undefined): TextPatternDef[] {
  if (!user || !user.length) return DEFAULT_PATTERNS;
  const byId = new Map(DEFAULT_PATTERNS.map((p) => [p.id, p]));
  for (const p of user) byId.set(p.id, { ...byId.get(p.id), ...p });
  return [...byId.values()];
}

export function compilePatterns(defs: readonly TextPatternDef[]): CompiledPattern[] {
  const out: CompiledPattern[] = [];
  for (const def of defs) {
    if (def.enabled === false || !(def.weight > 0)) continue;
    try {
      const flags = new Set(['g', 'i', 'm', 'u', ...(def.flags ?? '').split('')]);
      flags.delete('y');
      out.push({ def, re: new RegExp(def.pattern, [...flags].join('')) });
    } catch {
      /* invalid user pattern: skipped (the options page validates on save) */
    }
  }
  return out;
}

function countHits(re: RegExp, text: string, cap: number): number {
  re.lastIndex = 0;
  let n = 0;
  while (n < cap) {
    const m = re.exec(text);
    if (!m) break;
    n++;
    if (m[0].length === 0) re.lastIndex++;
  }
  return n;
}

/** Sum of a geometric series: 1 + 0.6 + 0.36 + … for n hits. */
function diminishing(n: number): number {
  return (1 - Math.pow(0.6, n)) / 0.4;
}

export interface PatternResult {
  evidence: number;
  strongHit: TextPatternDef | null;
  hits: { def: TextPatternDef; n: number; contribution: number }[];
  emDashDensity: number;
  staccato: boolean;
}

export function analyzePatterns(profile: TextProfile, patterns: readonly CompiledPattern[], minWords: number): PatternResult {
  const { text, wordCount } = profile;
  const hits: PatternResult['hits'] = [];
  let raw = 0;
  let strongHit: TextPatternDef | null = null;

  for (const p of patterns) {
    const n = countHits(p.re, text, p.def.maxHits ?? 5);
    if (!n) continue;
    const contribution = p.def.weight * diminishing(n);
    hits.push({ def: p.def, n, contribution });
    if (p.def.strong) {
      if (!strongHit || p.def.weight > strongHit.weight) strongHit = p.def;
    } else raw += contribution;
  }

  // Em-dash density (per 100 words). Spaced en dashes and "--" are common substitutes.
  const dashes = (text.match(/—|\s–\s|\s--\s/g) ?? []).length;
  const emDashDensity = wordCount ? (dashes / wordCount) * 100 : 0;
  if (wordCount >= 40 && dashes >= 2) raw += clamp((emDashDensity - 0.8) * 1.1, 0, 2.4);

  // Staccato formatting: many very short one-line paragraphs (common in AI-written social posts).
  const paras = profile.paragraphs;
  let staccato = false;
  if (paras.length >= 6 && wordCount >= 50) {
    const short = paras.filter((p) => p.split(/\s+/).length <= 12).length / paras.length;
    const avg = wordCount / paras.length;
    if (short >= 0.7 && avg <= 13) {
      staccato = true;
      raw += 1.1;
    }
  }

  // Length normalization: sub-linear above 60 words, damped below `minWords`.
  let evidence = raw / Math.sqrt(Math.max(wordCount, 60) / 60);
  if (wordCount < minWords) evidence *= clamp(wordCount / minWords, 0.25, 1);
  return { evidence, strongHit, hits, emDashDensity, staccato };
}

export function textPatternSignal(profile: TextProfile, patterns: readonly CompiledPattern[], minWords: number): Signal | null {
  if (profile.wordCount < 6) return null;
  const r = analyzePatterns(profile, patterns, minWords);
  const top = [...r.hits].filter((h) => !h.def.strong).sort((a, b) => b.contribution - a.contribution).slice(0, 3);
  const detailParts = top.map((h) => h.def.description);
  if (r.staccato) detailParts.push('one-line paragraphs');
  if (r.emDashDensity > 1.5 && profile.wordCount >= 40) detailParts.push('heavy em-dash use');

  if (r.strongHit) {
    return {
      detector: 'textPatterns',
      score: 0.94,
      weight: 0.95,
      reason: 'AI chatbot text',
      detail: r.strongHit.description,
    };
  }
  if (r.evidence <= 0.5) return null;
  const score = 1 - Math.exp(-r.evidence / 2.8);
  return {
    detector: 'textPatterns',
    score,
    weight: 0.88,
    reason: 'AI writing patterns',
    detail: detailParts.join(', '),
  };
}
