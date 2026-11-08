import { getSettings, updateSettings } from '../shared/storage';
import type { Settings } from '../shared/types';
import { h, toast } from '../ui/dom';

/** Layout helpers shared by option sections. */
export function page(title: string, lead?: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', null, h('h1', null, title), lead ? h('p', { class: 'lead' }, lead) : null, ...children);
}

export function panel(...children: (Node | null | false | undefined)[]): HTMLElement {
  return h('div', { class: 'panel' }, ...children);
}

export function padPanel(...children: (Node | null | false | undefined)[]): HTMLElement {
  return h('div', { class: 'panel pad' }, ...children);
}

export function field(label: string, desc: string | null, control: Node): HTMLElement {
  return h('div', { class: 'field' }, h('div', { class: 'label' }, h('b', null, label), desc ? h('span', null, desc) : null), control);
}

/** Current settings snapshot, refreshed after every save. */
export let settings: Settings;

export async function loadSettings(): Promise<Settings> {
  settings = await getSettings();
  return settings;
}

export async function save(mutate: (s: Settings) => void, message = 'Saved'): Promise<void> {
  settings = await updateSettings(mutate);
  if (message) toast(message);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function confirmAction(message: string): boolean {
  return window.confirm(message);
}
