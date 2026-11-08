import { BUILTIN_COMMUNITIES } from '../../ai/communities';
import { displayHandle } from '../../ai/detectors/blocklist';
import { DEFAULT_PATTERNS } from '../../ai/patterns/default-patterns';
import { send } from '../../shared/messages';
import { getLocal, getOne, setLocal } from '../../shared/storage';
import type { BlockEntry, BlockPlatform, CommunityList, KeywordRule, TextPatternDef } from '../../shared/types';
import { download, h, pickFile, selectEl, timeAgo, toast, toggleRow } from '../../ui/dom';
import { uid } from '../../shared/util';
import { confirmAction, padPanel, page, panel } from '../common';

/** Creator/channel blocklists, keyword rules, text patterns and the "Not AI" whitelist. */

const PLATFORMS: { value: BlockPlatform; label: string }[] = [
  { value: 'twitter', label: 'X / Twitter' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'reddit', label: 'Reddit (u/ or r/)' },
  { value: 'linkedin', label: 'LinkedIn (in/ or company/)' },
  { value: 'web', label: 'Website (search results)' },
  { value: 'any', label: 'Any platform' },
];

function toLines(entries: BlockEntry[]): string {
  return entries.map((e) => `${e.platform}:${e.handle}${e.note ? ` # ${e.note}` : ''}`).join('\n');
}

/** Parses txt ("platform:handle"), CSV ("platform,handle,note") or JSON exports. */
function parseImport(text: string): { platform: BlockPlatform; handle: string; note?: string }[] {
  const out: { platform: BlockPlatform; handle: string; note?: string }[] = [];
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    const data = JSON.parse(t) as unknown;
    const arr = Array.isArray(data) ? data : (data as { blocklist?: unknown[] }).blocklist ?? [];
    for (const e of arr as BlockEntry[]) if (e && typeof e.handle === 'string') out.push({ platform: (e.platform ?? 'any') as BlockPlatform, handle: e.handle, note: e.note });
    return out;
  }
  const valid = new Set(PLATFORMS.map((p) => p.value));
  for (let line of t.split(/\r?\n/)) {
    const note = /\s#\s*(.*)$/.exec(line)?.[1];
    line = line.replace(/\s#.*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    let platform: BlockPlatform = 'any';
    let handle = line;
    const csv = line.split(',');
    if (csv.length >= 2 && valid.has(csv[0]!.trim() as BlockPlatform)) {
      platform = csv[0]!.trim() as BlockPlatform;
      handle = csv[1]!.trim();
    } else {
      const m = /^([a-z]+):(.+)$/.exec(line);
      if (m && valid.has(m[1] as BlockPlatform)) {
        platform = m[1] as BlockPlatform;
        handle = m[2]!;
      } else if (/^[ru]\//.test(line)) platform = 'reddit';
    }
    out.push({ platform, handle, note });
  }
  return out;
}

export async function creatorsSection(): Promise<HTMLElement> {
  const container = h('div');
  const render = async () => {
    const { blocklist = [], communityLists = [], builtinCommunities, trustedAuthors = [] } = await getLocal(['blocklist', 'communityLists', 'builtinCommunities', 'trustedAuthors']);
    container.replaceChildren();
    let platform: BlockPlatform = 'twitter';
    const handle = h('input', { type: 'text', placeholder: '@handle, r/subreddit, in/name, example.com', 'aria-label': 'Handle' });
    const note = h('input', { type: 'text', placeholder: 'Note (optional)', 'aria-label': 'Note' });
    const add = async () => {
      if (!handle.value.trim()) return;
      const r = await send('data:mutate', { op: 'blockAuthor', entry: { platform, handle: handle.value, note: note.value || undefined, added: Date.now(), source: 'user' } });
      if (!r.ok) return toast(r.error ?? 'Failed', 'error');
      handle.value = '';
      note.value = '';
      await render();
    };
    handle.addEventListener('keydown', (e) => e.key === 'Enter' && void add());
    const sorted = [...blocklist].sort((a, b) => b.added - a.added);
    container.append(
      h('h2', null, 'Your blocklist'),
      h('p', { class: 'help' }, 'Content from these creators, channels, communities or sites is treated as AI with full confidence. You can also block a creator from the ⋯ menu on any flagged item.'),
      padPanel(
        h('div', { class: 'toolbar' }, selectEl(PLATFORMS, platform, (v) => (platform = v), 'Platform'), handle, note, h('button', { class: 'btn primary', on: { click: add } }, 'Block')),
        h(
          'div',
          { class: 'toolbar' },
          h('button', { class: 'btn', on: { click: async () => {
            const f = await pickFile('.txt,.csv,.json,text/plain,application/json');
            if (!f) return;
            try {
              const items = parseImport(await f.text());
              for (const it of items) await send('data:mutate', { op: 'blockAuthor', entry: { ...it, added: Date.now(), source: 'user' } });
              toast(`Imported ${items.length} entr${items.length === 1 ? 'y' : 'ies'}`);
              await render();
            } catch {
              toast('Could not read that file', 'error');
            }
          } } }, 'Import…'),
          h('button', { class: 'btn', on: { click: () => download('cleanfeed-blocklist.txt', toLines(blocklist), 'text/plain') } }, 'Export .txt'),
          h('button', { class: 'btn', on: { click: () => download('cleanfeed-blocklist.json', JSON.stringify(blocklist, null, 2)) } }, 'Export .json'),
          blocklist.length ? h('button', { class: 'btn danger', on: { click: async () => { if (!confirmAction('Remove every entry from your blocklist?')) return; await setLocal({ blocklist: [] }); await render(); } } }, 'Clear') : null,
        ),
        sorted.length
          ? h('table', null, h('thead', null, h('tr', null, h('th', null, 'Platform'), h('th', null, 'Handle'), h('th', null, 'Note'), h('th', null, 'Added'), h('th', null, ''))), h('tbody', null, ...sorted.slice(0, 500).map((e) => h('tr', null, h('td', null, PLATFORMS.find((p) => p.value === e.platform)?.label ?? e.platform), h('td', null, h('code', { class: 'code' }, displayHandle(e))), h('td', { class: 'muted' }, e.note ?? ''), h('td', { class: 'muted small' }, timeAgo(e.added)), h('td', { class: 'num' }, h('button', { class: 'btn', on: { click: async () => { await send('data:mutate', { op: 'unblockAuthor', platform: e.platform, handle: e.handle }); await render(); } } }, 'Remove'))))))
          : h('div', { class: 'empty' }, 'Your blocklist is empty.'),
        sorted.length > 500 ? h('p', { class: 'help' }, `Showing 500 of ${sorted.length}. Export to see all.`) : null,
      ),
    );

    container.append(
      h('h2', null, 'Community lists'),
      panel(
        toggleRow('Known AI-content communities', builtinCommunities !== false, async (v) => { await setLocal({ builtinCommunities: v }); toast('Saved'); }, `${BUILTIN_COMMUNITIES.length} subreddits dedicated to AI art and video (e.g. r/midjourney, r/StableDiffusion)`),
      ),
    );
    const clUrl = h('input', { type: 'url', class: 'wide', placeholder: 'https://example.org/ai-accounts.txt', 'aria-label': 'Community list URL' });
    const clRows = communityLists.map((cl) =>
      h(
        'tr',
        null,
        h('td', null, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: cl.enabled, 'aria-label': `Enable ${cl.name}`, on: { change: async (e) => {
          const lists = communityLists.map((x) => (x.id === cl.id ? { ...x, enabled: (e.target as HTMLInputElement).checked } : x));
          await setLocal({ communityLists: lists });
          await render();
        } } }), h('span', { class: 'slider' }))),
        h('td', null, h('div', { class: 'list-name' }, cl.name), h('div', { class: 'muted small' }, cl.url), cl.error ? h('div', { class: 'err' }, cl.error) : null),
        h('td', { class: 'num' }, `${cl.entries.length} entries`),
        h('td', { class: 'muted small' }, timeAgo(cl.lastUpdated)),
        h('td', { class: 'num' },
          h('button', { class: 'btn', on: { click: async () => { const r = await send('ui:communityUpdate', { id: cl.id }); toast(r.ok ? 'Updated' : Object.values(r.errors)[0] ?? 'Failed', r.ok ? 'info' : 'error'); await render(); } } }, 'Update'),
          h('button', { class: 'btn danger', on: { click: async () => { await setLocal({ communityLists: communityLists.filter((x) => x.id !== cl.id) }); await render(); } } }, 'Remove'),
        ),
      ),
    );
    container.append(
      padPanel(
        h('p', { class: 'help' }, 'Subscribe to shared blocklists (one entry per line, e.g. ', h('code', null, 'twitter:handle'), ', ', h('code', null, 'youtube:@channel'), ', ', h('code', null, 'reddit:r/sub'), '). Lists are downloaded directly and refreshed daily; nothing is uploaded.'),
        h('div', { class: 'toolbar' }, clUrl, h('button', { class: 'btn primary', on: { click: async () => {
          let url: URL;
          try {
            url = new URL(clUrl.value.trim());
          } catch {
            return toast('Enter a valid URL', 'error');
          }
          const cl: CommunityList = { id: uid(), name: url.hostname + url.pathname, url: url.href, enabled: true, entries: [] };
          await setLocal({ communityLists: [...communityLists, cl] });
          const r = await send('ui:communityUpdate', { id: cl.id });
          toast(r.ok ? 'Subscribed' : `Added, but download failed: ${Object.values(r.errors)[0]}`, r.ok ? 'info' : 'error');
          await render();
        } } }, 'Subscribe')),
        clRows.length ? h('table', null, h('tbody', null, ...clRows)) : null,
      ),
    );

    container.append(
      h('h2', null, 'Trusted creators'),
      padPanel(
        h('p', { class: 'help' }, 'Content from trusted creators is never flagged. Entries look like ', h('code', null, 'twitter:handle'), '.'),
        trustedAuthors.length
          ? h('table', null, h('tbody', null, ...trustedAuthors.map((k) => h('tr', null, h('td', null, h('code', { class: 'code' }, k)), h('td', { class: 'num' }, h('button', { class: 'btn', on: { click: async () => { await send('data:mutate', { op: 'trustAuthor', key: k, value: false }); await render(); } } }, 'Remove'))))))
          : h('div', { class: 'empty' }, 'No trusted creators.'),
        trustInput(render),
      ),
    );
  };
  await render();
  return page('Creators & blocklists', 'Block or trust specific creators, channels, communities and sites.', container);
}

function trustInput(render: () => Promise<void>): HTMLElement {
  let platform: BlockPlatform = 'twitter';
  const input = h('input', { type: 'text', placeholder: 'handle', 'aria-label': 'Trusted handle' });
  return h('div', { class: 'toolbar' }, selectEl(PLATFORMS.filter((p) => p.value !== 'any' && p.value !== 'web'), platform, (v) => (platform = v), 'Platform'), input, h('button', { class: 'btn', on: { click: async () => {
    const hnd = input.value.trim().toLowerCase().replace(/^@/, '');
    if (!hnd) return;
    await send('data:mutate', { op: 'trustAuthor', key: `${platform}:${platform === 'reddit' && !/^[ur]\//.test(hnd) ? `u/${hnd}` : hnd}`, value: true });
    await render();
  } } }, 'Trust'));
}

export async function keywordsSection(): Promise<HTMLElement> {
  const container = h('div');
  const render = async () => {
    const rules = (await getOne('keywordRules')) ?? [];
    container.replaceChildren();
    const pattern = h('input', { type: 'text', class: 'wide', placeholder: 'phrase, or /regular expression/i', 'aria-label': 'Keyword or pattern' });
    let target: KeywordRule['target'] = 'ads';
    const sites = h('input', { type: 'text', placeholder: 'Only on (optional): x.com, reddit.com', 'aria-label': 'Restrict to sites' });
    const targets = [
      { value: 'ads' as const, label: 'Hide matching items' },
      { value: 'ai' as const, label: 'Count as AI signal' },
      { value: 'both' as const, label: 'Both' },
    ];
    const add = async () => {
      const p = pattern.value.trim();
      if (!p) return;
      if (/^\/.+\/[a-z]*$/.test(p)) {
        try {
          const m = /^\/(.+)\/([a-z]*)$/.exec(p)!;
          new RegExp(m[1]!, m[2]);
        } catch {
          return toast('Invalid regular expression', 'error');
        }
      }
      const rule: KeywordRule = { id: uid(), pattern: p, target, enabled: true, sites: sites.value.split(/[\s,]+/).filter(Boolean) };
      await send('data:mutate', { op: 'keywordRule', id: rule.id, rule });
      pattern.value = '';
      await render();
    };
    pattern.addEventListener('keydown', (e) => e.key === 'Enter' && void add());
    container.append(
      padPanel(
        h('div', { class: 'toolbar' }, pattern),
        h('div', { class: 'toolbar' }, selectEl(targets, target, (v) => (target = v), 'Action'), sites, h('button', { class: 'btn primary', on: { click: add } }, 'Add rule')),
        h('p', { class: 'help' }, 'Plain text matches whole words, case-insensitively, in post text, titles, author names and URLs. “Hide matching items” collapses posts, videos, results and articles with a “Show anyway” bar — useful for promotional content filter lists miss.'),
        rules.length
          ? h('table', null, h('thead', null, h('tr', null, h('th', null, 'On'), h('th', null, 'Pattern'), h('th', null, 'Action'), h('th', null, 'Sites'), h('th', null, ''))), h('tbody', null, ...rules.map((r) => h('tr', null,
              h('td', null, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: r.enabled, 'aria-label': 'Enabled', on: { change: async (e) => { await send('data:mutate', { op: 'keywordRule', id: r.id, rule: { ...r, enabled: (e.target as HTMLInputElement).checked } }); } } }), h('span', { class: 'slider' }))),
              h('td', null, h('code', { class: 'code' }, r.pattern)),
              h('td', null, selectEl(targets, r.target, (v) => void send('data:mutate', { op: 'keywordRule', id: r.id, rule: { ...r, target: v } }), 'Action')),
              h('td', { class: 'muted small' }, r.sites?.length ? r.sites.join(', ') : 'everywhere'),
              h('td', { class: 'num' }, h('button', { class: 'btn', on: { click: async () => { await send('data:mutate', { op: 'keywordRule', id: r.id, rule: null }); await render(); } } }, 'Remove')),
            ))))
          : h('div', { class: 'empty' }, 'No keyword rules yet.'),
      ),
    );
  };
  await render();
  return page('Keyword rules', 'Your own phrases and patterns, applied to both ad-style and AI content.', container);
}

export async function patternsSection(): Promise<HTMLElement> {
  const container = h('div');
  const render = async () => {
    const stored = (await getOne('textPatterns')) ?? null;
    const byId = new Map<string, TextPatternDef>(DEFAULT_PATTERNS.map((p) => [p.id, { ...p }]));
    for (const p of stored ?? []) byId.set(p.id, { ...byId.get(p.id), ...p });
    const list = [...byId.values()];
    const persist = async () => {
      // Store only differences from the defaults plus custom patterns.
      const defaults = new Map(DEFAULT_PATTERNS.map((p) => [p.id, p]));
      const diff = list.filter((p) => {
        const d = defaults.get(p.id);
        return !d || d.weight !== p.weight || (d.enabled ?? true) !== (p.enabled ?? true) || d.pattern !== p.pattern;
      });
      await setLocal({ textPatterns: diff.length ? diff : null });
      toast('Saved');
    };
    container.replaceChildren();
    const rows = list.map((p) => {
      const weight = h('input', { type: 'number', class: 'narrow', step: '0.05', min: '0', max: '10', value: String(p.weight), 'aria-label': `Weight for ${p.description}` });
      weight.addEventListener('change', () => {
        p.weight = Math.max(0, Math.min(10, Number(weight.value) || 0));
        void persist();
      });
      const isCustom = !DEFAULT_PATTERNS.some((d) => d.id === p.id);
      return h(
        'tr',
        null,
        h('td', null, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: p.enabled !== false, 'aria-label': 'Enabled', on: { change: (e) => { p.enabled = (e.target as HTMLInputElement).checked; void persist(); } } }), h('span', { class: 'slider' }))),
        h('td', null, h('div', null, p.description, p.strong ? h('span', { class: 'pill warn', title: 'Near-conclusive on its own' }, ' strong') : null), h('details', null, h('summary', { class: 'muted small' }, p.category), h('code', { class: 'code' }, p.pattern))),
        h('td', null, weight),
        h('td', { class: 'num' }, isCustom ? h('button', { class: 'btn', on: { click: async () => { list.splice(list.indexOf(p), 1); await persist(); await render(); } } }, 'Delete') : null),
      );
    });
    const desc = h('input', { type: 'text', placeholder: 'Description', 'aria-label': 'Description' });
    const pat = h('input', { type: 'text', class: 'wide', placeholder: 'Regular expression, e.g. \\bsynergize\\b', 'aria-label': 'Pattern' });
    const w = h('input', { type: 'number', class: 'narrow', value: '0.6', step: '0.05', 'aria-label': 'Weight' });
    container.append(
      padPanel(
        h('div', { class: 'toolbar' }, pat, desc, w, h('button', { class: 'btn primary', on: { click: async () => {
          try {
            new RegExp(pat.value, 'giu');
          } catch {
            return toast('Invalid regular expression', 'error');
          }
          if (!pat.value.trim()) return;
          list.push({ id: `custom-${uid()}`, pattern: pat.value, weight: Number(w.value) || 0.6, category: 'phrase', description: desc.value || pat.value });
          await persist();
          await render();
        } } }, 'Add pattern')),
        h(
          'div',
          { class: 'toolbar' },
          h('button', { class: 'btn', on: { click: () => download('cleanfeed-patterns.json', JSON.stringify(list, null, 2)) } }, 'Export'),
          h('button', { class: 'btn', on: { click: async () => {
            const f = await pickFile('.json,application/json');
            if (!f) return;
            try {
              const data = JSON.parse(await f.text()) as TextPatternDef[];
              const valid = data.filter((p) => p && typeof p.id === 'string' && typeof p.pattern === 'string' && typeof p.weight === 'number');
              for (const p of valid) new RegExp(p.pattern, 'giu');
              await setLocal({ textPatterns: valid });
              toast(`Imported ${valid.length} patterns`);
              await render();
            } catch {
              toast('Invalid pattern file', 'error');
            }
          } } }, 'Import'),
          h('button', { class: 'btn danger', on: { click: async () => { if (!confirmAction('Reset all patterns to defaults?')) return; await setLocal({ textPatterns: null }); await render(); } } }, 'Reset to defaults'),
        ),
        h('p', { class: 'help' }, 'Weights are the evidence one match adds (≈0.3 weak, ≈1 distinctive, ≥3 with “strong” near-conclusive). Scores are normalized by text length, so long texts need proportionally more matches.'),
        h('table', null, h('thead', null, h('tr', null, h('th', null, 'On'), h('th', null, 'Pattern'), h('th', null, 'Weight'), h('th', null, ''))), h('tbody', null, ...rows)),
      ),
    );
  };
  await render();
  return page('Text patterns', 'The AI writing tells used by the text detector. Adjust weights, disable patterns you disagree with, or add your own.', container);
}

export async function notAiSection(): Promise<HTMLElement> {
  const container = h('div');
  const render = async () => {
    const notAi = (await getOne('notAi')) ?? {};
    const entries = Object.entries(notAi).sort((a, b) => b[1] - a[1]);
    container.replaceChildren(
      padPanel(
        h('div', { class: 'toolbar' }, h('span', { class: 'grow' }, `${entries.length} item(s) marked “Not AI” on this device.`), entries.length ? h('button', { class: 'btn danger', on: { click: async () => { if (!confirmAction('Forget all “Not AI” decisions?')) return; await setLocal({ notAi: {} }); await render(); } } }, 'Clear all') : null),
        entries.length
          ? h('table', null, h('tbody', null, ...entries.slice(0, 300).map(([k, t]) => h('tr', null, h('td', null, h('code', { class: 'code' }, k.length > 120 ? k.slice(0, 117) + '…' : k)), h('td', { class: 'muted small' }, timeAgo(t)), h('td', { class: 'num' }, h('button', { class: 'btn', on: { click: async () => { await send('data:mutate', { op: 'notAi', key: k, value: false }); await render(); } } }, 'Forget'))))))
          : h('div', { class: 'empty' }, 'Nothing yet. Use “Not AI” on any flagged item; it takes effect immediately and is remembered here.'),
      ),
    );
  };
  await render();
  return page('“Not AI” items', 'Items you corrected. They are never flagged again.', container);
}
