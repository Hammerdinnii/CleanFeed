import type { Signal } from '../../shared/types';
import { clamp } from '../../shared/util';
import type { TextProfile } from '../types';
import { words } from '../text';

/**
 * Detector: lightweight statistical text scoring (no model download).
 *
 * A hand-calibrated logistic model over stylometric features that separate
 * typical LLM output from casual human writing:
 *
 *   - burstiness: humans vary sentence length a lot; LLM prose is uniform
 *   - uniform sentence openings (many sentences starting the same way)
 *   - long average word length
 *   - triads ("X, Y, and Z") and rare informal punctuation
 *   - informal markers (slang, "lol", lowercase "i", "!!", typos-ish forms)
 *     count as *human* evidence and pull the score down
 *
 * It is deliberately weak: the combiner caps its contribution so it can only
 * corroborate other signals, never flag content alone. A score < 0.5 is
 * "human-leaning" and dampens the combined verdict.
 */
const INFORMAL = /\b(?:lol|lmao|lmfao|rofl|tbh|imo|imho|idk|ngl|smh|fr|bruh|omg|wtf|gonna|wanna|gotta|kinda|sorta|y'?all|ain'?t|dunno|u r|ur|pls|plz|thx|haha+|hehe+|yeah|nah|yep|nope)\b/gi;

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export interface StatFeatures {
  sentenceCv: number;
  meanSentence: number;
  avgWordLen: number;
  openerRepeat: number;
  triads: number;
  informal: number;
  lowerI: number;
  exclam: number;
  contractions: number;
}

export function statFeatures(p: TextProfile): StatFeatures {
  const lens = p.sentences.map((s) => words(s).length).filter((n) => n > 0);
  const m = mean(lens);
  const openers = p.sentences.map((s) => (words(s)[0] ?? '').toLowerCase()).filter(Boolean);
  const openerCounts = new Map<string, number>();
  for (const o of openers) openerCounts.set(o, (openerCounts.get(o) ?? 0) + 1);
  const maxOpener = Math.max(0, ...openerCounts.values());
  const per100 = 100 / Math.max(p.wordCount, 1);
  return {
    sentenceCv: m ? stdev(lens) / m : 0,
    meanSentence: m,
    avgWordLen: mean(p.words.map((w) => w.length)),
    openerRepeat: openers.length ? maxOpener / openers.length : 0,
    triads: (p.text.match(/\b\w+(?: \w+)?, \w+(?: \w+)?,? and \w+/g) ?? []).length * per100,
    informal: (p.text.match(INFORMAL) ?? []).length * per100,
    lowerI: (p.text.match(/(?:^|\s)i(?=\s|'m|'ve|'d|'ll)/g) ?? []).length * per100,
    exclam: (p.text.match(/[!?]{2,}/g) ?? []).length * per100,
    contractions: (p.text.match(/\b\w+'(?:t|re|ve|ll|d|m|s)\b/gi) ?? []).length * per100,
  };
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function textStatsScore(p: TextProfile): number | null {
  if (p.wordCount < 80 || p.sentences.length < 5) return null;
  const f = statFeatures(p);
  let z = -0.4;
  z += clamp((0.55 - f.sentenceCv) * 4.0, -1.6, 1.4); // uniform sentence lengths → AI
  z += clamp((f.avgWordLen - 4.6) * 1.1, -1.0, 1.0); // long words → AI
  z += clamp((f.openerRepeat - 0.25) * 2.0, -0.3, 0.8); // repetitive openings
  z += clamp(f.triads * 0.35, 0, 0.8);
  z += clamp((f.meanSentence - 12) * 0.05, -0.5, 0.5);
  z -= clamp(f.informal * 0.9, 0, 2.2); // slang → human
  z -= clamp(f.lowerI * 1.5, 0, 1.2);
  z -= clamp(f.exclam * 1.0, 0, 1.0);
  return sigmoid(z);
}

export function textStatsSignal(p: TextProfile): Signal | null {
  const s = textStatsScore(p);
  if (s === null) return null;
  return {
    detector: 'textStats',
    score: s,
    weight: 0.5,
    reason: s >= 0.5 ? 'Uniform, formal writing style' : 'Informal human writing style',
  };
}
