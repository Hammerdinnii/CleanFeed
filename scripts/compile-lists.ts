/**
 * Build-time filter-list compilation (bundled by build.mjs and run under Node).
 *
 * For every bundled subscription with a source available, emits:
 *   rules/<id>.json         static DNR ruleset (declared in the manifest)
 *   rules/<id>.hashes.json  per-rule content hashes, used at runtime to compute
 *                           small deltas when the list auto-updates
 *   lists/<id>.json         cosmetic + popup data, list header and stats
 *
 * Sources: filters/<id>.txt (shipped with the repo) or filters/cache/<id>.txt
 * (downloaded by `npm run fetch-lists`). Lists without a source are simply
 * not bundled; the extension downloads them on first run instead.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileFilterText, materializeRules, ruleHash } from '../src/adblock/compiler';
import { ALLOW_ID_OFFSET, RULESET_PREFIX } from '../src/adblock/constants';
import { defaultEnv } from '../src/adblock/preprocess';
import { DEFAULT_SUBSCRIPTIONS } from '../src/adblock/registry';
import type { DnrRule } from '../src/adblock/types';

export interface BundledListInfo {
  id: string;
  rulesetId: string;
  enabled: boolean;
  rules: number;
  regex: number;
  source: 'repo' | 'cache';
  sourceHash: string;
}

/** Per-ruleset regex cap enforced by Chrome/Firefox for static rulesets. */
const MAX_REGEX_PER_RULESET = 1000;
/** Safety margin below the global static guarantee (30k enabled rules on Chrome). */
const MAX_RULES_PER_RULESET = 300_000;

export function compileBundledLists(opts: {
  target: 'chrome' | 'firefox';
  rootDir: string;
  outDir: string;
  log?: (msg: string) => void;
}): BundledListInfo[] {
  const log = opts.log ?? (() => {});
  const env = defaultEnv(opts.target);
  const rulesDir = join(opts.outDir, 'rules');
  const listsDir = join(opts.outDir, 'lists');
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(listsDir, { recursive: true });
  const out: BundledListInfo[] = [];

  for (const sub of DEFAULT_SUBSCRIPTIONS) {
    if (!sub.bundled) continue;
    const repoPath = join(opts.rootDir, 'filters', `${sub.id}.txt`);
    const cachePath = join(opts.rootDir, 'filters', 'cache', `${sub.id}.txt`);
    const source = existsSync(repoPath) ? 'repo' : existsSync(cachePath) ? 'cache' : null;
    if (!source) continue;
    const text = readFileSync(source === 'repo' ? repoPath : cachePath, 'utf8');
    const sourceHash = createHash('sha256').update(text).digest('hex').slice(0, 16);
    const t0 = Date.now();
    const compiled = compileFilterText(text, { id: sub.id, env });

    // Enforce static ruleset limits; excess regex rules are dropped (they are the least efficient anyway).
    let regexCount = 0;
    const bodies = compiled.rules.filter((r) => {
      if (!r.condition.regexFilter) return true;
      regexCount++;
      return regexCount <= MAX_REGEX_PER_RULESET;
    });
    if (bodies.length > MAX_RULES_PER_RULESET) bodies.length = MAX_RULES_PER_RULESET;

    const rules: DnrRule[] = materializeRules(bodies, 0);
    const hashes = { b: [] as string[], a: [] as string[] };
    for (const r of rules) {
      const h = ruleHash(r);
      if (r.id > ALLOW_ID_OFFSET) hashes.a[r.id - ALLOW_ID_OFFSET - 1] = h;
      else hashes.b[r.id - 1] = h;
    }
    writeFileSync(join(rulesDir, `${sub.id}.json`), JSON.stringify(rules));
    writeFileSync(join(rulesDir, `${sub.id}.hashes.json`), JSON.stringify(hashes));
    writeFileSync(
      join(listsDir, `${sub.id}.json`),
      JSON.stringify({
        id: sub.id,
        header: compiled.header,
        cosmetic: compiled.cosmetic,
        popup: compiled.popup,
        stats: { ...compiled.stats, dnrRules: rules.length },
        sourceHash,
        compiledAt: Date.now(),
      }),
    );
    out.push({
      id: sub.id,
      rulesetId: RULESET_PREFIX + sub.id,
      enabled: sub.enabled,
      rules: rules.length,
      regex: Math.min(regexCount, MAX_REGEX_PER_RULESET),
      source,
      sourceHash,
    });
    log(
      `  list ${sub.id.padEnd(18)} ${String(rules.length).padStart(6)} DNR rules, ` +
        `${compiled.stats.cosmeticFilters} cosmetic, ${compiled.stats.scriptletFilters} scriptlets ` +
        `(${source}, ${Date.now() - t0} ms)`,
    );
  }
  writeFileSync(join(listsDir, 'index.json'), JSON.stringify(out));
  return out;
}
