import { applyTheme, h } from '../ui/dom';
import { loadSettings } from './common';
import { adsSection, filtersSection, listsSection, sitesSection } from './sections/ads';
import { aiSection, modelSection } from './sections/ai';
import { creatorsSection, keywordsSection, notAiSection, patternsSection } from './sections/creators';
import { aboutSection, backupSection, overviewSection } from './sections/general';

/**
 * Options page: hash-routed sections (#ads, #ai, …) so the popup and the
 * in-page bars can deep-link to the relevant settings.
 */
type Section = { id: string; label: string; render: () => Promise<HTMLElement> };

const GROUPS: { label: string; sections: Section[] }[] = [
  { label: '', sections: [{ id: 'overview', label: 'Overview', render: overviewSection }] },
  {
    label: 'Ads',
    sections: [
      { id: 'ads', label: 'Ad blocking', render: adsSection },
      { id: 'lists', label: 'Filter lists', render: listsSection },
      { id: 'filters', label: 'My filters', render: filtersSection },
      { id: 'sites', label: 'Sites', render: sitesSection },
    ],
  },
  {
    label: 'AI',
    sections: [
      { id: 'ai', label: 'AI filter', render: aiSection },
      { id: 'model', label: 'Image model', render: modelSection },
      { id: 'creators', label: 'Creators & blocklists', render: creatorsSection },
      { id: 'keywords', label: 'Keyword rules', render: keywordsSection },
      { id: 'patterns', label: 'Text patterns', render: patternsSection },
      { id: 'notai', label: '“Not AI” items', render: notAiSection },
    ],
  },
  {
    label: 'More',
    sections: [
      { id: 'backup', label: 'Backup & reset', render: backupSection },
      { id: 'about', label: 'Privacy & about', render: aboutSection },
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.sections);
const nav = document.getElementById('nav')!;
const content = document.getElementById('content')!;

function buildNav(): void {
  for (const g of GROUPS) {
    if (g.label) nav.append(h('li', { class: 'group', 'aria-hidden': 'true' }, g.label));
    for (const s of g.sections) nav.append(h('li', null, h('a', { href: `#${s.id}`, 'data-id': s.id }, s.label)));
  }
}

async function route(): Promise<void> {
  const id = location.hash.slice(1) || 'overview';
  const section = ALL.find((s) => s.id === id) ?? ALL[0]!;
  for (const a of nav.querySelectorAll('a')) {
    if (a.dataset.id === section.id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  await loadSettings();
  try {
    content.replaceChildren(await section.render());
  } catch (err) {
    content.replaceChildren(h('p', { class: 'err' }, `Could not load this section: ${err instanceof Error ? err.message : err}`));
  }
  document.title = `${section.label} · CleanFeed`;
  content.focus({ preventScroll: true });
}

void (async () => {
  const s = await loadSettings();
  applyTheme(s.ui.theme);
  buildNav();
  window.addEventListener('hashchange', () => void route());
  await route();
})();
