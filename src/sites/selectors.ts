/**
 * Site selectors — the single place to update when a site changes its markup.
 *
 * Each entry is plain data consumed by the adapters in ./adapters. Prefer
 * stable hooks (data-testid, custom element names, ARIA roles) over class
 * names, and list fallbacks: the first selector that matches wins.
 */
export const SELECTORS = {
  twitter: {
    hosts: ['x.com', 'twitter.com', 'mobile.twitter.com', 'mobile.x.com'],
    item: 'article[data-testid="tweet"]',
    /** Virtualized list cell that wraps each tweet. Collapse/hide the article inside, never the cell itself. */
    cell: '[data-testid="cellInnerDiv"]',
    text: '[data-testid="tweetText"]',
    userName: '[data-testid="User-Name"]',
    permalink: 'a[href*="/status/"]:has(> time), a[href*="/status/"] time',
    media: '[data-testid="tweetPhoto"] img, [data-testid="card.layoutLarge.media"] img, [data-testid="card.layoutSmall.media"] img',
    communityNote: '[data-testid="birdwatch-pivot"], [data-testid="birdwatch-pivot-text"]',
    /** Header region where the "Ad"/"Promoted" badge appears. */
    adBadge: '[data-testid="ad-badge"], [data-testid="placementTracking"] span',
    promotedTexts: ['Ad', 'Promoted', 'Anzeige', 'Publicité', 'Anuncio', 'Annuncio', 'Promovido', 'Gesponsert', 'Sponsorisé', 'Patrocinado', 'Реклама', '広告', 'プロモーション', '광고', 'Reklam', 'Advertentie'],
  },

  youtube: {
    hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com'],
    item: [
      'ytd-rich-item-renderer',
      'ytd-video-renderer',
      'ytd-compact-video-renderer',
      'ytd-grid-video-renderer',
      'ytd-reel-item-renderer',
      'ytd-playlist-video-renderer',
      'yt-lockup-view-model',
      'ytm-shorts-lockup-view-model',
      'ytm-shorts-lockup-view-model-v2',
      'ytm-video-with-context-renderer',
      'ytm-compact-video-renderer',
      'ytd-reel-video-renderer',
      'ytd-comment-thread-renderer',
    ].join(','),
    title: [
      '#video-title',
      'a#video-title-link',
      'h3 a',
      '.yt-lockup-metadata-view-model__title',
      '.yt-lockup-metadata-view-model-wiz__title',
      '.shortsLockupViewModelHostMetadataTitle',
      '.shortsLockupViewModelHostOutsideMetadataTitle',
      '.media-item-headline',
    ].join(','),
    channel: [
      'ytd-channel-name a',
      '#channel-name a',
      'a.yt-core-attributed-string__link[href^="/@"]',
      'a[href^="/@"]',
      'a[href^="/channel/"]',
      '#author-text',
    ].join(','),
    commentText: '#content-text',
    videoLink: 'a[href*="watch?v="], a[href^="/shorts/"]',
    thumbnail: 'ytd-thumbnail img, yt-image img, img.yt-core-image, .yt-thumbnail-view-model img, .shortsLockupViewModelHostThumbnail img',
    /** Watch page containers that may contain "Altered or synthetic content". */
    watchDisclosure: [
      'ytd-watch-metadata',
      '#description',
      'how-this-was-made-section-view-model',
      'ytd-how-this-was-made-section-view-model',
      'ytd-engagement-panel-section-list-renderer',
      'yt-reel-metapanel-view-model',
      'reel-player-overlay-renderer',
    ].join(','),
    watchPlayer: '#player-container-outer, #player, ytd-player',
    feedAds: [
      'ytd-ad-slot-renderer',
      'ytd-in-feed-ad-layout-renderer',
      'ytd-promoted-sparkles-web-renderer',
      'ytd-promoted-video-renderer',
      'ytd-display-ad-renderer',
      'ytd-compact-promoted-video-renderer',
      'ytd-search-pyv-renderer',
      'ytm-promoted-sparkles-web-renderer',
      'ad-slot-renderer',
    ].join(','),
  },

  google: {
    hosts: [] as string[], // matched by entity (google.*), see adapter
    /** Organic results. */
    item: '#rso div.MjjYud, #rso > div.g, #rso div.g:not(.g .g)',
    resultLink: 'a[href^="http"]:has(h3), a[jsname][href^="http"]',
    snippet: '.VwiC3b, [data-sncf], .lEBKkf, .yXK7lf',
    /** Headings that introduce AI Overviews, by UI language. */
    aiOverviewHeadings: [
      'AI Overview', 'AI overview', 'Übersicht mit KI', 'KI-Übersicht', 'Aperçu IA', 'Aperçu généré par l’IA', "Aperçu généré par l'IA",
      'Visión general creada por IA', 'Resumen de IA', 'Panoramica IA', 'Panoramica creata con l’IA', 'Visão geral criada por IA',
      'Visão geral de IA', 'AI による概要', 'AI 개요', 'AI 摘要', 'AI 概览', 'Обзор от ИИ', 'AI-overzicht', 'Przegląd od AI', 'AI-översikt',
      'Yapay zeka genel bakışı', 'Ringkasan AI', 'AI-oversigt', 'AI-oversikt', 'Tekoälyn yleiskatsaus',
    ],
    /** Known AI Overview container hooks (fallbacks to heading search). */
    aiOverviewContainers: '[data-attrid="AIOverview"], div[jsname="N760b"], #m-x-content, div[data-mcpr]',
    /** Top-level blocks under these are what we collapse. */
    blockStops: '#rso, #center_col, #search, #rcnt, #botstuff, #main, [role="main"]',
    aiModeTab: 'a[href*="udm=50"], div[role="listitem"]:has(> a[href*="udm=50"])',
    ads: '#tads, #tadsb, #bottomads, div[data-text-ad], .commercial-unit-desktop-top, .commercial-unit-desktop-rhs, .cu-container',
  },

  reddit: {
    hosts: ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'sh.reddit.com'],
    item: 'shreddit-post, shreddit-comment, .thing.link, .thing.comment, article[data-post-id]',
    postText: '[slot="text-body"], [slot="title"], .md, .usertext-body, a.title, [id$="-post-rtjson-content"]',
    commentText: '[slot="comment"], .usertext-body .md',
    flair: 'shreddit-post-flair, flair-tag, [slot="post-flair"], .linkflairlabel, .flair, [data-testid="post-flair"]',
    media: 'img[src*="preview.redd.it"], img[src*="i.redd.it"], shreddit-aspect-ratio img, gallery-carousel img, .media-preview img',
    ads: 'shreddit-ad-post, shreddit-comments-page-ad, shreddit-dynamic-ad-link, shreddit-sidebar-ad, comment-tree-ad, .promotedlink',
  },

  linkedin: {
    hosts: ['linkedin.com', 'www.linkedin.com'],
    item: 'div.feed-shared-update-v2, div[data-urn^="urn:li:activity:"], div[data-id^="urn:li:activity:"], article.comments-comment-entity, .comments-comment-item',
    text: '.update-components-text, .feed-shared-inline-show-more-text, .feed-shared-update-v2__description, .update-components-update-v2__commentary, .comments-comment-item__main-content, .comments-comment-entity__content',
    actorLink: 'a.update-components-actor__meta-link, a.update-components-actor__image, a.app-aware-link[href*="/in/"], a.app-aware-link[href*="/company/"], a[href*="/in/"]',
    actorName: '.update-components-actor__title, .update-components-actor__name, .comments-comment-meta__description-title',
    subDescription: '.update-components-actor__sub-description, .update-components-actor__description, .feed-shared-actor__sub-description',
    media: '.update-components-image img, .feed-shared-image img, .update-components-linkedin-video img',
    contentCredentials: '[aria-label*="Content Credentials" i], [class*="content-credentials"], [class*="c2pa"]',
    promotedTexts: ['Promoted', 'Promoted by', 'Gesponsert', 'Sponsorisé', 'Promocionado', 'Promovido', 'Sponsorizzato', 'Gepromoot', 'Promowane', 'プロモーション'],
  },

  generic: {
    /** Article-like containers analyzed on sites without a dedicated adapter. */
    item: 'article, [role="article"], [itemprop="articleBody"], .post-content, .entry-content, .article-body, .article-content, .post-body, .story-body',
    exclude: 'nav, header, footer, aside, form, [role="navigation"], [contenteditable="true"]',
    /** Minimum words before a generic block is analyzed at all. */
    minWords: 120,
  },
} as const;
