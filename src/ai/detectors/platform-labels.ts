import type { Signal } from '../../shared/types';
import type { ItemInfo } from '../types';

/**
 * Detector: explicit platform labels and creator disclosures.
 *
 * Site adapters collect the text of label-like elements (badges, flairs,
 * "How this content was made" sections, Community Notes…) into
 * `item.labels`; this module decides whether any of them is an AI disclosure.
 * Matching runs only on those label texts, never on the post body, so a post
 * merely *mentioning* "AI-generated" is not treated as labeled.
 */
export const AI_LABEL_PATTERNS: RegExp[] = [
  /\bmade with ai\b/i,
  /\bai[- ]generated\b/i,
  /\bgenerated (?:with|by|using) (?:an? )?ai\b/i,
  /\bcreated (?:with|by|using) (?:an? )?ai\b/i,
  /\baltered or synthetic content\b/i,
  /\bsynthetic (?:content|media|image|video)\b/i,
  /\bai info\b/i,
  /\bimagined with ai\b/i,
  /\bai[- ](?:assisted|modified|edited|enhanced|art|image|video|content)\b/i,
  /\bdigitally (?:created|altered|generated)\b/i,
  /\baigc\b/i,
  /\b(?:midjourney|stable ?diffusion|sdxl|dall[·\- ]?e|firefly|leonardo\.?ai|flux(?:\.1)?|sora|veo|runway|kling|imagen)\b/i,
  /\bcontent credentials\b/i,
];

/** Community-note style statements that the media is AI-generated. */
const NOTE_PATTERNS: RegExp[] = [
  /\b(?:is|was|appears to be|has been) (?:an? )?(?:ai[- ]generated|generated (?:by|with|using) ai|created (?:by|with|using) ai|deepfake|digitally (?:altered|created|manipulated))\b/i,
  /\b(?:this|the) (?:image|video|photo|clip|picture|audio) (?:is|was) (?:fake|synthetic|ai)\b/i,
];

export function labelSignal(item: ItemInfo): Signal | null {
  if (item.definitive) {
    return {
      detector: 'platformLabels',
      score: 1,
      weight: 1,
      reason: item.definitive.reason,
      detail: item.definitive.detail,
      definitive: true,
    };
  }
  for (const raw of item.labels) {
    const text = raw.trim();
    if (!text) continue;
    const isNote = text.length > 80;
    const patterns = isNote ? NOTE_PATTERNS : AI_LABEL_PATTERNS;
    const hit = patterns.find((re) => re.test(text));
    if (!hit) continue;
    if (/content credentials/i.test(text)) {
      // A C2PA badge alone only says provenance data exists; metadata decides.
      continue;
    }
    return {
      detector: 'platformLabels',
      score: isNote ? 0.9 : 0.99,
      weight: isNote ? 0.9 : 1,
      reason: isNote ? 'Community note: AI-generated' : 'Platform label',
      detail: text.length > 60 ? text.slice(0, 57) + '…' : text,
      definitive: !isNote,
    };
  }
  return null;
}
