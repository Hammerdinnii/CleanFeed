/**
 * Hostname utilities.
 *
 * We deliberately avoid shipping the full Public Suffix List (~200 KB): the
 * only places we need registrable-domain logic are (a) uBO-style "entity"
 * filters such as `google.*##...` and (b) first/third-party checks for popup
 * blocking. A compact list of common multi-label suffixes covers the sites
 * that filter lists actually target; unknown suffixes degrade to "last two
 * labels", which is what most blockers did historically.
 */

const MULTI_LABEL_SUFFIXES = new Set(
  (
    'co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk sch.uk ' +
    'com.au net.au org.au edu.au gov.au asn.au id.au ' +
    'co.nz org.nz net.nz govt.nz ac.nz ' +
    'co.jp ne.jp or.jp ac.jp go.jp gr.jp ed.jp ' +
    'co.kr or.kr ne.kr go.kr ac.kr ' +
    'com.br net.br org.br gov.br edu.br ' +
    'com.mx org.mx gob.mx net.mx edu.mx ' +
    'com.ar org.ar gob.ar net.ar ' +
    'com.tr org.tr net.tr gov.tr edu.tr ' +
    'com.cn net.cn org.cn gov.cn edu.cn ' +
    'com.tw org.tw net.tw edu.tw gov.tw idv.tw ' +
    'com.hk org.hk net.hk edu.hk gov.hk ' +
    'com.sg org.sg net.sg edu.sg gov.sg ' +
    'co.in net.in org.in gov.in ac.in firm.in gen.in ind.in ' +
    'co.id or.id web.id ac.id go.id ' +
    'co.za org.za gov.za ac.za net.za ' +
    'com.my org.my net.my gov.my edu.my ' +
    'com.ph org.ph net.ph gov.ph edu.ph ' +
    'com.vn net.vn org.vn gov.vn edu.vn ' +
    'co.th or.th in.th ac.th go.th ' +
    'com.pk org.pk net.pk gov.pk edu.pk ' +
    'com.ua org.ua net.ua gov.ua in.ua ' +
    'com.pl net.pl org.pl ' +
    'com.co net.co org.co gov.co ' +
    'com.pe org.pe net.pe gob.pe ' +
    'com.ve org.ve net.ve ' +
    'com.eg org.eg net.eg gov.eg edu.eg ' +
    'com.sa org.sa net.sa gov.sa edu.sa ' +
    'co.il org.il net.il ac.il gov.il ' +
    'com.ng org.ng net.ng gov.ng ' +
    'co.ke or.ke ne.ke go.ke ' +
    'com.bd org.bd net.bd gov.bd ' +
    'com.np org.np net.np ' +
    'com.gr com.cy com.mt com.ec com.uy com.py com.bo com.do com.gt com.sv com.ni com.pa com.pr ' +
    'co.at or.at gv.at ac.at ' +
    'ac.be ' +
    'com.es org.es nom.es gob.es ' +
    'com.pt org.pt gov.pt ' +
    'co.it ' +
    'github.io gitlab.io netlify.app vercel.app pages.dev web.app firebaseapp.com herokuapp.com ' +
    'blogspot.com wordpress.com tumblr.com substack.com medium.com azurewebsites.net cloudfront.net ' +
    'appspot.com s3.amazonaws.com workers.dev fly.dev onrender.com'
  ).split(/\s+/),
);

/** Normalizes a hostname: lowercase, strip trailing dot and `www.` is NOT stripped. */
export function normalizeHostname(h: string): string {
  let host = h.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/** Extracts the hostname from a URL; returns '' for non-hierarchical URLs. */
export function hostnameFromUrl(url: string | undefined | null): string {
  if (!url) return '';
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return '';
  }
}

/** True for http(s) URLs: the only pages we filter. */
export function isWebUrl(url: string | undefined | null): boolean {
  return !!url && /^https?:\/\//i.test(url);
}

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** Returns the public suffix of a hostname (best-effort, see module docs). */
export function publicSuffix(host: string): string {
  if (isIp(host)) return '';
  const labels = host.split('.');
  if (labels.length >= 3) {
    const last2 = labels.slice(-2).join('.');
    if (MULTI_LABEL_SUFFIXES.has(last2)) {
      // e.g. foo.s3.amazonaws.com → suffix s3.amazonaws.com
      const last3 = labels.slice(-3).join('.');
      if (MULTI_LABEL_SUFFIXES.has(last3)) return last3;
      return last2;
    }
    const last3 = labels.slice(-3).join('.');
    if (MULTI_LABEL_SUFFIXES.has(last3)) return last3;
  }
  return labels[labels.length - 1] ?? '';
}

/** Registrable domain ("eTLD+1"), e.g. news.bbc.co.uk → bbc.co.uk. */
export function registrableDomain(host: string): string {
  host = normalizeHostname(host);
  if (!host || isIp(host)) return host;
  const suffix = publicSuffix(host);
  if (!suffix || suffix === host) return host;
  const rest = host.slice(0, host.length - suffix.length - 1);
  const label = rest.split('.').pop();
  return label ? `${label}.${suffix}` : host;
}

/**
 * Yields the hostname and each parent domain down to (and including) the
 * registrable domain: a.b.example.co.uk → [a.b.example.co.uk, b.example.co.uk, example.co.uk].
 */
export function hostnameAncestors(host: string): string[] {
  host = normalizeHostname(host);
  if (!host) return [];
  if (isIp(host)) return [host];
  const reg = registrableDomain(host);
  const out: string[] = [];
  let cur = host;
  for (;;) {
    out.push(cur);
    if (cur === reg) break;
    const dot = cur.indexOf('.');
    if (dot < 0) break;
    cur = cur.slice(dot + 1);
    if (cur.length < reg.length) break;
  }
  return out;
}

/**
 * Entity keys for uBO-style `example.*` matching. For news.google.co.uk this
 * returns [news.google.*, google.*].
 */
export function entityKeys(host: string): string[] {
  host = normalizeHostname(host);
  if (!host || isIp(host)) return [];
  const suffix = publicSuffix(host);
  if (!suffix || suffix === host) return [];
  const withoutSuffix = host.slice(0, host.length - suffix.length - 1);
  const out: string[] = [];
  let cur = withoutSuffix;
  for (;;) {
    out.push(`${cur}.*`);
    const dot = cur.indexOf('.');
    if (dot < 0) break;
    cur = cur.slice(dot + 1);
  }
  return out;
}

/** True when `host` equals `domain` or is a subdomain of it. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  if (domain.endsWith('.*')) {
    return entityKeys(host).includes(domain);
  }
  return host === domain || host.endsWith('.' + domain);
}

/** True if any of the domains matches `host`. */
export function hostMatchesAny(host: string, domains: readonly string[]): boolean {
  for (const d of domains) if (hostMatchesDomain(host, d)) return true;
  return false;
}

/** Whether two hostnames belong to the same site (registrable domain). */
export function isSameSite(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
}

/** Converts a possibly-Unicode hostname to its ASCII (punycode) form using the URL parser. */
export function toAsciiHostname(host: string): string | null {
  if (/^[\x00-\x7f]*$/.test(host)) return host;
  try {
    return new URL(`http://${host}/`).hostname;
  } catch {
    return null;
  }
}

/** Validates a hostname-ish string (allows a leading `*.` wildcard is NOT allowed). */
export function isValidHostname(host: string): boolean {
  return /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_-]{1,63}$/i.test(host);
}

/** Common TLDs used to expand entity filters (`google.*`) into DNR domain lists. */
export const ENTITY_EXPANSION_TLDS = [
  'com', 'net', 'org', 'de', 'co.uk', 'fr', 'it', 'es', 'ca', 'com.au', 'co.jp', 'jp', 'ru', 'nl', 'pl',
  'com.br', 'br', 'in', 'co.in', 'se', 'ch', 'at', 'be', 'dk', 'fi', 'no', 'com.mx', 'mx', 'com.ar', 'cz',
  'pt', 'gr', 'com.tr', 'ie', 'co.nz', 'co.kr', 'com.tw', 'com.hk', 'com.sg', 'co.id', 'co.za', 'ro', 'hu',
  'sk', 'ua', 'com.ua', 'co.il', 'com.vn', 'co.th', 'com.my', 'com.ph', 'com.pk', 'com.co', 'cl', 'com.pe',
  'com.eg', 'com.sa', 'ae', 'lt', 'lv', 'ee', 'bg', 'hr', 'rs', 'si', 'is', 'lu', 'by', 'kz', 'us', 'io', 'tv',
];
