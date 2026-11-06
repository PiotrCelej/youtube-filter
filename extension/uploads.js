(function (root) {
  "use strict";
  const core = root.YTSubscriptionFilterCore;
  const { requestBrowse } = root.YTSubscriptionFilterSubscriptions;
  const VIDEO_ID = /^[\w-]{11}$/;

  function monthCutoff(now = new Date()) {
    // A calendar month, with month-end clamping (31 March -> 28/29 February).
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
    cutoff.setUTCDate(Math.min(now.getUTCDate(), lastDay));
    return cutoff;
  }

  function selectVideos(videos, now = new Date()) {
    const unique = new Map();
    for (const video of videos) {
      const time = Date.parse(video.published);
      if (VIDEO_ID.test(video.id) && Number.isFinite(time) && time <= now.getTime()) unique.set(video.id, video);
    }
    const sorted = [...unique.values()].sort((a, b) => Date.parse(b.published) - Date.parse(a.published) || a.id.localeCompare(b.id));
    const recent = sorted.filter(video => Date.parse(video.published) >= monthCutoff(now).getTime());
    return recent.length ? recent.map(video => ({ ...video, fallback: false })) : sorted.slice(0, 1).map(video => ({ ...video, fallback: true }));
  }

  function xmlText(value) {
    return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
      const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      if (named[entity]) return named[entity];
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    });
  }

  function parseFeed(xml, channel) {
    if (!/<feed\b/.test(xml) || !/<\/feed\s*>/.test(xml)) throw new Error("Nie można odczytać kanału publikacji YouTube.");
    const value = (source, tag) => xmlText(source.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`))?.[1] || "").trim();
    // The feed header uses the 22-character ID; entries usually include UC.
    // Compare only against this exact channel, without relaxing author validation.
    const feedChannelId = value(xml, "yt:channelId");
    if (feedChannelId !== channel.id && feedChannelId !== channel.id.slice(2)) throw new Error("YouTube zwrócił publikacje innego kanału.");
    const videos = [];
    for (const match of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry\s*>/g)) {
      const entry = match[1];
      const id = value(entry, "yt:videoId");
      const published = value(entry, "published");
      if (!VIDEO_ID.test(id) || !Number.isFinite(Date.parse(published)) || value(entry, "yt:channelId") !== channel.id) {
        throw new Error("Niekompletne dane publikacji YouTube.");
      }
      videos.push({ id, title: value(entry, "title") || "Film", published, channelId: channel.id,
        channelName: value(entry, "name") || channel.name || channel.id });
    }
    return videos;
  }

  function playlistPage(initial, continuation = false) {
    let roots;
    if (continuation) roots = core.feedRoots(initial, true);
    else {
      roots = [];
      // Scope extraction to the active list, excluding the secondary recommendations.
      const selected = core.feedRoots(initial);
      for (const root of selected) core.walk(root, node => { if (node.playlistVideoListRenderer) roots.push(node.playlistVideoListRenderer); });
      if (!roots.length) {
        // Current YouTube places video lockups directly inside itemSectionRenderer.
        for (const root of selected) core.walk(root, node => {
          const items = node.itemSectionRenderer?.contents;
          if (Array.isArray(items) && items.some(item => item.lockupViewModel?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO")) roots.push(items);
        });
      }
      if (!roots.length) throw new Error("Nie można odczytać listy filmów kanału.");
    }
    const videos = new Map();
    const tokens = new Set();
    // Walk in page order: the upload playlist is ordered from newest to oldest.
    function visit(value) {
      if (!value || typeof value !== "object") return;
      const renderer = value.playlistVideoRenderer;
      if (renderer && VIDEO_ID.test(renderer.videoId) && renderer.isPlayable !== false) {
        videos.set(renderer.videoId, { id: renderer.videoId,
          title: renderer.title?.simpleText || renderer.title?.runs?.map(run => run.text).join("") || "Film" });
        return;
      }
      const lockup = value.lockupViewModel;
      if (lockup?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" && VIDEO_ID.test(lockup.contentId)) {
        videos.set(lockup.contentId, { id: lockup.contentId,
          title: lockup.metadata?.lockupMetadataViewModel?.title?.content || "Film" });
        // Menus can contain other watch commands; they are not playlist entries.
        return;
      }
      const token = value.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || value.nextContinuationData?.continuation;
      if (token) tokens.add(token);
      for (const child of Object.values(value)) if (child && typeof child === "object") visit(child);
    }
    for (const item of roots) visit(item);
    return { videos: [...videos.values()], tokens: [...tokens] };
  }

  function watchPublication(html, video, channel) {
    const pattern = /(?:\b(?:var\s+)?ytInitialPlayerResponse|window\s*\[\s*["']ytInitialPlayerResponse["']\s*\])\s*=\s*(?=\{)/g;
    if (!pattern.exec(html)) throw new Error("Nie można odczytać daty publikacji filmu.");
    const player = core.jsonAt(html, pattern.lastIndex);
    const metadata = player.microformat?.playerMicroformatRenderer;
    if (player.playabilityStatus?.status && player.playabilityStatus.status !== "OK") return null;
    if (player.videoDetails?.isUpcoming || metadata?.liveBroadcastDetails?.isLiveNow) return null;
    const owner = player.videoDetails?.channelId || metadata?.externalChannelId;
    if (owner !== channel.id) throw new Error("Nie można potwierdzić autora filmu.");
    const published = metadata?.publishDate || metadata?.uploadDate;
    if (!published || !Number.isFinite(Date.parse(published))) throw new Error("Brak dokładnej daty publikacji filmu.");
    return { ...video, published, channelId: channel.id, channelName: player.videoDetails?.author || channel.name || channel.id };
  }

  async function fetchChannelVideos(channel, { signal, fetcher = fetch, cookie = document.cookie, origin = location.origin, now = new Date() } = {}) {
    if (!/^UC[\w-]{22}$/.test(channel.id) || !["https://www.youtube.com", "https://youtube.com"].includes(origin)) throw new Error("Nieprawidłowy kanał YouTube.");
    const settings = { signal, fetcher, cookie, origin };
    async function text(path) {
      const response = await fetcher(`${origin}${path}`, { signal, credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(`Nie udało się pobrać filmów (HTTP ${response.status}).`);
      if (response.url && new URL(response.url).origin !== origin) throw new Error("YouTube wymaga zalogowania lub zaakceptowania zgód.");
      return response.text();
    }
    let feed;
    try {
      feed = parseFeed(await text(`/feeds/videos.xml?channel_id=${channel.id}`), channel);
      const dates = feed.map(video => Date.parse(video.published));
      // RSS contains the latest 15 publications, including Shorts and streams.
      // If they cover the cutoff, older playlist pages cannot add recent uploads.
      if (feed.length < 15 || Math.min(...dates) < monthCutoff(now).getTime()) return selectVideos(feed, now);
    } catch (cause) {
      if (signal?.aborted) throw cause;
      // RSS may be unavailable. The channel's complete upload playlist is the fallback.
    }
    const known = new Map((feed || []).map(video => [video.id, video]));
    const html = await text(`/playlist?list=UU${channel.id.slice(2)}&hl=en`);
    const { initial, config } = core.parsePage(html);
    let batch = playlistPage(initial);
    const collected = new Map();
    const seen = new Set();
    let page = 0;
    while (true) {
      signal?.throwIfAborted();
      let pastCutoff = false;
      for (const video of batch.videos) {
        if (collected.has(video.id)) continue;
        const publication = known.get(video.id) || watchPublication(await text(`/watch?v=${video.id}&hl=en`), video, channel);
        if (!publication || Date.parse(publication.published) > now.getTime()) continue;
        collected.set(video.id, publication);
        if (Date.parse(publication.published) < monthCutoff(now).getTime()) {
          pastCutoff = true;
          break;
        }
      }
      if (pastCutoff || !batch.tokens.length) break;
      // Do not silently return an incomplete month's publications on pagination errors.
      const token = batch.tokens[0];
      if (seen.has(token) || ++page > 200) throw new Error("Nie udało się odczytać pełnej listy filmów z ostatniego miesiąca.");
      seen.add(token);
      const data = await requestBrowse({ continuation: token }, config, settings);
      batch = playlistPage(data, true);
    }
    return selectVideos([...collected.values(), ...(feed || [])], now);
  }

  async function collectVideos(channels, { signal, onProgress = () => {}, concurrency = 4, ...settings } = {}) {
    let next = 0;
    let completed = 0;
    const results = new Map();
    const errors = [];
    async function worker() {
      while (next < channels.length) {
        signal?.throwIfAborted();
        const channel = channels[next++];
        // Bound each channel's total work, and link cancellation to the master switch.
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(abort, 90000);
        try {
          const videos = await fetchChannelVideos(channel, { ...settings, signal: controller.signal });
          signal?.throwIfAborted();
          results.set(channel.id, videos);
        } catch (cause) {
          if (signal?.aborted) throw cause;
          errors.push({ channelId: channel.id, channelName: channel.name || channel.id,
            message: cause.name === "AbortError" ? "Upłynął czas pobierania filmów." : cause.message });
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
        }
        onProgress({ completed: ++completed, total: channels.length, videos: [...results.values()].flat(), errors: [...errors] });
      }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), channels.length) }, worker));
    return { videos: [...results.values()].flat(), errors };
  }

  root.YTSubscriptionFilterUploads = { monthCutoff, selectVideos, parseFeed, playlistPage, watchPublication, fetchChannelVideos, collectVideos };
  if (typeof module !== "undefined" && module.exports) module.exports = root.YTSubscriptionFilterUploads;
})(globalThis);
