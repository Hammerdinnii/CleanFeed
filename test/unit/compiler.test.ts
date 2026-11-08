import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileFilterText, materializeRules, mergeAndDedupe, ruleHash } from '../../src/adblock/compiler';
import { defaultEnv, evaluateCondition, parseHeader, preprocess } from '../../src/adblock/preprocess';
import { abpPatternToRegExp, convertNetworkFilter, parseNetworkFilter } from '../../src/adblock/network';
import { genericToken, parseCosmeticFilter } from '../../src/adblock/cosmetic';
import { PRIORITY, isAllowRuleId } from '../../src/adblock/constants';

const env = defaultEnv('chrome');
const compile = (text: string, offset = 0) =>
  compileFilterText(text, { id: 't', env, priorityOffset: offset, collectIssues: true });

test('hostname filters merge into requestDomains', () => {
  const c = compile('||ads.example.com^\n||tracker.net^\n||cdn.ads.example.com^\nads2.example.org');
  assert.equal(c.rules.length, 1);
  const r = c.rules[0]!;
  assert.equal(r.action.type, 'block');
  assert.deepEqual(r.condition.requestDomains, ['ads.example.com', 'ads2.example.org', 'tracker.net']);
  assert.equal(r.priority, PRIORITY.block);
});

test('options map to DNR conditions', () => {
  const c = compile('||example.com/ads/*$script,third-party,domain=foo.com|~bar.foo.com');
  assert.equal(c.rules.length, 1);
  const cond = c.rules[0]!.condition;
  assert.equal(cond.urlFilter, '||example.com/ads/');
  assert.deepEqual(cond.resourceTypes, ['script']);
  assert.equal(cond.domainType, 'thirdParty');
  assert.deepEqual(cond.initiatorDomains, ['foo.com']);
  assert.deepEqual(cond.excludedInitiatorDomains, ['bar.foo.com']);
});

test('exceptions, important and $document', () => {
  const c = compile('@@||good.com^$document\n||bad.com^$important\n@@||cdn.com/lib.js$script');
  const types = c.rules.map((r) => [r.action.type, r.priority]);
  assert.deepEqual(
    types.sort(),
    [
      ['allow', PRIORITY.allow],
      ['allowAllRequests', PRIORITY.allow],
      ['block', PRIORITY.important],
    ].sort(),
  );
  const aar = c.rules.find((r) => r.action.type === 'allowAllRequests')!;
  assert.deepEqual(aar.condition.resourceTypes, ['main_frame', 'sub_frame']);
});

test('user filters get priority offset', () => {
  const c = compile('||x.com^', PRIORITY.userOffset);
  assert.equal(c.rules[0]!.priority, PRIORITY.block + PRIORITY.userOffset);
});

test('redirect, removeparam and csp', () => {
  const c = compile(
    '||google-analytics.com/analytics.js$script,redirect=google-analytics_analytics.js\n' +
      '$removeparam=utm_source\n' +
      '||example.com^$csp=script-src none',
  );
  const redirect = c.rules.find((r) => r.action.redirect?.extensionPath)!;
  assert.equal(redirect.action.redirect!.extensionPath, '/redirects/google-analytics_analytics.js');
  assert.equal(redirect.priority, PRIORITY.redirect);
  const rp = c.rules.find((r) => r.action.redirect?.transform)!;
  assert.deepEqual(rp.action.redirect!.transform!.queryTransform!.removeParams, ['utm_source']);
  assert.ok(rp.condition.resourceTypes!.includes('main_frame'));
  const csp = c.rules.find((r) => r.action.type === 'modifyHeaders')!;
  assert.equal(csp.action.responseHeaders![0]!.value, 'script-src none');
});

test('badfilter cancels the matching filter', () => {
  const c = compile('||foo.com^$script\n||foo.com^$script,badfilter\n||bar.com^');
  assert.equal(c.rules.length, 1);
  assert.deepEqual(c.rules[0]!.condition.requestDomains, ['bar.com']);
});

test('unsupported options drop the filter instead of broadening it', () => {
  const c = compile('||foo.com^$header=x-ads\n||foo.com^$webrtc\n$script');
  assert.equal(c.rules.filter((r) => r.condition.requestDomains?.includes('foo.com')).length, 0);
  assert.ok(c.stats.unsupported >= 2);
});

test('filters matching every request are rejected', () => {
  const c = compile('*\n@@*');
  assert.equal(c.rules.length, 0);
});

test('regex filters: RE2-compatible kept, lookaround dropped', () => {
  const c = compile('/^https?:\\/\\/[a-z]+\\.ads\\./$script\n/foo(?=bar)/');
  assert.equal(c.rules.length, 1);
  assert.equal(c.rules[0]!.condition.regexFilter, '^https?:\\/\\/[a-z]+\\.ads\\.');
});

test('hosts-file syntax', () => {
  const c = compile('0.0.0.0 ads.tracker.io\n127.0.0.1 localhost\n# comment');
  assert.equal(c.rules.length, 1);
  assert.deepEqual(c.rules[0]!.condition.requestDomains, ['ads.tracker.io']);
});

test('popup filters go to popup data', () => {
  const c = compile('||popads.net^$popup\n@@||good.com^$popup\n||bothways.com^$popup,script');
  assert.equal(c.popup.block.length, 2);
  assert.equal(c.popup.allow.length, 1);
  assert.equal(c.rules.length, 1);
});

test('cosmetic filters compile into generic/specific buckets', () => {
  const c = compile(
    [
      '##.ad-banner',
      '###sponsored',
      'example.com##.promo',
      'example.com,~sub.example.com##.x',
      'example.com#@#.ad-banner',
      '#@#.legit-ad',
      'example.com##.post:has-text(/sponsored/i)',
      'example.com##.box:style(display: none !important)',
      'example.com##+js(set-constant, foo, false)',
      'example.com#@#+js()',
      '~other.com##.cookie',
      'google.*##.ads',
      'example.com##body:style(background: url(http://evil))',
    ].join('\n'),
  );
  assert.deepEqual(c.cosmetic.generic, ['.ad-banner', '#sponsored']);
  assert.deepEqual(c.cosmetic.genericExceptions, ['.legit-ad']);
  assert.deepEqual(c.cosmetic.genericNot, [{ s: '.cookie', not: ['other.com'] }]);
  const kinds = c.cosmetic.specific.map((r) => r.e.t);
  assert.deepEqual(kinds, ['hide', 'hide', 'unhide', 'proc', 'style', 'js', 'unjs', 'hide']);
  const neg = c.cosmetic.specific[1]!;
  assert.deepEqual(neg.n, ['sub.example.com']);
  const ent = c.cosmetic.specific[7]!;
  assert.deepEqual(ent.d, ['google.*']);
  // url() inside :style is refused for privacy
  assert.ok(c.issues!.some((i) => /unsafe/.test(i.message)));
});

test('generic procedural filters are refused', () => {
  const r = parseCosmeticFilter('##div:has-text(Ad)');
  assert.equal(r.ok, false);
});

test('network filter with # in URL is not cosmetic', () => {
  const c = compile('||example.com/#ads');
  assert.equal(c.rules.length, 1);
  assert.equal(c.rules[0]!.condition.urlFilter, '||example.com/#ads');
});

test('generic token extraction', () => {
  assert.equal(genericToken('.ad-banner'), '.ad-banner');
  assert.equal(genericToken('#ad_box > div'), '#ad_box');
  assert.equal(genericToken('div.ad'), null);
  assert.equal(genericToken('[id^="ad-"]'), null);
  assert.equal(genericToken('.a, .b'), null);
});

test('preprocessor !#if / !#else', () => {
  const text = '!#if env_firefox\nff-only.com\n!#else\nnot-ff.com\n!#endif\n!#if !ext_ubol\nnever.com\n!#endif\n!#include sub.txt';
  const r = preprocess(text, env);
  assert.deepEqual(r.lines, ['not-ff.com']);
  assert.deepEqual(r.includes, [{ path: 'sub.txt', at: 1 }]);
  assert.equal(evaluateCondition('env_chromium && (cap_user_stylesheet || false)', env), true);
});

test('list header parsing', () => {
  const h = parseHeader(['[Adblock Plus 2.0]', '! Title: EasyList', '! Version: 202611080000', '! Expires: 4 days (update frequency)']);
  assert.equal(h.title, 'EasyList');
  assert.equal(h.expiresHours, 96);
});

test('materialized IDs encode allow vs block', () => {
  const c = compile('||a.com^\n@@||b.com^$script\n||c.com/x');
  const rules = materializeRules(c.rules, 2_000_000);
  for (const r of rules) {
    const allow = r.action.type === 'allow' || r.action.type === 'allowAllRequests';
    assert.equal(isAllowRuleId(r.id), allow);
  }
});

test('merged buckets are stable when one domain is added', () => {
  const many = Array.from({ length: 3000 }, (_, i) => `||host${i}.example^`);
  const a = mergeAndDedupe(compile(many.join('\n')).rules);
  const b = mergeAndDedupe(compile([...many, '||extra.example^'].join('\n')).rules);
  const ha = new Set(a.map(ruleHash));
  const changed = b.filter((r) => !ha.has(ruleHash(r)));
  assert.equal(changed.length, 1);
});

test('abp pattern to regexp', () => {
  const re = abpPatternToRegExp('||ads.example.com^');
  assert.ok(re.test('https://ads.example.com/x'));
  assert.ok(re.test('https://sub.ads.example.com/'));
  assert.ok(!re.test('https://notads.example.com.evil/'));
  assert.ok(abpPatternToRegExp('/banner/*.gif').test('http://x.com/banner/a.gif'));
});

test('parse: options anchor ignores $ inside regex values', () => {
  const r = parseNetworkFilter('||example.com^$removeparam=/^utm_/');
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.filter.pattern, '||example.com^');
    const conv = convertNetworkFilter(r.filter, { priorityOffset: 0 });
    assert.equal(conv.rules.length, 0); // regex removeparam unsupported
  }
});

test('removeparam never outranks block rules (DNR applies one winner)', () => {
  const list = compile('$removeparam=utm_source\n||ads.example^');
  const user = compile('$removeparam=foo', PRIORITY.userOffset);
  const rp = [...list.rules, ...user.rules].filter((r) => r.action.redirect?.transform);
  const block = list.rules.find((r) => r.action.type === 'block')!;
  for (const r of rp) assert.ok(r.priority < block.priority, `removeparam priority ${r.priority} must be < ${block.priority}`);
});

test('removeparam rules with the same condition are merged', () => {
  const c = compile('$removeparam=a\n$removeparam=b\n||x.com^$removeparam=c');
  const rp = c.rules.filter((r) => r.action.redirect?.transform);
  assert.equal(rp.length, 2);
  assert.deepEqual(rp.find((r) => !r.condition.requestDomains)!.action.redirect!.transform!.queryTransform!.removeParams, ['a', 'b']);
});

test('selectors may contain ; inside quoted attribute values but not outside', () => {
  const ok = compile('###teaser1[style^="width:autopx;"]');
  assert.deepEqual(ok.cosmetic.generic, ['#teaser1[style^="width:autopx;"]']);
  const bad = compile('example.com##div;body{background:red}');
  assert.equal(bad.cosmetic.specific.length, 0);
});

test('path patterns starting with / keep their options', () => {
  const c = compile('/criteo.$domain=~criteo.github.io\n/foo$bar=1/');
  const r = c.rules.find((x) => x.condition.urlFilter === '/criteo.')!;
  assert.deepEqual(r.condition.excludedInitiatorDomains, ['criteo.github.io']);
  assert.ok(c.rules.some((x) => x.condition.regexFilter === 'foo$bar=1'));
});
