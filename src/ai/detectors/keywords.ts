import { hostMatchesAny } from '../../shared/domain';
import type { KeywordRule, Signal } from '../../shared/types';
import { toMatcher } from '../../shared/util';
import type { ItemInfo } from '../types';

/**
 * Detector: the user's own keyword / phrase rules. A rule can feed the AI
 * score ('ai'), hide matching items as unwanted ('ads'), or both.
 * Plain text matches whole words case-insensitively; `/regex/flags` is
 * supported for power users.
 */
export interface CompiledKeyword {
  rule: KeywordRule;
  re: RegExp;
}

export function compileKeywords(rules: readonly KeywordRule[]): CompiledKeyword[] {
  const out: CompiledKeyword[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const re = toMatcher(rule.pattern, { wholeWord: true });
    if (re) out.push({ rule, re });
  }
  return out;
}

export function keywordSignals(item: ItemInfo, compiled: readonly CompiledKeyword[], hostname: string): Signal[] {
  if (!compiled.length) return [];
  const haystack = [item.title ?? '', item.text, item.author?.handle ?? '', item.author?.name ?? '', item.url ?? ''].join('\n');
  const out: Signal[] = [];
  let ai = false;
  let unwanted = false;
  for (const { rule, re } of compiled) {
    if (rule.sites?.length && !hostMatchesAny(hostname, rule.sites)) continue;
    if (!re.test(haystack)) continue;
    if ((rule.target === 'ai' || rule.target === 'both') && !ai) {
      ai = true;
      out.push({ detector: 'keywords', score: 0.9, weight: 0.85, reason: 'Keyword rule', detail: `“${rule.pattern}”`, category: 'ai' });
    }
    if ((rule.target === 'ads' || rule.target === 'both') && !unwanted) {
      unwanted = true;
      out.push({
        detector: 'keywords',
        score: 1,
        weight: 1,
        reason: 'Matches your keyword rule',
        detail: `“${rule.pattern}”`,
        definitive: true,
        category: 'unwanted',
      });
    }
    if (ai && unwanted) break;
  }
  return out;
}
