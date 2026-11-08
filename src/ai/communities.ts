import type { BlockEntry } from '../shared/types';

/**
 * Built-in list of communities dedicated to AI-generated content. Posts from
 * these are AI by the community's own definition, which makes this one of
 * the lowest-false-positive signals available. Users can turn the list off
 * or extend it with their own entries in the options page.
 */
const SUBREDDITS = [
  'StableDiffusion', 'midjourney', 'aiArt', 'AIArt', 'dalle2', 'dalle', 'AIGeneratedArt', 'aiimages', 'AiArtwork',
  'sdforall', 'comfyui', 'FluxAI', 'aivideo', 'SoraAi', 'ChatGPTArt', 'bing_ai_art', 'weirddalle', 'deepdream',
  'AI_Art_Prompts', 'StableDiffusionInfo', 'leonardoai', 'NightCafeStudio', 'aipromptprogramming', 'AIGenArt',
  'aiwaifu', 'AIfreakout', 'ImaginaryAIArt', 'midjourneyart', 'MediaSynthesis', 'GeneratedPorn',
];

export const BUILTIN_COMMUNITIES: BlockEntry[] = SUBREDDITS.map((s) => ({
  platform: 'reddit',
  handle: `r/${s.toLowerCase()}`,
  note: 'AI-generated content community',
  added: 0,
  source: 'builtin',
}));
