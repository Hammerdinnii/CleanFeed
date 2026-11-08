import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePatterns, resolvePatterns, textPatternSignal } from '../../src/ai/detectors/text-patterns';
import { textStatsSignal } from '../../src/ai/detectors/text-stats';
import { labelSignal } from '../../src/ai/detectors/platform-labels';
import { BlocklistIndex, blocklistSignal } from '../../src/ai/detectors/blocklist';
import { compileKeywords, keywordSignals } from '../../src/ai/detectors/keywords';
import { calibrateModelScore, combineSignals, imageSignals } from '../../src/ai/scoring';
import { profileText } from '../../src/ai/text';
import type { ItemInfo } from '../../src/ai/types';

const patterns = compilePatterns(resolvePatterns(null));

const AI_LINKEDIN = `In today's fast-paced world, leadership isn't just about making decisions — it's about empowering others.

Here's the thing:

Great leaders don't just manage.
They inspire.
They delve into the why.
They foster a culture of trust.

The result? A team that navigates the complexities of change with confidence.

It's not just a strategy — it's a mindset.

Let that sink in.

✅ Lead with empathy
✅ Communicate with clarity
✅ Celebrate the small wins

What's your take? Let's dive in below. 👇`;

const AI_ARTICLE = `In the ever-evolving landscape of digital marketing, businesses must navigate the complexities of consumer behavior. It is important to note that a robust strategy plays a crucial role in success. Moreover, leveraging data allows companies to foster meaningful connections with their audience.

Furthermore, the rich tapestry of social platforms offers a myriad of opportunities. Whether you're a small startup or a large enterprise, understanding these nuances is paramount. Additionally, seamless integration of tools can streamline workflows and elevate your brand.

In conclusion, embracing these transformative approaches is a testament to a company's commitment to innovation. By harnessing the power of analytics, organizations can unlock their full potential in today's digital age.`;

const HUMAN_TWEET = `lol the bus was 40 min late again and the driver just shrugged. gonna start biking tbh, at least then i only have myself to blame when im late`;

const HUMAN_REVIEW = `Bought this blender in March. First month was fine, then the lid started leaking — not a lot, but enough that I keep a towel under it now. Customer support took 9 days to answer and basically said "use less liquid". The motor is strong though, it crushed frozen mango without complaining. Would I buy it again? Probably not at this price. My old Oster lasted eight years and cost half as much. If you only make smoothies on weekends it's okay I guess, but daily use? I'd look elsewhere. Also the cleaning brush they include broke on day two, which, come on.`;

const CHATBOT = `Certainly! Here's a short poem about the ocean for your newsletter. As an AI language model, I don't have personal feelings, but I hope this helps!`;

function scoreOf(text: string) {
  const p = profileText(text);
  const sigs = [textPatternSignal(p, patterns, 40), textStatsSignal(p)].filter((s) => s !== null);
  return combineSignals(sigs, 'balanced');
}

test('flags typical AI-written LinkedIn post', () => {
  const v = scoreOf(AI_LINKEDIN);
  assert.ok(v.flagged, `score ${v.score}`);
  assert.equal(v.reason, 'AI writing patterns');
});

test('flags typical AI-written article', () => {
  const v = scoreOf(AI_ARTICLE);
  assert.ok(v.flagged, `score ${v.score}`);
});

test('chatbot boilerplate is near-conclusive', () => {
  const v = scoreOf(CHATBOT);
  assert.ok(v.flagged && v.score > 0.85, `score ${v.score}`);
  assert.equal(v.reason, 'AI chatbot text');
});

test('does not flag casual human tweet', () => {
  const v = scoreOf(HUMAN_TWEET);
  assert.ok(!v.flagged, `score ${v.score}`);
});

test('does not flag human product review with an em-dash', () => {
  const v = scoreOf(HUMAN_REVIEW);
  assert.ok(!v.flagged, `score ${v.score}`);
  assert.ok(v.score < 0.5, `score ${v.score}`);
});

test('a single tell in a short post is not enough', () => {
  const v = scoreOf('Excited to delve into the new season of my favorite show tonight with friends!');
  assert.ok(!v.flagged, `score ${v.score}`);
});

test('text statistics alone can never flag', () => {
  const v = combineSignals([{ detector: 'textStats', score: 0.99, weight: 0.5, reason: 'x' }], 'high');
  assert.ok(!v.flagged);
});

test('definitive signals win and are not damped', () => {
  const v = combineSignals(
    [
      { detector: 'platformLabels', score: 1, weight: 1, reason: 'Platform label', definitive: true },
      { detector: 'textStats', score: 0.05, weight: 0.5, reason: 'Informal human writing style' },
    ],
    'low',
  );
  assert.ok(v.flagged && v.score >= 0.97);
  assert.equal(v.reason, 'Platform label');
});

const baseItem = (over: Partial<ItemInfo>): ItemInfo => ({ key: 'k', site: 'twitter', kind: 'post', text: '', labels: [], images: [], ...over });

test('platform labels match label text only', () => {
  assert.ok(labelSignal(baseItem({ labels: ['Made with AI'] }))?.definitive);
  assert.ok(labelSignal(baseItem({ labels: ['Altered or synthetic content'] }))?.definitive);
  assert.equal(labelSignal(baseItem({ labels: ['Original content'] })), null);
  // Body text mentioning "AI-generated" is not a label.
  assert.equal(labelSignal(baseItem({ text: 'Is this AI-generated? lol' })), null);
  const note = labelSignal(baseItem({ labels: ['Readers added context they thought people might want to know: This image was generated by AI and does not depict a real event.'] }));
  assert.ok(note && !note.definitive && note.score >= 0.9);
});

test('blocklist matches creators and communities', () => {
  const idx = new BlocklistIndex([
    { platform: 'twitter', handle: 'slopbot', added: 0, source: 'user' },
    { platform: 'reddit', handle: 'r/midjourney', added: 0, source: 'builtin' },
    { platform: 'web', handle: 'contentfarm.example', added: 0, source: 'user' },
  ]);
  assert.ok(blocklistSignal(baseItem({ author: { platform: 'twitter', handle: 'SlopBot' } }), idx)?.definitive);
  assert.equal(blocklistSignal(baseItem({ author: { platform: 'twitter', handle: 'someone' } }), idx), null);
  assert.equal(blocklistSignal(baseItem({ community: 'r/midjourney' }), idx)?.reason, 'AI content community');
  assert.ok(blocklistSignal(baseItem({ linkDomains: ['www.contentfarm.example'] }), idx));
});

test('keyword rules: ai signal vs unwanted hide', () => {
  const kws = compileKeywords([
    { id: '1', pattern: 'crypto giveaway', target: 'ads', enabled: true },
    { id: '2', pattern: '/\\bchatgpt\\b/i', target: 'ai', enabled: true },
  ]);
  const s1 = keywordSignals(baseItem({ text: 'Huge CRYPTO GIVEAWAY today' }), kws, 'x.com');
  assert.equal(s1.length, 1);
  assert.equal(s1[0]!.category, 'unwanted');
  assert.ok(combineSignals(s1, 'low').flagged);
  const s2 = keywordSignals(baseItem({ text: 'I asked ChatGPT to write this' }), kws, 'x.com');
  assert.equal(s2[0]!.category, 'ai');
  // Whole-word matching: "giveaways" plural shouldn't match "crypto giveaway"? It should not match "cryptogiveaway".
  assert.equal(keywordSignals(baseItem({ text: 'cryptogiveaway' }), kws, 'x.com').length, 0);
});

test('image signals: C2PA AI source is definitive, model score calibrated', () => {
  const sigs = imageSignals(
    { url: 'u', metadata: { verdict: 'ai', evidence: ['C2PA: trainedAlgorithmicMedia'], hasC2pa: true } },
    0.8,
  );
  assert.ok(sigs[0]!.definitive);
  assert.ok(calibrateModelScore(0.8, 0.8) >= 0.85);
  assert.ok(calibrateModelScore(0.5, 0.8) < 0.5);
  const model = imageSignals({ url: 'u', model: { score: 0.95, modelId: 'm', backend: 'wasm', ms: 10 } }, 0.8);
  assert.ok(combineSignals(model, 'balanced').flagged);
  const weak = imageSignals({ url: 'u', model: { score: 0.6, modelId: 'm', backend: 'wasm', ms: 10 } }, 0.8);
  assert.ok(!combineSignals(weak, 'balanced').flagged);
});
