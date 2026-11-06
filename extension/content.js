(() => {
  "use strict";
  const core = globalThis.YTSubscriptionFilterCore;
  const { fetchSubscriptions } = globalThis.YTSubscriptionFilterSubscriptions;
  const { createCache, accountKey } = globalThis.YTSubscriptionFilterCache;
  function fetchVideosInBackground(channel, options) {
    if (!options.account) return globalThis.YTSubscriptionFilterUploads.fetchChannelVideos(channel, options);
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        chrome.runtime.sendMessage({ type: "cancel-channel-load", requestId }).catch(() => {});
        reject(new DOMException("Przerwano pobieranie filmów.", "AbortError"));
      };
      if (options.signal?.aborted) { abort(); return; }
      options.signal?.addEventListener("abort", abort, { once: true });
      chrome.runtime.sendMessage({ type: "load-channel-videos", requestId,
        account: options.account, channel: { id: channel.id, name: channel.name }, force: options.force === true
      }).then(result => {
        if (result?.error) reject(new Error(result.error));
        else if (Array.isArray(result?.videos)) resolve(result.videos);
        else reject(new Error("Nieprawidłowa odpowiedź pobierania w tle."));
      }, reject).finally(() => options.signal?.removeEventListener("abort", abort));
    });
  }
  const cache = createCache({ storage: chrome.storage.local, locks: navigator.locks,
    namespace: chrome.runtime.id, fetchChannels: fetchSubscriptions, fetchVideos: fetchVideosInBackground });
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
  let account = null;
  let blockedAccount = null;
  let refreshingChannels = false;
  let uploadsNextCheckAt = 0;
  const accountConfig = {};
  const scannedScripts = new WeakSet();
  let uploadsState = { phase: "idle", version: 0, videos: [], errors: [], completed: 0, total: 0 };

  function cancelUploads(clear = true) {
    uploadsGeneration++;
    uploadsController?.abort();
    uploadsController = undefined;
    if (clear) {
      uploadsState = { phase: "idle", version: uploadsState.version + 1, videos: [], errors: [], completed: 0, total: 0 };
      uploadsView?.clear();
      uploadsNextCheckAt = 0;
    }
  }

  function renderUploads() {
    if (!enabled || !isHome()) return;
    const browse = activeBrowse();
    if (!browse) return;
    if (!uploadsView) uploadsView = globalThis.YTSubscriptionFilterUploadsView(() => loadUploads(true));
    uploadsView.render(uploadsState, browse);
  }

  async function loadUploads(force = false, savedView) {
    if (!enabled || !isHome() || phase !== "ready" || !force && (uploadsController || uploadsState.phase !== "idle" && Date.now() < uploadsNextCheckAt)) return;
    cancelUploads(false);
    const current = ++uploadsGeneration;
    const requestController = new AbortController();
    uploadsController = requestController;
    try {
      const view = savedView || await cache.readView(account, subscribedChannels);
      if (current !== uploadsGeneration || !enabled) return;
      const cached = Boolean(view?.videos.length);
      uploadsState = { phase: "loading", videos: view?.videos || [], errors: [], completed: 0,
        total: subscribedChannels.length, version: uploadsState.version + 1, cached };
      renderUploads();
      const result = await cache.refreshVideos(account, subscribedChannels, {
        signal: requestController.signal,
        force, view,
        onProgress(progress) {
          if (current !== uploadsGeneration || !enabled) return;
          uploadsState = { ...progress, cached, phase: "loading", version: uploadsState.version + 1 };
          renderUploads();
        }
      });
      if (current !== uploadsGeneration || !enabled) return;
      uploadsState = { ...uploadsState, ...result, phase: "ready", version: uploadsState.version + 1 };
      uploadsNextCheckAt = result.errors.length ? Date.now() + 60000
        : !force && view && !view.pending.length ? view.nextCheckAt : Date.now() + 15 * 60 * 1000;
    } catch (cause) {
      if (current !== uploadsGeneration || !enabled) return;
      uploadsState = { ...uploadsState, phase: "ready", version: uploadsState.version + 1,
        errors: [...uploadsState.errors, { channelName: "Pobieranie filmów", message: cause.message }] };
    } finally {
      if (current === uploadsGeneration) uploadsController = undefined;
      renderUploads();
    }
  }

  async function resolveAccount(signal) {
    async function scan() {
      for (const script of document.querySelectorAll("script:not([src])")) {
        if (scannedScripts.has(script) || !script.textContent) continue;
        scannedScripts.add(script);
        const source = script.textContent;
        if (/ytcfg\.set/.test(source)) Object.assign(accountConfig, core.readConfig(source));
      }
      const key = await accountKey(accountConfig);
      return key && key !== blockedAccount ? key : null;
    }
    const found = await scan();
    if (found || document.readyState !== "loading" || accountConfig.LOGGED_IN === false || blockedAccount) return found;
    // The bootstrap config arrives with the HTML stream, before the home cards.
    return new Promise((resolve, reject) => {
      let busy = false;
      let done = false;
      const finish = (value, cause) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        document.removeEventListener("DOMContentLoaded", check);
        signal.removeEventListener("abort", abort);
        if (cause) reject(cause);
        else resolve(value);
      };
      const abort = () => finish(null, signal.reason);
      const check = async () => {
        if (busy || done) return;
        busy = true;
        const key = await scan();
        busy = false;
        if (key || document.readyState !== "loading") finish(key);
      };
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => finish(null), 2000);
      observer.observe(document, { childList: true, subtree: true });
      document.addEventListener("DOMContentLoaded", check);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else check();
    });
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
    if (phase === "ready" && refreshingChannels) message += " · Aktualizacja kanałów w tle…";
    if (phase === "ready" && error) message += ` · Nie udało się odświeżyć: ${error} Wyświetlany jest zapisany widok.`;
    if (cache.warning) message += " · Pamięć lokalna jest niedostępna; po ponownym otwarciu dane mogą wymagać pobrania.";
    const text = status.querySelector("span");
    if (text.textContent !== message) text.textContent = message;
    status.querySelector("button").disabled = phase === "loading" || refreshingChannels;
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
    renderUploads();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(filter);
  }

  async function load(force = false) {
    if (!settingsReady || !enabled || !isHome()) return;
    if (!force && (controller || phase === "ready" && Date.now() - updatedAt < TTL)) {
      if (phase === "ready") loadUploads();
      schedule();
      return;
    }
    controller?.abort();
    const current = ++generation;
    controller = new AbortController();
    const requestController = controller;
    const timeout = setTimeout(() => requestController.abort(), 45000);
    if (phase !== "ready") phase = "loading";
    refreshingChannels = true;
    error = "";
    schedule();
    try {
      const resolvedAccount = await resolveAccount(requestController.signal);
      if (current !== generation || !enabled) return;
      if (resolvedAccount !== account) {
        account = resolvedAccount;
        subscribedChannels = [];
        index = new Set();
        channelCount = 0;
        phase = "loading";
        cancelUploads();
      }
      const saved = await cache.readView(account);
      if (current !== generation || !enabled) return;
      if (saved) {
        index = core.makeIndex(saved.channels);
        channelCount = saved.channels.length;
        subscribedChannels = saved.channels;
        updatedAt = saved.checkedAt;
        phase = "ready";
        if (uploadsState.phase === "idle") loadUploads(false, saved);
        schedule();
      }
      const result = await cache.getChannels(account, { signal: requestController.signal, force });
      if (current !== generation || !enabled) return;
      const channels = result.channels;
      const changed = JSON.stringify(subscribedChannels) !== JSON.stringify(channels);
      index = core.makeIndex(channels);
      channelCount = channels.length;
      subscribedChannels = channels;
      updatedAt = result.checkedAt;
      phase = "ready";
      if (changed || force) {
        cancelUploads(false);
        uploadsState.phase = "idle";
        const allowed = new Set(channels.map(channel => channel.id));
        uploadsState.videos = uploadsState.videos.filter(video => allowed.has(video.channelId));
        uploadsState.version++;
        renderUploads();
      }
      loadUploads(force);
    } catch (cause) {
      if (current !== generation || !enabled) return;
      if (phase !== "ready") phase = "error";
      error = cause.name === "AbortError" ? "Upłynął czas pobierania kanałów. Spróbuj ponownie." : cause.message;
    } finally {
      clearTimeout(timeout);
      if (current === generation) { controller = undefined; refreshingChannels = false; }
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
      refreshingChannels = false;
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
    if (area === "local" && account && enabled && isHome() && phase === "ready" && !uploadsController
      && Object.keys(changes).some(key => key.startsWith(`ytsf-cache-v1:${account}:videos:`))) {
      const currentAccount = account;
      cache.readView(account, subscribedChannels).then(view => {
        if (!view || account !== currentAccount || !enabled || !isHome() || uploadsController) return;
        uploadsState = { ...uploadsState, videos: view.videos, version: uploadsState.version + 1 };
        renderUploads();
      }).catch(() => {});
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
    if (!isHome() && uploadsController) {
      cancelUploads(false);
      uploadsState.phase = "idle";
    }
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
      refreshingChannels = false;
      blockedAccount = account;
      account = null;
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
