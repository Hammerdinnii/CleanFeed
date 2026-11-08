import { api } from '../../shared/api';
import { TARGET, VERSION } from '../../shared/env';
import { send } from '../../shared/messages';
import { mergeSettings } from '../../shared/settings';
import type { LocalSchema } from '../../shared/storage';
import { getOne, setLocal } from '../../shared/storage';
import { applyTheme, download, formatNumber, h, pickFile, segmented, toast, toggleRow } from '../../ui/dom';
import { confirmAction, field, padPanel, page, panel, save, settings } from '../common';

/** Overview, backup/restore and the privacy statement. */

export async function overviewSection(): Promise<HTMLElement> {
  const stats = await getOne('stats');
  const hasHostAccess = await api.permissions.contains({ origins: ['<all_urls>'] }).catch(() => true);
  const t = stats?.today;
  const total = stats?.total;
  return page(
    'Overview',
    'CleanFeed blocks ads and trackers and filters AI-generated content. All processing happens on this device: no accounts, no telemetry, no page content ever leaves your browser.',
    !hasHostAccess
      ? padPanel(
          h('p', null, h('b', null, 'Site access needed. '), 'CleanFeed needs permission to run on websites to hide ads and filter content.'),
          h('button', { class: 'btn primary', on: { click: async () => { const ok = await api.permissions.request({ origins: ['<all_urls>'] }); toast(ok ? 'Access granted' : 'Access not granted', ok ? 'info' : 'error'); } } }, 'Grant access'),
        )
      : null,
    panel(
      toggleRow('CleanFeed enabled', settings.enabled, (v) => void save((x) => (x.enabled = v)), 'Master switch for ad blocking and AI filtering'),
      field('Appearance', null, segmented([{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], settings.ui.theme, (v) => void save((x) => (x.ui.theme = v as 'system')).then(() => applyTheme(v as 'system')))),
      toggleRow('Keep quiet statistics', settings.privacy.stats, (v) => void save((x) => (x.privacy.stats = v)), 'Counts only, stored locally. Never transmitted.'),
    ),
    settings.privacy.stats
      ? h(
          'div',
          null,
          h('h2', null, 'Today'),
          h('div', { class: 'statgrid' }, ...statTiles(t)),
          h('h2', null, 'All time'),
          h('div', { class: 'statgrid' }, ...statTiles(total)),
          h('div', { class: 'toolbar' }, h('button', { class: 'btn', on: { click: async () => { await send('ui:resetStats', {}); toast('Statistics reset'); } } }, 'Reset statistics')),
        )
      : null,
  );
}

function statTiles(c: { requests: number; elements: number; ai: number; popups: number } | undefined): HTMLElement[] {
  const v = c ?? { requests: 0, elements: 0, ai: 0, popups: 0 };
  return [
    h('div', null, h('b', null, formatNumber(v.requests)), h('span', null, 'requests blocked')),
    h('div', null, h('b', null, formatNumber(v.elements)), h('span', null, 'elements hidden')),
    h('div', null, h('b', null, formatNumber(v.popups)), h('span', null, 'popups blocked')),
    h('div', null, h('b', null, formatNumber(v.ai)), h('span', null, 'AI items flagged')),
  ];
}

const BACKUP_KEYS: (keyof LocalSchema)[] = [
  'settings',
  'userFilters',
  'allowlist',
  'siteOverrides',
  'blocklist',
  'trustedAuthors',
  'keywordRules',
  'textPatterns',
  'notAi',
  'communityLists',
  'builtinCommunities',
];

export async function backupSection(): Promise<HTMLElement> {
  return page(
    'Backup & reset',
    'Export your configuration to a file and restore it on another browser. Filter-list data and the image model are not included (they re-download or re-import).',
    padPanel(
      h(
        'div',
        { class: 'toolbar' },
        h('button', { class: 'btn primary', on: { click: async () => {
          const data = await api.storage.local.get(BACKUP_KEYS as string[]);
          const subs = (await getOne('subscriptions')) ?? [];
          download(`cleanfeed-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ cleanfeed: 1, version: VERSION, data, lists: subs.map((s) => ({ id: s.id, url: s.url, name: s.name, enabled: s.enabled, builtin: s.builtin, category: s.category })) }, null, 2));
        } } }, 'Export settings'),
        h('button', { class: 'btn', on: { click: async () => {
          const f = await pickFile('.json,application/json');
          if (!f) return;
          try {
            const parsed = JSON.parse(await f.text()) as { cleanfeed?: number; data?: Record<string, unknown> };
            if (parsed.cleanfeed !== 1 || !parsed.data) throw new Error('not a CleanFeed backup');
            const values: Record<string, unknown> = {};
            for (const k of BACKUP_KEYS) if (k in parsed.data) values[k] = parsed.data[k];
            if (values.settings) values.settings = mergeSettings(values.settings);
            await setLocal(values as Partial<LocalSchema>);
            if (typeof values.userFilters === 'string') await send('ui:userFiltersSave', { text: values.userFilters });
            toast('Backup restored');
            setTimeout(() => location.reload(), 600);
          } catch (err) {
            toast(`Import failed: ${err instanceof Error ? err.message : err}`, 'error');
          }
        } } }, 'Import settings…'),
      ),
    ),
    h('h2', null, 'Reset'),
    padPanel(
      h('p', { class: 'help' }, 'Restores every setting to its default and clears your filters, lists, blocklists and statistics.'),
      h('button', { class: 'btn danger', on: { click: async () => {
        if (!confirmAction('Reset CleanFeed completely? This cannot be undone.')) return;
        await send('ui:resetAll', {});
        toast('CleanFeed was reset');
        setTimeout(() => location.reload(), 600);
      } } }, 'Reset everything'),
    ),
  );
}

export async function aboutSection(): Promise<HTMLElement> {
  return page(
    'Privacy & about',
    undefined,
    padPanel(
      h('dl', { class: 'kv' }, h('dt', null, 'Version'), h('dd', null, `${VERSION} (${TARGET})`), h('dt', null, 'Manifest'), h('dd', null, 'V3')),
    ),
    h('h2', null, 'What CleanFeed sends over the network'),
    padPanel(
      h('ul', null,
        h('li', null, h('b', null, 'Filter list updates'), ' — downloads from the list publishers you subscribe to (EasyList, uBlock filters…), without cookies.'),
        h('li', null, h('b', null, 'Community blocklists'), ' — only if you subscribe to one.'),
        h('li', null, h('b', null, 'Image re-reads'), ' — to inspect image metadata or run your local model, CleanFeed may re-request an image from the same server the page loaded it from, without cookies or referrer. Disable under AI → Tuning.'),
        h('li', null, h('b', null, 'Model download'), ' — only when you explicitly download a model from a URL you enter.'),
      ),
      h('p', null, 'Nothing else. No analytics, no crash reports, no accounts, no remote configuration. Page text, images, URLs and your browsing history are processed in your browser and never uploaded.'),
    ),
    h('h2', null, 'Credits'),
    padPanel(
      h('p', { class: 'help' }, 'Filter syntax compatible with Adblock Plus, uBlock Origin and AdGuard. Filter lists belong to their respective maintainers and licenses. Image inference uses ONNX Runtime Web (MIT).'),
    ),
  );
}
