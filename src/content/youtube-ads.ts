/**
 * YouTube video-ad fallback. Network rules and scriptlets remove most ads
 * before they load; when one still plays (YouTube changes its delivery often)
 * this mutes it, jumps to its end and clicks "Skip". It also dismisses the
 * "Ad blockers are not allowed" enforcement dialog and resumes playback.
 *
 * Everything runs in the isolated world and only touches the DOM, so it
 * degrades gracefully when YouTube's markup changes.
 */
const SKIP_BUTTONS = [
  '.ytp-skip-ad-button',
  '.ytp-ad-skip-button',
  '.ytp-ad-skip-button-modern',
  '.ytp-ad-skip-button-slot button',
  '.videoAdUiSkipButton',
  'button[id^="skip-button"]',
].join(',');

const OVERLAY_CLOSE = '.ytp-ad-overlay-close-button, .ytp-ad-overlay-close-container';

export function startYouTubeAdSkipper(): () => void {
  let mutedByUs = false;
  let rateByUs = false;
  let lastCheck = 0;

  const check = () => {
    lastCheck = performance.now();
    const player = document.querySelector<HTMLElement>('#movie_player, .html5-video-player');
    const video = player?.querySelector<HTMLVideoElement>('video.html5-main-video, video');
    const adShowing = !!player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'));

    if (adShowing && video) {
      if (!video.muted) {
        video.muted = true;
        mutedByUs = true;
      }
      if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.2) {
        try {
          video.playbackRate = 16;
          rateByUs = true;
          video.currentTime = video.duration - 0.1;
        } catch {
          /* some ad formats forbid seeking */
        }
      }
      for (const b of document.querySelectorAll<HTMLElement>(SKIP_BUTTONS)) b.click();
    } else if (video) {
      if (mutedByUs) {
        video.muted = false;
        mutedByUs = false;
      }
      if (rateByUs) {
        video.playbackRate = 1;
        rateByUs = false;
      }
    }
    for (const b of document.querySelectorAll<HTMLElement>(OVERLAY_CLOSE)) b.click();

    // Anti-adblock enforcement dialog.
    const enforcement = document.querySelector('ytd-enforcement-message-view-model');
    if (enforcement) {
      const dialog = enforcement.closest('tp-yt-paper-dialog');
      (dialog ?? enforcement).remove();
      document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach((b) => b.remove());
      document.body?.style.removeProperty('overflow');
      if (video && video.paused) void video.play().catch(() => {});
    }
  };

  // Observe only the player's class attribute (YouTube toggles "ad-showing"
  // there); a slow interval re-attaches after SPA navigations and catches the
  // enforcement dialog.
  let observed: Element | null = null;
  const mo = new MutationObserver(() => {
    if (performance.now() - lastCheck > 100) check();
  });
  const attach = () => {
    const p = document.querySelector('#movie_player');
    if (p && p !== observed) {
      mo.disconnect();
      mo.observe(p, { attributes: true, attributeFilter: ['class'] });
      observed = p;
    }
  };
  const iv = setInterval(() => {
    attach();
    check();
  }, 700);
  return () => {
    mo.disconnect();
    clearInterval(iv);
  };
}
