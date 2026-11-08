import type { TextPatternDef } from '../../shared/types';

/**
 * Default "AI writing tell" patterns.
 *
 * Editing guide:
 *  - `pattern` is a RegExp source, matched case-insensitively.
 *  - `weight` is the evidence one hit contributes. Rough scale:
 *      0.2–0.4  common in human writing too (only matters in aggregate)
 *      0.6–1.0  distinctive phrasing
 *      1.5–2.0  rare in human writing
 *      3+ with `strong: true`  near-conclusive artifacts (chatbot boilerplate, citation tokens)
 *  - `maxHits` caps repeated hits so one quirk can't dominate.
 *  - Avoid nested quantifiers (ReDoS); patterns run on every analyzed post.
 *
 * Users can override weights, disable patterns or add their own in the
 * options page; overrides are stored by `id`.
 */
export const DEFAULT_PATTERNS: TextPatternDef[] = [
  // --- Near-conclusive artifacts -------------------------------------------
  { id: 'as-an-ai', pattern: "\\bas an ai(?: language)? model\\b", weight: 4, strong: true, category: 'artifact', description: 'Chatbot self-reference' },
  { id: 'knowledge-cutoff', pattern: '\\b(?:as of my (?:last )?(?:knowledge|training) (?:update|cutoff)|my knowledge cutoff)\\b', weight: 4, strong: true, category: 'artifact', description: 'Knowledge-cutoff disclaimer' },
  { id: 'cannot-browse', pattern: "\\bi (?:don't|do not|cannot|can't) (?:have the ability to )?(?:browse|access) the (?:internet|web)\\b", weight: 3, strong: true, category: 'artifact', description: 'Chatbot capability disclaimer' },
  { id: 'oai-citation', pattern: '(?:contentReference\\[oaicite:\\d+\\]|【\\d+†(?:source|[a-z]+)】|\\bturn\\d+(?:search|news|view)\\d+\\b|utm_source=chatgpt\\.com)', weight: 5, strong: true, category: 'artifact', description: 'Leftover ChatGPT citation markers' },
  { id: 'regenerate', pattern: '\\bregenerate (?:response|answer)\\b', weight: 3, strong: true, category: 'artifact', description: 'Copied chatbot UI text' },
  { id: 'certainly-here', pattern: "^(?:certainly|sure|absolutely|of course)[!,.] here(?:'s| is| are)\\b", weight: 3, strong: true, category: 'artifact', description: 'Assistant-style opener' },
  { id: 'hope-this-helps', pattern: "\\b(?:i hope this (?:helps|information is helpful)|let me know if you(?:'d like| would like| need) (?:me to|any(?:thing)? (?:else|further)|more))\\b", weight: 1.5, category: 'artifact', description: 'Assistant-style closer' },
  { id: 'placeholder', pattern: '\\[(?:your name|insert [a-z ]{2,20}|company name|recipient(?:\\x27s)? name)\\]', weight: 3, strong: true, category: 'artifact', description: 'Unfilled template placeholder' },

  // --- Signature constructions ----------------------------------------------
  { id: 'not-just-x-its-y', pattern: "\\b(?:it'?s|this is|that'?s|this isn'?t|it isn'?t)\\s+(?:not\\s+)?(?:just|only|merely|simply)\\s+(?:about\\s+)?[^.!?\\n]{1,60}?[,;—–-]+\\s*(?:it'?s|this is|that'?s|but)\\b", weight: 1.4, maxHits: 3, category: 'structure', description: '"It\'s not just X — it\'s Y"' },
  { id: 'not-x-its-y', pattern: "\\b(?:it'?s|this) (?:isn'?t|wasn'?t|is not|was not) (?:about )?[^.!?\\n]{1,40}?[.;,—–-]+\\s*(?:it'?s|it was|this is) (?:about )?", weight: 1.0, maxHits: 3, category: 'structure', description: '"This isn\'t X. It\'s Y."' },
  { id: 'not-only-but', pattern: '\\bnot only\\b[^.!?\\n]{1,80}?\\bbut (?:also)?\\b', weight: 0.5, maxHits: 2, category: 'structure', description: '"Not only … but also"' },
  { id: 'no-x-no-y-just-z', pattern: '\\bno [a-z]+(?: [a-z]+)?[.,] no [a-z]+(?: [a-z]+)?[.,] (?:just|only)\\b', weight: 1.2, category: 'structure', description: '"No X. No Y. Just Z."' },
  { id: 'the-result-q', pattern: "\\bthe (?:result|answer|kicker|catch|twist|secret|truth|reality|lesson|takeaway)\\?\\s", weight: 0.9, maxHits: 2, category: 'structure', description: 'Rhetorical "The result?" device' },
  { id: 'heres-the-thing', pattern: "\\bhere(?:'s| is) (?:the thing|the kicker|the truth|the deal|why|what (?:i|we) learned|what happened|the twist)\\s*[:.—–-]", weight: 0.8, maxHits: 2, category: 'structure', description: '"Here\'s the thing:"' },
  { id: 'whether-youre', pattern: "\\bwhether you(?:'re| are) an? [^,.!?\\n]{2,40}? or an? [^,.!?\\n]{2,40}", weight: 0.9, category: 'structure', description: '"Whether you\'re a X or a Y"' },
  { id: 'imagine-world', pattern: '\\bimagine a (?:world|future|place) where\\b', weight: 0.9, category: 'phrase', description: '"Imagine a world where"' },
  { id: 'lets-dive', pattern: "\\blet'?s (?:dive|delve|deep[- ]dive|unpack|break (?:it|this) down)(?: in| into)?\\b", weight: 1.0, category: 'phrase', description: '"Let\'s dive in"' },
  { id: 'read-that-again', pattern: '\\b(?:read that again|let that sink in)\\b', weight: 0.8, category: 'phrase', description: 'Engagement-bait phrasing' },

  // --- Stock phrases ----------------------------------------------------------
  { id: 'fast-paced-world', pattern: "\\bin (?:today'?s|the|this|an?) (?:fast[- ]paced|ever[- ](?:changing|evolving)|rapidly (?:changing|evolving)|digital|modern|increasingly (?:digital|connected|complex)) (?:world|age|era|landscape|environment)\\b", weight: 1.6, category: 'phrase', description: '"In today\'s fast-paced world"' },
  { id: 'ever-evolving-landscape', pattern: '\\bever[- ](?:evolving|changing|shifting) (?:landscape|world|field|realm)\\b', weight: 1.2, category: 'phrase', description: '"Ever-evolving landscape"' },
  { id: 'in-the-realm', pattern: '\\bin the (?:realm|world|landscape|sphere) of\\b', weight: 0.7, maxHits: 2, category: 'phrase', description: '"In the realm of"' },
  { id: 'rich-tapestry', pattern: '\\b(?:rich |vibrant |intricate |complex )?tapestry\\b', weight: 1.1, maxHits: 2, category: 'vocabulary', description: '"Tapestry"' },
  { id: 'delve', pattern: '\\bdelv(?:e|es|ed|ing)\\b', weight: 0.9, maxHits: 3, category: 'vocabulary', description: '"Delve"' },
  { id: 'testament', pattern: '\\b(?:a |is a |stands as a )testament to\\b', weight: 0.9, category: 'phrase', description: '"A testament to"' },
  { id: 'crucial-role', pattern: '\\bplays? an? (?:crucial|pivotal|vital|key|significant|essential) role\\b', weight: 0.9, category: 'phrase', description: '"Plays a crucial role"' },
  { id: 'important-to-note', pattern: '\\bit(?: is|\\x27s) (?:important|worth|crucial|essential) (?:to note|noting|to remember|to consider|to understand)\\b', weight: 0.8, maxHits: 2, category: 'phrase', description: '"It\'s important to note"' },
  { id: 'navigate-complexities', pattern: '\\bnavigat(?:e|ing) (?:the )?(?:complexities|intricacies|challenges|nuances|landscape|waters)\\b', weight: 1.0, category: 'phrase', description: '"Navigate the complexities"' },
  { id: 'embark-journey', pattern: '\\b(?:embark(?:ing|ed)? on|on) (?:a|an|this|your|the) (?:journey|adventure|quest)\\b', weight: 0.8, category: 'phrase', description: '"Embark on a journey"' },
  { id: 'unlock-potential', pattern: '\\b(?:unlock(?:ing)?|unleash(?:ing)?|harness(?:ing)?) (?:the |your |its |their )?(?:full )?(?:power|potential|magic)\\b', weight: 0.9, category: 'phrase', description: '"Unlock the potential"' },
  { id: 'game-changer', pattern: '\\b(?:game[- ]changer|paradigm shift|double[- ]edged sword|treasure trove|a beacon of)\\b', weight: 0.6, maxHits: 2, category: 'phrase', description: 'Stock metaphors' },
  { id: 'elevate', pattern: '\\belevat(?:e|es|ing) (?:your|the|our|their)\\b', weight: 0.6, category: 'phrase', description: '"Elevate your …"' },
  { id: 'look-no-further', pattern: '\\blook no further\\b', weight: 0.9, category: 'phrase', description: '"Look no further"' },
  { id: 'ultimately-conclusion', pattern: '(?:^|\\n)\\s*(?:in conclusion|in summary|to summarize|to sum up|ultimately|overall)[,:]', weight: 0.6, maxHits: 1, category: 'phrase', description: 'Essay-style wrap-up' },
  { id: 'transition-words', pattern: '(?:^|[.!?]\\s+)(?:moreover|furthermore|additionally|consequently|nevertheless)[,]', weight: 0.35, maxHits: 4, category: 'phrase', description: 'Formal transitions' },
  { id: 'myriad-plethora', pattern: '\\b(?:a myriad of|a plethora of|an array of|a multitude of)\\b', weight: 0.6, maxHits: 2, category: 'phrase', description: '"A myriad of"' },
  { id: 'excited-to-announce', pattern: '\\bi(?:\\x27m| am) (?:thrilled|excited|humbled|delighted|honou?red) to (?:announce|share)\\b', weight: 0.35, category: 'phrase', description: 'Announcement opener' },
  { id: 'in-a-world', pattern: '\\bin a world (?:where|of|that|full of)\\b', weight: 0.5, category: 'phrase', description: '"In a world where"' },
  { id: 'key-takeaways', pattern: '(?:^|\\n)\\s*(?:key takeaways?|the bottom line|final thoughts)\\s*[:—–-]', weight: 0.5, category: 'phrase', description: 'Listicle section headers' },

  // --- Vocabulary favored by language models (weak individually) -------------
  { id: 'vocab-core', pattern: '\\b(?:seamless(?:ly)?|robust|leverag(?:e|es|ing)|foster(?:s|ing)?|pivotal|multifaceted|intricate|meticulous(?:ly)?|paramount|nuanced|underscor(?:e|es|ing)|showcas(?:e|es|ing)|streamlin(?:e|es|ing)|bustling|vibrant|interplay|resonat(?:e|es|ing)|transformative|cutting[- ]edge|holistic|synerg(?:y|ies)|empower(?:s|ing)?|commendable|noteworthy|endeavou?r(?:s)?|unwavering|invaluable|boast(?:s|ing)?|enigmatic|labyrinth(?:ine)?|beacon|symphony|kaleidoscope)\\b', weight: 0.25, maxHits: 10, category: 'vocabulary', description: 'LLM-favored vocabulary' },

  // --- Formatting ---------------------------------------------------------------
  { id: 'markdown-bold', pattern: '\\*\\*[^*\\n]{2,60}\\*\\*', weight: 0.8, maxHits: 3, category: 'formatting', description: 'Pasted Markdown bold' },
  { id: 'markdown-heading', pattern: '(?:^|\\n)#{2,4} [^\\n]{3,80}', weight: 1.0, maxHits: 2, category: 'formatting', description: 'Pasted Markdown headings' },
  { id: 'emoji-bullets', pattern: '(?:^|\\n)\\s*(?:✅|🚀|👉|💡|🔑|📌|✨|🔥|🎯|⚡|📈|🧠|💪|🌟|➡️|✔️|🔹|🔸)\\s*\\S', weight: 0.45, maxHits: 6, category: 'formatting', description: 'Emoji-led bullet lines' },
  { id: 'colon-title', pattern: '(?:^|\\n)[A-Z][^\\n:]{2,40}: (?:A|The|How|Why|Unlocking|Navigating|Exploring|Mastering|Understanding)\\b', weight: 0.6, maxHits: 1, category: 'formatting', description: '"Topic: A Subtitle" headline' },
];
