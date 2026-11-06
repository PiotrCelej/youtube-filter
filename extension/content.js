(() => {
  "use strict";
  const core = globalThis.YTSubscriptionFilterCore;
  const { fetchSubscriptions } = globalThis.YTSubscriptionFilterSubscriptions;
  const { collectVideos } = globalThis.YTSubscriptionFilterUploads;
  const TTL = 5 * 60 * 1000;
  const CARD_SELECTOR = "ytd-rich-item-renderer, ytd-rich-section-renderer, ytd-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model";
  const AD_SELECTOR = "ytd-ad-slot-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer, ytd-in-feed-ad-layout-renderer";
  let enabled = true;
  let phase = "loading";
  let error = "";
  let index = new Set();
  let channelCount = 0;
  let updatedAt = 0;
  let controller;
  let generation = 0;
  let scheduled = false;
  let status;
  let observer;
  let started = false;
  let hiddenCount = 0;
  let visibleCount = 0;
  let settingsVersion = 0;
  let settingsReady = false;
  let subscribedChannels = [];
  let uploadsController;
  let uploadsGeneration = 0;
  let uploadsView;
  let uploadsState = { phase: "idle", version: 0, videos: [], errors: [], completed: 0, total: 0 };

  function cancelUploads() {
    uploadsGeneration++;
    uploadsController?.abort();
    uploadsController = undefined;
    uploadsState = { phase: "idle", version: uploadsState.version + 1, videos: [], errors: [], completed: 0, total: 0 };
    uploadsView?.clear();
  }

  async function loadUploads(force = false) {
    if (!enabled || !isHome() || phase !== "ready" || !force && uploadsState.phase !== "idle") return;
    cancelUploads();
    const current = ++uploadsGeneration;
    const requestController = new AbortController();
    uploadsController = requestController;
    uploadsState = { ...uploadsState, phase: "loading", total: subscribedChannels.length };
    schedule();
    try {
      const result = await collectVideos(subscribedChannels, {
        signal: requestController.signal,
        onProgress(progress) {
          if (current !== uploadsGeneration || !enabled) return;
          uploadsState = { ...progress, phase: "loading", version: uploadsState.version + 1 };
          schedule();
        }
      });
      if (current !== uploadsGeneration || !enabled) return;
      uploadsState = { ...uploadsState, ...result, phase: "ready", version: uploadsState.version + 1 };
    } catch (cause) {
      if (current !== uploadsGeneration || !enabled) return;
      uploadsState = { ...uploadsState, phase: "ready", version: uploadsState.version + 1,
        errors: [...uploadsState.errors, { channelName: "Pobieranie filmów", message: cause.message }] };
    } finally {
      if (current === uploadsGeneration) uploadsController = undefined;
      schedule();
    }
  }

  const isHome = () => location.pathname === "/";
  const activeBrowse = () => document.querySelector('ytd-browse[page-subtype="home"]:not([hidden])')
    || (isHome() ? document.querySelector("ytd-browse:not([hidden])") : null);

  function syncRoot() {
    document.documentElement?.toggleAttribute("data-ytsf-active", enabled && isHome());
  }

  function snapshot() {
    return { enabled, phase, error, channelCount, hiddenCount, visibleCount, updatedAt, isHome: isHome(),
      uploadsPhase: uploadsState.phase, uploadsCount: uploadsState.videos.length, uploadsErrors: uploadsState.errors.length };
  }

  function restore() {
    document.querySelectorAll("[data-ytsf-hidden], [data-ytsf-allowed], [data-ytsf-grid], [data-ytsf-home]").forEach(card => {
      card.removeAttribute("data-ytsf-hidden");
      card.removeAttribute("data-ytsf-allowed");
      card.removeAttribute("data-ytsf-grid");
      card.removeAttribute("data-ytsf-home");
    });
    hiddenCount = visibleCount = 0;
    if (status) status.hidden = true;
    if (uploadsView) uploadsView.element.hidden = true;
  }

  function createStatus() {
    const element = document.createElement("div");
    element.id = "ytsf-status";
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    const text = document.createElement("span");
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "Odśwież kanały";
    refresh.addEventListener("click", () => load(true));
    const channels = document.createElement("a");
    channels.href = "/feed/channels";
    channels.textContent = "Lista kanałów";
    const disable = document.createElement("button");
    disable.type = "button";
    disable.textContent = "Wyłącz filtr";
    disable.addEventListener("click", () => {
      chrome.storage.local.set({ enabled: false }).catch(() => {
        text.textContent = "Nie udało się zapisać ustawienia. Otwórz panel rozszerzenia.";
      });
    });
    element.append(text, refresh, channels, disable);
    return element;
  }

  function renderStatus(browse) {
    if (!status) status = createStatus();
    if (!status.isConnected || status.parentElement !== browse) browse.prepend(status);
    status.hidden = false;
    let message;
    if (phase === "loading") message = "Tylko subskrypcje · Pobieranie listy kanałów…";
    else if (phase === "error") message = `Tylko subskrypcje · ${error} Rekomendacje pozostają ukryte do czasu weryfikacji.`;
    else if (channelCount === 0) message = "Tylko subskrypcje · Brak subskrybowanych kanałów na tym koncie.";
    else if (visibleCount === 0) message = `Tylko subskrypcje · ${channelCount} kanałów. W załadowanych rekomendacjach nie ma pasujących filmów. Dodatkowe filmy z kanałów znajdziesz poniżej.`;
    else message = `Tylko subskrypcje · ${channelCount} kanałów · widoczne filmy: ${visibleCount} · ukryte kafelki: ${hiddenCount}`;
    const text = status.querySelector("span");
    if (text.textContent !== message) text.textContent = message;
    status.querySelector("button").disabled = phase === "loading";
  }

  function filter() {
    scheduled = false;
    syncRoot();
    if (!enabled || !isHome()) {
      restore();
      return;
    }
    const browse = activeBrowse();
    if (!browse) return;
    browse.setAttribute("data-ytsf-home", "");
    browse.querySelectorAll("ytd-rich-grid-renderer > #contents").forEach(grid => grid.setAttribute("data-ytsf-grid", ""));
    hiddenCount = visibleCount = 0;
    const cards = [...browse.querySelectorAll(CARD_SELECTOR)].filter(card => !card.parentElement?.closest(CARD_SELECTOR));
    for (const card of cards) {
      const shelf = card.matches("ytd-rich-section-renderer");
      const advertisement = card.querySelector(AD_SELECTOR);
      // Author links, never titles or channel names: names need not be unique.
      const authorLinks = card.querySelectorAll('ytd-channel-name a[href], #channel-name a[href], .yt-content-metadata-view-model__metadata-row a[href], .yt-lockup-metadata-view-model__avatar a[href]');
      const links = [...authorLinks].map(link => link.getAttribute("href"));
      const hasVideo = card.querySelector('a[href*="/watch?"], a[href^="/shorts/"]');
      const allowed = phase === "ready" && !shelf && !advertisement && hasVideo && core.isSubscribed(links, index);
      card.toggleAttribute("data-ytsf-hidden", !allowed);
      card.toggleAttribute("data-ytsf-allowed", Boolean(allowed));
      // The outer card is the unit of filtering; CSS also targets nested renderers.
      card.querySelectorAll(CARD_SELECTOR).forEach(child => child.toggleAttribute("data-ytsf-allowed", Boolean(allowed)));
      if (allowed) visibleCount++;
      else hiddenCount++;
    }
    renderStatus(browse);
    if (!uploadsView) uploadsView = globalThis.YTSubscriptionFilterUploadsView(() => loadUploads(true));
    uploadsView.render(uploadsState, browse);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(filter);
  }

  async function load(force = false) {
    if (!settingsReady || !enabled || !isHome()) return;
    if (!force && (phase === "loading" && controller || phase === "ready" && Date.now() - updatedAt < TTL)) {
      if (phase === "ready") loadUploads();
      schedule();
      return;
    }
    controller?.abort();
    cancelUploads();
    const current = ++generation;
    controller = new AbortController();
    const requestController = controller;
    const timeout = setTimeout(() => requestController.abort(), 45000);
    phase = "loading";
    error = "";
    index = new Set();
    channelCount = 0;
    subscribedChannels = [];
    schedule();
    try {
      const channels = await fetchSubscriptions({ signal: requestController.signal });
      if (current !== generation || !enabled) return;
      index = core.makeIndex(channels);
      channelCount = channels.length;
      subscribedChannels = channels;
      updatedAt = Date.now();
      phase = "ready";
      loadUploads();
    } catch (cause) {
      if (current !== generation || !enabled) return;
      phase = "error";
      error = cause.name === "AbortError" ? "Upłynął czas pobierania kanałów. Spróbuj ponownie." : cause.message;
    } finally {
      clearTimeout(timeout);
      if (current === generation) controller = undefined;
      schedule();
    }
  }

  function applyEnabled(value) {
    settingsReady = true;
    enabled = value !== false;
    syncRoot();
    if (enabled) load();
    else {
      generation++;
      controller?.abort();
      controller = undefined;
      phase = "idle";
      index = new Set();
      channelCount = 0;
      updatedAt = 0;
      subscribedChannels = [];
      cancelUploads();
      restore();
    }
    schedule();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.enabled) {
      settingsVersion++;
      applyEnabled(changes.enabled.newValue);
    }
  });
  const version = settingsVersion;
  chrome.storage.local.get({ enabled: true }).then(settings => {
    if (version === settingsVersion) applyEnabled(settings.enabled);
  }).catch(() => {
    phase = "error";
    error = "Nie udało się odczytać ustawień rozszerzenia. Odśwież stronę.";
    schedule();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "status") sendResponse(snapshot());
    if (message?.type === "refresh") {
      load(true);
      sendResponse(snapshot());
    }
  });

  function navigation() {
    if (!isHome() && uploadsState.phase !== "idle") cancelUploads();
    syncRoot();
    schedule();
    if (enabled && isHome()) load();
  }

  function start() {
    if (started || !document.documentElement) return;
    started = true;
    syncRoot();
    observer = new MutationObserver(mutations => {
      if (!enabled || !isHome()) return;
      if (mutations.some(mutation => !status?.contains(mutation.target) && mutation.target !== status && !uploadsView?.element.contains(mutation.target))) schedule();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "hidden", "page-subtype"] });
    navigation();
  }

  document.addEventListener("yt-navigate-start", () => {
    // Remove permissions from recycled DOM before YouTube changes their contents.
    document.querySelectorAll("[data-ytsf-allowed]").forEach(card => card.removeAttribute("data-ytsf-allowed"));
  });
  document.addEventListener("yt-navigate-finish", navigation);
  document.addEventListener("yt-page-data-updated", navigation);
  document.addEventListener("click", event => {
    if (event.target instanceof Element && event.target.closest('ytd-account-item-renderer, a[href*="accounts.google.com"], a[href*="/signin"]')) {
      generation++;
      controller?.abort();
      controller = undefined;
      phase = "loading";
      index = new Set();
      channelCount = 0;
      updatedAt = 0;
      subscribedChannels = [];
      cancelUploads();
      schedule();
    }
  }, true);
  for (const event of ["yt-subscription-button-state-changed", "yt-subscribe-button-click"]) {
    document.addEventListener(event, () => { updatedAt = 0; if (isHome()) load(true); });
  }
  window.addEventListener("popstate", navigation);
  window.addEventListener("pageshow", navigation);
  window.addEventListener("focus", navigation);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) navigation(); });
  if (document.documentElement) start();
  else new MutationObserver((_, bootstrap) => {
    if (document.documentElement) { bootstrap.disconnect(); start(); }
  }).observe(document, { childList: true });
})();
