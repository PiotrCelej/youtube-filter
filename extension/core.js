/* Shared parsing and identity rules. No page code is evaluated. */
(function (root) {
  "use strict";

  function walk(value, visit) {
    const pending = [value];
    while (pending.length) {
      const current = pending.pop();
      if (!current || typeof current !== "object") continue;
      visit(current);
      for (const child of Object.values(current)) {
        if (child && typeof child === "object") pending.push(child);
      }
    }
  }

  function jsonAt(source, start) {
    if (source[start] !== "{") throw new Error("Nieprawidłowe dane YouTube.");
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index++) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth++;
      else if (character === "}" && --depth === 0) {
        return JSON.parse(source.slice(start, index + 1));
      }
    }
    throw new Error("Niekompletne dane YouTube.");
  }

  function parsePage(html) {
    const initialPattern = /(?:\b(?:var\s+)?ytInitialData|window\s*\[\s*["']ytInitialData["']\s*\])\s*=\s*(?=\{)/g;
    const match = initialPattern.exec(html);
    if (!match) throw new Error("Nie można odczytać listy kanałów. Zaloguj się na YouTube i spróbuj ponownie.");
    const initial = jsonAt(html, initialPattern.lastIndex);
    const config = {};
    const configPattern = /ytcfg\.set\s*\(\s*(?=\{)/g;
    while (configPattern.exec(html)) {
      // YouTube mixes JSON account/API config with JavaScript bootstrap calls
      // such as {"SERVICE_NAME": 'youtube'}. Those optional calls are not JSON.
      // Keep scanning for the JSON config; never evaluate page JavaScript.
      let block;
      try {
        block = jsonAt(html, configPattern.lastIndex);
      } catch {
        continue;
      }
      Object.assign(config, block);
    }
    return { initial, config };
  }

  function channelKey(value) {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value, "https://www.youtube.com");
      if (!["www.youtube.com", "youtube.com"].includes(url.hostname) || url.protocol !== "https:") return null;
      const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
      const id = path.match(/^\/channel\/(UC[\w-]{22})(?:\/|$)/);
      if (id) return `/channel/${id[1]}`;
      const handle = path.match(/^\/(@[^/]+)(?:\/|$)/);
      if (handle) return `/${handle[1].toLowerCase()}`;
      const legacy = path.match(/^\/(user|c)\/([^/]+)(?:\/|$)/);
      return legacy ? `/${legacy[1]}/${legacy[2].toLowerCase()}` : null;
    } catch {
      return null;
    }
  }

  function feedRoots(data, continuation = false) {
    if (continuation) {
      const roots = [];
      for (const action of [...(data.onResponseReceivedActions || []), ...(data.onResponseReceivedEndpoints || [])]) {
        const command = action.appendContinuationItemsAction || action.reloadContinuationItemsCommand;
        if (Array.isArray(command?.continuationItems)) roots.push(command.continuationItems);
      }
      if (data.continuationContents) roots.push(data.continuationContents);
      if (!roots.length) throw new Error("YouTube zwrócił nierozpoznaną kolejną stronę kanałów.");
      return roots;
    }
    const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || data.contents?.singleColumnBrowseResultsRenderer?.tabs;
    const tab = tabs?.map(item => item.tabRenderer).find(item => item?.selected && item.content);
    if (!tab) throw new Error("Nie można rozpoznać listy subskrypcji. Zaloguj się na YouTube i otwórz listę kanałów.");
    return [tab.content];
  }

  function readChannels(roots) {
    const channels = new Map();
    const tokens = new Set();
    for (const root of roots) walk(root, node => {
      const renderer = node.channelRenderer || node.gridChannelRenderer
        || (node.lockupViewModel?.contentType === "LOCKUP_CONTENT_TYPE_CHANNEL" ? node.lockupViewModel : null);
      const id = renderer?.channelId || renderer?.contentId || renderer?.navigationEndpoint?.browseEndpoint?.browseId;
      if (renderer && /^UC[\w-]{22}$/.test(id)) {
        const aliases = new Set([`/channel/${id}`]);
        walk(renderer, child => {
          if (child.browseEndpoint?.browseId === id) {
            const alias = channelKey(child.browseEndpoint.canonicalBaseUrl);
            if (alias) aliases.add(alias);
          }
          // Only links from this channel's own renderer are considered.
          if (typeof child.url === "string") {
            const alias = channelKey(child.url);
            if (alias) aliases.add(alias);
          }
        });
        for (const text of [renderer.channelHandleText, renderer.subscriberCountText, renderer.videoCountText]) {
          const handle = text?.simpleText || text?.runs?.map(run => run.text).join("");
          if (handle?.startsWith("@") && !/\s/.test(handle)) aliases.add(channelKey(`/${handle}`));
        }
        const name = renderer.title?.simpleText || renderer.title?.runs?.map(run => run.text).join("") || id;
        channels.set(id, { id, name, aliases: [...aliases].filter(Boolean) });
      }
      const token = node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
        || node.nextContinuationData?.continuation;
      if (typeof token === "string" && token) tokens.add(token);
    });
    return { channels: [...channels.values()], tokens: [...tokens] };
  }

  function makeIndex(channels) {
    const index = new Set();
    for (const channel of channels) for (const alias of channel.aliases) index.add(alias);
    return index;
  }

  function isSubscribed(links, index) {
    return links.some(link => {
      const key = channelKey(link);
      return key !== null && index.has(key);
    });
  }

  const api = { walk, jsonAt, parsePage, channelKey, feedRoots, readChannels, makeIndex, isSubscribed };
  root.YTSubscriptionFilterCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
