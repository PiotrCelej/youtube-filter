"use strict";
importScripts("core.js", "subscriptions.js", "uploads.js", "cache.js", "startup.js");

const { createCache } = globalThis.YTSubscriptionFilterCache;
const { fetchChannelVideos } = globalThis.YTSubscriptionFilterUploads;
const { createStartupRefresher, ALARM } = globalThis.YTSubscriptionFilterStartup;
const requests = new Map();

async function publicFetch(url, options = {}) {
  // Checking the preference on every request also bounds idle time during long
  // playlists. A stalled response is aborted before the worker's 30 s limit.
  if ((await chrome.storage.local.get({ enabled: true })).enabled === false) throw new DOMException("Wyłączono filtr.", "AbortError");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 20000);
  if (options.signal?.aborted) abort();
  try {
    const response = await fetch(url, { ...options, credentials: "omit", signal: controller.signal });
    // Consume the body under the same timeout and cancellation signal.
    const body = await response.text();
    return { ok: response.ok, status: response.status, url: response.url,
      text: async () => body, json: async () => JSON.parse(body) };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

const cache = createCache({ storage: chrome.storage.local, locks: navigator.locks, namespace: chrome.runtime.id,
  fetchVideos: (channel, settings) => fetchChannelVideos(channel, { ...settings,
    fetcher: publicFetch, cookie: "", origin: "https://www.youtube.com" }) });
const startup = createStartupRefresher({ storage: chrome.storage.local, alarms: chrome.alarms, cache });
const reportError = cause => console.warn("YouTube subscription refresh:", cause.message);

chrome.runtime.onStartup.addListener(() => { startup.run("browser-startup", true).catch(reportError); });
chrome.runtime.onInstalled.addListener(() => { startup.run("extension-installed", true).catch(reportError); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) startup.run().catch(reportError); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.enabled) return;
  if (changes.enabled.newValue === false) {
    for (const controller of requests.values()) controller.abort();
    startup.stop().catch(reportError);
  } else startup.run("filter-enabled", true).catch(reportError);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !/^https:\/\/(www\.)?youtube\.com\//.test(sender.tab?.url || "")) return;
  if (message?.type === "cancel-channel-load") {
    requests.get(`${sender.tab.id}:${message.requestId}`)?.abort();
    return;
  }
  if (message?.type !== "load-channel-videos") return;
  if (!/^[a-f0-9]{64}$/.test(message.account) || !/^UC[\w-]{22}$/.test(message.channel?.id)
    || typeof message.requestId !== "string" || message.requestId.length > 100) {
    sendResponse({ error: "Nieprawidłowe żądanie filmów kanału." });
    return;
  }
  const key = `${sender.tab.id}:${message.requestId}`;
  const controller = new AbortController();
  requests.set(key, controller);
  const timeout = setTimeout(() => controller.abort(), 90000);
  cache.getChannel(message.account, { id: message.channel.id, name: message.channel.name }, {
    signal: controller.signal, force: message.force === true
  }).then(videos => sendResponse({ videos }), cause => sendResponse({ error: cause.message }))
    .finally(() => { clearTimeout(timeout); requests.delete(key); });
  return true;
});

// Recover persisted work if Chrome wakes this worker after terminating it.
startup.resume().catch(reportError);
