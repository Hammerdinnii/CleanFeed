import { api } from '../shared/api';
import { send, trySend, type PopupState } from '../shared/messages';
import { getSettings, updateSettings } from '../shared/storage';
import type { AiMode, Sensitivity } from '../shared/types';
import { applyTheme, formatNumber, h, segmented, timeAgo, toast, toggleRow } from '../ui/dom';

/**
 * Toolbar popup: per-site quick toggles, page/today stats and the most-used
 * AI controls. All state lives in the background; the popup re-renders from
 * a fresh snapshot after every action.
 */
const app = document.getElementById('app')!;
let tabId = -1;

const LOGO = `<svg viewBox="0 0 32 32" class="logo" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#3b82f6"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#g)"/><path d="M9 11h14M11 16h10M13.5 21h5" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>`;
const POWER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3v8"/><path d="M6.3 6.6a8 8 0 1 0 11.4 0"/></svg>`;

function html(markup: string): Element {
  const t = document.createElement('template');
  t.innerHTML = markup; // static, extension-authored markup only
  return t.content.firstElementChild!;
}

async function refresh(): Promise<void> {
  const st = await trySend('ui:popupState', { tabId }, null);
  render(st);
}

function render(st: PopupState | null): void {
  app.replaceChildren();
  const powerBtn = h('button', { class: `power${st?.enabled ? '' : ' off'}`, title: st?.enabled ? 'Turn CleanFeed off everywhere' : 'Turn CleanFeed on', 'aria-label': 'Toggle CleanFeed' });
  powerBtn.append(html(POWER));
  powerBtn.addEventListener('click', async () => {
    await updateSettings((s) => (s.enabled = !s.enabled));
    await refresh();
  });
  app.append(
    h('header', { class: 'top' }, html(LOGO), h('div', { class: 'grow' }, h('div', { class: 'brand' }, 'CleanFeed'), h('div', { class: 'host', title: st?.hostname ?? '' }, st?.hostname || 'No web page')), powerBtn),
  );
  if (!st) {
    app.append(h('div', { class: 'notice' }, 'CleanFeed is starting up. Reopen this popup in a moment.'));
    return;
  }
  if (!st.enabled) app.append(h('div', { class: 'notice' }, 'CleanFeed is turned off. Nothing is being blocked or filtered.'));

  if (st.isWeb && st.hostname) {
    const host = st.hostname;
    const card = h('section', { class: 'card', 'aria-label': 'This site' });
    card.append(
      toggleRow(
        'Block ads on this site',
        !st.site.allowlisted,
        async (on) => {
          await send('data:mutate', { op: 'allowlist', hostname: host, value: !on });
          toast(on ? 'Ad blocking on — reload to apply' : `Ads allowed on ${host} — reload to apply`);
          await refresh();
        },
        st.site.pausedUntil ? undefined : 'Network rules, element hiding and scriptlets',
        !st.enabled || !st.adsEnabled,
      ),
    );
    if (st.site.pausedUntil) {
      card.append(
        h('div', { class: 'row' }, h('span', { class: 'paused' }, `Paused until ${new Date(st.site.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`), h('button', { class: 'btn', on: { click: async () => { await send('ui:pauseSite', { hostname: host, minutes: null }); await refresh(); } } }, 'Resume')),
      );
    }
    card.append(
      toggleRow(
        'AI content filter on this site',
        st.site.override?.ai !== false,
        async (on) => {
          await send('data:mutate', { op: 'siteOverride', hostname: host, override: { ...(st.site.override ?? {}), ai: on ? undefined : false } });
          toast('Saved — reload the page to apply');
          await refresh();
        },
        undefined,
        !st.enabled || !st.aiEnabled,
      ),
    );
    app.append(card);
  }

  // Stats
  if (st.statsEnabled) {
    const p = st.counts.page;
    app.append(
      h(
        'section',
        { class: 'card pad', 'aria-label': 'Statistics' },
        h(
          'div',
          { class: 'stats' },
          h('div', { class: 'stat' }, h('b', null, formatNumber(p.requests)), h('span', null, 'requests blocked')),
          h('div', { class: 'stat' }, h('b', null, formatNumber(p.elements + p.popups)), h('span', null, 'elements & popups')),
          h('div', { class: 'stat' }, h('b', null, formatNumber(p.ai)), h('span', null, 'AI items flagged')),
        ),
        h('div', { class: 'today' }, `Today: ${formatNumber(st.counts.today.requests)} requests · ${formatNumber(st.counts.today.elements + st.counts.today.popups)} elements · ${formatNumber(st.counts.today.ai)} AI`),
      ),
    );
  }

  // AI quick controls
  const aiCard = h('section', { class: 'card', 'aria-label': 'AI filter' });
  void getSettings().then((s) => {
    aiCard.append(
      h(
        'div',
        { class: 'field' },
        h('label', null, 'AI content'),
        segmented<AiMode>(
          [
            { value: 'collapse', label: 'Hide', title: 'Collapse into a bar with “Show anyway”' },
            { value: 'blur', label: 'Blur' },
            { value: 'dim', label: 'Dim' },
            { value: 'label', label: 'Label' },
          ],
          s.ai.mode,
          (v) => void updateSettings((x) => (x.ai.mode = v)).then(() => toast('Applies to newly loaded content')),
          'AI content treatment',
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', null, 'Sensitivity'),
        segmented<Sensitivity>(
          [
            { value: 'low', label: 'Low', title: 'Only flag when very confident' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'high', label: 'High', title: 'Flag more, with more false positives' },
          ],
          s.ai.sensitivity,
          (v) => void updateSettings((x) => (x.ai.sensitivity = v)),
          'AI sensitivity',
        ),
      ),
    );
    applyTheme(s.ui.theme);
  });
  app.append(aiCard);

  // Actions
  const actions = h('div', { class: 'actions' });
  if (st.isWeb && st.hostname) {
    actions.append(
      h('button', { class: 'btn', on: { click: async () => { const r = await send('ui:startPicker', { tabId }); if (r.ok) window.close(); else toast(r.error ?? 'Cannot run on this page', 'error'); } } }, 'Hide an element'),
      h('button', { class: 'btn', title: 'Temporarily show everything CleanFeed hid on this page', on: { click: async () => { await send('ui:revealPage', { tabId }); toast('Revealed until reload'); } } }, 'Reveal page'),
    );
    if (!st.site.pausedUntil && !st.site.allowlisted) {
      actions.append(h('button', { class: 'btn', title: 'Allow everything on this site for 30 minutes', on: { click: async () => { await send('ui:pauseSite', { hostname: st.hostname, minutes: 30 }); toast('Paused for 30 minutes — reload to apply'); await refresh(); } } }, 'Pause 30 min'));
    }
  }
  actions.append(h('button', { class: 'btn primary', on: { click: () => void api.runtime.openOptionsPage().then(() => window.close()) } }, 'Settings'));
  app.append(actions);

  app.append(
    h(
      'footer',
      { class: 'foot' },
      h('span', null, '100% on-device · no telemetry'),
      h('span', { title: `${st.lists.enabled} lists` }, st.lists.updating ? 'Updating lists…' : `Lists updated ${timeAgo(st.lists.lastUpdated)}`),
    ),
  );
}

void (async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? -1;
  await refresh();
})();
