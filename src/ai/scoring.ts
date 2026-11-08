import { SENSITIVITY_THRESHOLDS } from '../shared/settings';
import type { ImageAnalysis, Sensitivity, Signal, Verdict } from '../shared/types';
import { clamp } from '../shared/util';

/**
 * Combines detector signals into one verdict.
 *
 * Model: noisy-OR over positive evidence, where each signal contributes
 * `weight × score`; then multiplicative damping by human-leaning evidence.
 *
 *   p = (1 − Π(1 − wᵢ·sᵢ)) × (1 − damping)
 *
 * Guard rails for low false positives:
 *   - definitive signals (platform labels, blocklists, C2PA AI source) set
 *     p ≥ 0.97 and are never damped;
 *   - weak detectors (text statistics) are capped below every threshold, so
 *     they can corroborate but never flag on their own;
 *   - human-leaning statistics and camera provenance reduce the score.
 */
const WEAK_CAP: Partial<Record<Signal['detector'], number>> = {
  textStats: 0.4,
};

export interface Contribution {
  signal: Signal;
  value: number;
}

export function combineSignals(signals: readonly Signal[], sensitivity: Sensitivity): Verdict {
  const threshold = SENSITIVITY_THRESHOLDS[sensitivity];
  const unwanted = signals.find((s) => s.category === 'unwanted');
  if (unwanted) {
    return { score: 1, flagged: true, signals: [...signals], reason: unwanted.reason, category: 'unwanted' };
  }
  let notAi = 1;
  let damping = 0;
  let definitive: Signal | null = null;
  const contributions: Contribution[] = [];
  for (const s of signals) {
    if (s.definitive && (!definitive || s.weight > definitive.weight)) definitive = s;
    if (s.score < 0.5) {
      // Human-leaning evidence.
      damping = Math.max(damping, clamp((0.5 - s.score) * 0.8 * s.weight, 0, 0.4));
      continue;
    }
    let c = clamp(s.weight * s.score, 0, 1);
    const cap = WEAK_CAP[s.detector];
    if (cap !== undefined) c = Math.min(c, cap);
    contributions.push({ signal: s, value: c });
    notAi *= 1 - c;
  }
  let p = 1 - notAi;
  if (definitive) p = Math.max(p, 0.97);
  else p *= 1 - damping;
  contributions.sort((a, b) => b.value - a.value);
  const top = definitive ?? contributions[0]?.signal;
  return {
    score: p,
    flagged: p >= threshold,
    signals: [...signals],
    reason: top?.reason ?? '',
    category: 'ai',
  };
}

/** Maps a raw model probability so the user's threshold lands just above "balanced". */
export function calibrateModelScore(raw: number, threshold: number): number {
  const t = clamp(threshold, 0.5, 0.99);
  if (raw >= t) return 0.86 + ((raw - t) / (1 - t)) * 0.14;
  return 0.86 * Math.pow(raw / t, 2);
}

/** Converts an image analysis result into signals. */
export function imageSignals(a: ImageAnalysis, modelThreshold: number): Signal[] {
  const out: Signal[] = [];
  const md = a.metadata;
  if (md) {
    if (md.verdict === 'ai') {
      out.push({
        detector: 'metadata',
        score: 0.99,
        weight: 1,
        reason: 'Metadata',
        detail: md.evidence[0] ?? md.generator ?? 'AI generator tag',
        definitive: true,
      });
    } else if (md.verdict === 'edited-with-ai') {
      out.push({ detector: 'metadata', score: 0.8, weight: 0.85, reason: 'Metadata: AI-edited', detail: md.evidence[0] });
    } else if (md.verdict === 'camera') {
      out.push({ detector: 'metadata', score: 0.1, weight: 0.7, reason: 'Camera provenance', detail: md.evidence[0] });
    }
  }
  if (a.model && Number.isFinite(a.model.score)) {
    const s = calibrateModelScore(a.model.score, modelThreshold);
    if (s >= 0.5) {
      out.push({
        detector: 'imageModel',
        score: s,
        weight: 0.9,
        reason: `Image confidence ${Math.round(a.model.score * 100)}%`,
        detail: `local model (${a.model.backend})`,
      });
    }
  }
  return out;
}

/** Short human-readable explanation for badges/bars. */
export function describeVerdict(v: Verdict): string {
  const pct = Math.round(v.score * 100);
  if (v.category === 'unwanted') return v.reason;
  const extra = v.signals.filter((s) => s.score >= 0.5).length - 1;
  return `${v.reason}${extra > 0 ? ` +${extra}` : ''} · ${pct}%`;
}
