import { send } from '../../shared/messages';
import { getLocal, getOne } from '../../shared/storage';
import type { AiMode, SiteOverride, Subscription } from '../../shared/types';
import { isValidHostname, normalizeHostname } from '../../shared/domain';
import { formatNumber, h, segmented, selectEl, timeAgo, toast, toggleRow } from '../../ui/dom';
import { confirmAction, errorText, field, padPanel, page, panel, save, settings } from '../common';

/** Ad blocking settings, filter lists, the user's own filters, and per-site controls. */

export async function adsSection(): Promise<HTMLElement> {
  const s = settings.ads;
  return page(
    'Ad blocking',
    'Network-level blocking with declarativeNetRequest, element hiding, scriptlets against anti-adblock and ad scripts, and popup blocking. Everything runs locally.',
    panel(
      toggleRow('Block ads and trackers', s.enabled, (v) => void save((x) => (x.ads.enabled = v))),
      field(
        'Strength',
        'Aggressive also blocks popups from any known ad host and enables annoyance lists you turn on.',
        segmented(
          [
            { value: 'standard', label: 'Standard' },
            { value: 'aggressive', label: 'Aggressive' },
          ],
          s.level,
          (v) => void save((x) => (x.ads.level = v as 'standard' | 'aggressive')),
          'Blocking strength',
        ),
      ),
      toggleRow('Element hiding (cosmetic filters)', s.cosmetic, (v) => void save((x) => (x.ads.cosmetic = v)), '## rules, :style rules and procedural filters'),
      toggleRow('Hide promoted posts in feeds', s.feedAds, (v) => void save((x) => (x.ads.feedAds = v)), 'X, Reddit, LinkedIn, YouTube and Google sponsored items'),
      toggleRow('Scriptlets & anti-adblock defusing', s.scriptlets, (v) => void save((x) => (x.ads.scriptlets = v)), 'Runs ##+js() filters from your lists in the page'),
      toggleRow('YouTube video-ad fallback', s.youtubeVideoAds, (v) => void save((x) => (x.ads.youtubeVideoAds = v)), 'Skips and mutes video ads that get through, removes the anti-adblock dialog'),
      field(
        'Popup blocking',
        null,
        selectEl(
          [
            { value: 'off', label: 'Off' },
            { value: 'filters', label: 'Popups matching filters' },
            { value: 'strict', label: 'Strict (also known ad hosts)' },
          ],
          s.popupBlocking,
          (v) => void save((x) => (x.ads.popupBlocking = v)),
          'Popup blocking',
        ),
      ),
      toggleRow('Show block count on the toolbar icon', s.badge, (v) => void save((x) => (x.ads.badge = v))),
    ),
  );
}

function modePill(mode: string | undefined): HTMLElement | null {
  if (!mode || mode === 'none') return null;
  const labels: Record<string, [string, string]> = {
    static: ['bundled', 'ok'],
    'static+delta': ['bundled + updates', 'ok'],
    dynamic: ['dynamic', 'ok'],
    truncated: ['partially installed', 'warn'],
  };
  const [text, cls] = labels[mode] ?? [mode, ''];
  return h('span', { class: `pill ${cls}`, title: 'Where this list’s network rules are installed' }, text);
}

export async function listsSection(): Promise<HTMLElement> {
  const container = h('div');
  const render = async () => {
    const subs = (await getOne('subscriptions')) ?? [];
    const status = await send('ui:dnrStatus', {}).catch(() => null);
    container.replaceChildren();
    const groups: [Subscription['category'], string][] = [
      ['ads', 'Ads'],
      ['privacy', 'Privacy'],
      ['security', 'Security'],
      ['annoyances', 'Annoyances'],
      ['regional', 'Regional'],
      ['custom', 'Custom lists'],
    ];
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      h('button', {
        class: 'btn primary',
        on: {
          click: async (e) => {
            const b = e.currentTarget as HTMLButtonElement;
            b.disabled = true;
            b.textContent = 'Updating…';
            const r = await send('ui:listsUpdate', { force: true }).catch((err) => ({ updated: [], errors: { _: errorText(err) } }));
            const errs = Object.keys(r.errors).length;
            toast(errs ? `Updated ${r.updated.length}, ${errs} failed` : `Updated ${r.updated.length} list(s)`, errs ? 'error' : 'info');
            await render();
          },
        },
      }, 'Update all now'),
      h('span', { class: 'grow' }),
      status ? h('span', { class: 'muted small' }, `Dynamic rules ${formatNumber(status.dynamicRules)} / ${formatNumber(status.dynamicLimit)} · static rulesets ${status.staticRulesets.filter((r) => r.enabled).length} enabled`) : null,
    );
    container.append(toolbar);
    for (const [cat, label] of groups) {
      const items = subs.filter((x) => x.category === cat);
      if (!items.length) continue;
      const rows = items.map((sub) =>
        h(
          'tr',
          null,
          h('td', null, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: sub.enabled, 'aria-label': `Enable ${sub.name}`, on: { change: async (e) => {
            const on = (e.target as HTMLInputElement).checked;
            toast(on ? 'Enabling…' : 'Disabling…');
            const r = await send('ui:listSet', { id: sub.id, enabled: on });
            toast(r.ok ? 'Saved' : r.error ?? 'Failed', r.ok ? 'info' : 'error');
            await render();
          } } }), h('span', { class: 'slider' }))),
          h(
            'td',
            null,
            h('div', { class: 'list-name' }, sub.homepage ? h('a', { href: sub.homepage, target: '_blank', rel: 'noopener' }, sub.name) : sub.name, ' ', sub.aggressive ? h('span', { class: 'pill', title: 'Recommended for the Aggressive level' }, 'aggressive') : null),
            h('div', { class: 'muted small' }, sub.url ? sub.url : 'Ships with CleanFeed'),
            sub.lastError ? h('div', { class: 'err' }, `Last update failed: ${sub.lastError}`) : null,
          ),
          h('td', { class: 'num' }, sub.stats ? formatNumber(sub.stats.dnrRules) + ' rules' : '—'),
          h('td', null, modePill(sub.stats?.mode)),
          h('td', { class: 'muted small' }, sub.url ? timeAgo(sub.lastUpdated) : 'bundled'),
          h(
            'td',
            null,
            sub.url
              ? h('button', { class: 'btn', on: { click: async () => { toast('Updating…'); const r = await send('ui:listsUpdate', { ids: [sub.id], force: true }); toast(r.errors[sub.id] ? `Failed: ${r.errors[sub.id]}` : 'Updated', r.errors[sub.id] ? 'error' : 'info'); await render(); } } }, 'Update')
              : null,
            !sub.builtin ? h('button', { class: 'btn danger', on: { click: async () => { if (!confirmAction(`Remove “${sub.name}”?`)) return; await send('ui:listRemove', { id: sub.id }); await render(); } } }, 'Remove') : null,
          ),
        ),
      );
      container.append(h('h2', null, label), panel(h('table', null, h('tbody', null, ...rows))));
    }
    const url = h('input', { type: 'url', class: 'wide', placeholder: 'https://example.com/filters.txt', 'aria-label': 'Filter list URL' });
    const name = h('input', { type: 'text', placeholder: 'Name (optional)', 'aria-label': 'List name' });
    container.append(
      h('h2', null, 'Add a filter list'),
      padPanel(
        h('div', { class: 'toolbar' }, url, name, h('button', { class: 'btn primary', on: { click: async () => {
          if (!url.value.trim()) return;
          toast('Downloading…');
          const r = await send('ui:listAdd', { url: url.value.trim(), name: name.value });
          toast(r.ok ? 'List added' : `Failed: ${r.error}`, r.ok ? 'info' : 'error');
          if (r.ok || r.id) await render();
        } } }, 'Subscribe')),
        h('p', { class: 'help' }, 'Any list in Adblock Plus, uBlock Origin, AdGuard or hosts-file format. Lists are downloaded directly from their publisher; no browsing data is attached.'),
      ),
    );
  };
  await render();
  return page('Filter lists', 'Lists update automatically in the background. Bundled lists work offline from the first page load; updates are applied as small deltas.', container);
}

export async function filtersSection(): Promise<HTMLElement> {
  const text = (await getOne('userFilters')) ?? '';
  const ta = h('textarea', { rows: 18, spellcheck: false, 'aria-label': 'My filters', placeholder: '! One filter per line, for example:\n||ads.example.com^\nexample.com##.sponsored-box\nexample.com##.post:has-text(/sponsored/i)\n@@||cdn.example.com/needed.js$script' });
  ta.value = text;
  const result = h('div');
  const saveBtn = h('button', { class: 'btn primary', on: { click: async () => {
    saveBtn.disabled = true;
    try {
      const r = await send('ui:userFiltersSave', { text: ta.value });
      result.replaceChildren(h('p', { class: 'help' }, `${r.network} network filter(s) → ${r.dnrRules} DNR rule(s), ${r.cosmetic} cosmetic/scriptlet filter(s).`));
      if (r.errors.length) {
        result.append(h('ul', { class: 'issues' }, ...r.errors.map((e) => h('li', null, h('b', null, `Line ${e.line}: `), h('code', { class: 'code' }, e.text), ' — ', e.message))));
      }
      toast(r.errors.length ? `Saved with ${r.errors.length} unsupported line(s)` : 'Filters applied', r.errors.length ? 'error' : 'info');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      saveBtn.disabled = false;
    }
  } } }, 'Save & apply');
  return page(
    'My filters',
    'Your own network and cosmetic filters. They take priority over every subscribed list. The element picker adds rules here too.',
    padPanel(
      ta,
      h('div', { class: 'toolbar' }, saveBtn, h('span', { class: 'help' }, 'Applies instantly to new page loads.')),
      result,
      h(
        'details',
        { class: 'help-box' },
        h('summary', null, 'Syntax reference'),
        h(
          'div',
          { class: 'help' },
          h('p', null, h('code', null, '||ads.example.com^'), ' block a domain and its subdomains · ', h('code', null, '@@||example.com^$document'), ' allow a whole site'),
          h('p', null, h('code', null, '||example.com/track$script,third-party'), ' block with options (script, image, xhr, frame, media, font, ping, 1p/3p, domain=, important, redirect=, removeparam=, csp=)'),
          h('p', null, h('code', null, 'example.com##.ad-box'), ' hide elements · ', h('code', null, 'example.com#@#.ad-box'), ' exception · ', h('code', null, 'example.com##.box:style(opacity: 0.2)')),
          h('p', null, 'Procedural: ', h('code', null, ':has-text()'), ' ', h('code', null, ':upward()'), ' ', h('code', null, ':xpath()'), ' ', h('code', null, ':matches-css()'), ' ', h('code', null, ':matches-attr()'), ' ', h('code', null, ':min-text-length()'), ' ', h('code', null, ':remove()')),
          h('p', null, 'Scriptlets: ', h('code', null, 'example.com##+js(set-constant, adsEnabled, false)'), ' — see the README for the full list.'),
        ),
      ),
    ),
  );
}

export async function sitesSection(): Promise<HTMLElement> {
  const container = h('div');
  const render = async () => {
    const { allowlist = [], siteOverrides = {} } = await getLocal(['allowlist', 'siteOverrides']);
    container.replaceChildren();
    const input = h('input', { type: 'text', placeholder: 'example.com', 'aria-label': 'Hostname to allow' });
    const addAllow = async () => {
      const host = normalizeHostname(input.value.replace(/^https?:\/\//, '').split('/')[0] ?? '');
      if (!isValidHostname(host)) return toast('Enter a valid hostname', 'error');
      await send('data:mutate', { op: 'allowlist', hostname: host, value: true });
      await render();
    };
    container.append(
      h('h2', null, 'Allowlist'),
      h('p', { class: 'help' }, 'Ad blocking is completely disabled on these sites and their subdomains. AI filtering is controlled separately below.'),
      padPanel(
        h('div', { class: 'toolbar' }, input, h('button', { class: 'btn primary', on: { click: addAllow } }, 'Allow site')),
        allowlist.length
          ? h('table', null, h('tbody', null, ...allowlist.map((host) => h('tr', null, h('td', null, host), h('td', { class: 'num' }, h('button', { class: 'btn', on: { click: async () => { await send('data:mutate', { op: 'allowlist', hostname: host, value: false }); await render(); } } }, 'Remove'))))))
          : h('div', { class: 'empty' }, 'No allowlisted sites.'),
      ),
    );

    const ovHost = h('input', { type: 'text', placeholder: 'example.com', 'aria-label': 'Hostname' });
    const entries = Object.entries(siteOverrides).sort(([a], [b]) => a.localeCompare(b));
    const tri = (v: boolean | undefined) => (v === undefined ? 'default' : v ? 'on' : 'off');
    const fromTri = (v: string) => (v === 'default' ? undefined : v === 'on');
    const rows = entries.map(([host, o]) => {
      const update = async (patch: Partial<SiteOverride>) => {
        await send('data:mutate', { op: 'siteOverride', hostname: host, override: { ...o, ...patch } });
        toast('Saved');
        await render();
      };
      const triSelect = (v: boolean | undefined, key: 'ads' | 'ai' | 'cosmetic') =>
        selectEl([{ value: 'default', label: 'Default' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], tri(v), (x) => void update({ [key]: fromTri(x) }), key);
      return h(
        'tr',
        null,
        h('td', null, host),
        h('td', null, triSelect(o.ai, 'ai')),
        h('td', null, selectEl<AiMode | 'default'>(
          [{ value: 'default', label: 'Default' }, { value: 'collapse', label: 'Collapse' }, { value: 'blur', label: 'Blur' }, { value: 'dim', label: 'Dim' }, { value: 'label', label: 'Label' }],
          o.aiMode ?? 'default',
          (x) => void update({ aiMode: x === 'default' ? undefined : x }),
          'AI mode',
        )),
        h('td', null, triSelect(o.cosmetic, 'cosmetic')),
        h('td', { class: 'num' }, h('button', { class: 'btn', on: { click: async () => { await send('data:mutate', { op: 'siteOverride', hostname: host, override: null }); await render(); } } }, 'Remove')),
      );
    });
    container.append(
      h('h2', null, 'Per-site overrides'),
      h('p', { class: 'help' }, 'Override AI filtering, its display mode, or element hiding for specific sites. Overrides apply to subdomains.'),
      padPanel(
        h('div', { class: 'toolbar' }, ovHost, h('button', { class: 'btn primary', on: { click: async () => {
          const host = normalizeHostname(ovHost.value.replace(/^https?:\/\//, '').split('/')[0] ?? '');
          if (!isValidHostname(host)) return toast('Enter a valid hostname', 'error');
          await send('data:mutate', { op: 'siteOverride', hostname: host, override: { ai: true } });
          await render();
        } } }, 'Add override')),
        rows.length
          ? h('table', null, h('thead', null, h('tr', null, h('th', null, 'Site'), h('th', null, 'AI filter'), h('th', null, 'AI mode'), h('th', null, 'Element hiding'), h('th', null, ''))), h('tbody', null, ...rows))
          : h('div', { class: 'empty' }, 'No overrides yet. You can also toggle sites from the toolbar popup.'),
      ),
    );
  };
  await render();
  return page('Sites', 'Allowlist sites and fine-tune behaviour per site.', container);
}
