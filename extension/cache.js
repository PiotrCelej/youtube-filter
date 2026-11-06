(function (root) {
  "use strict";
  const { selectVideos, fetchChannelVideos, collectVideos } = root.YTSubscriptionFilterUploads;
  const SUBSCRIPTIONS_TTL = 5 * 60 * 1000;
  const VIDEOS_TTL = 15 * 60 * 1000;
  const PREFIX = "ytsf-cache-v1:";

  async function accountKey(config) {
    if (config.LOGGED_IN === false) return null;
    const identity = config.DATASYNC_ID || config.USER_SESSION_ID;
    if (typeof identity !== "string" || !identity) return null;
    const value = `${identity}|${config.DELEGATED_SESSION_ID || ""}`;
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function createCache({ storage, locks, namespace = "ytsf", clock = Date.now, fetchChannels, fetchVideos = fetchChannelVideos } = {}) {
    const memory = new Map();
    const unpersisted = new Set();
    let warning = false;
    const subscriptionsKey = account => `${PREFIX}${account}:subscriptions`;
    const videoKey = (account, channel) => `${PREFIX}${account}:videos:${channel}`;
    const valid = entry => entry?.schema === 1 && Number.isFinite(entry.checkedAt);
    const fresh = (entry, ttl) => valid(entry) && clock() - entry.checkedAt < ttl && entry.checkedAt <= clock() + 60000;
    async function read(keys) {
      let stored = {};
      let readFailed = false;
      try { stored = await storage.get(keys); } catch { warning = true; readFailed = true; }
      const result = {};
      for (const key of keys) {
        const local = memory.get(key);
        const entry = stored[key];
        result[key] = (readFailed || unpersisted.has(key)) && valid(local)
          && (!valid(entry) || local.checkedAt > entry.checkedAt) ? local : entry;
      }
      return result;
    }
    async function write(key, value) {
      memory.set(key, value);
      try { await storage.set({ [key]: value }); unpersisted.delete(key); }
      catch { warning = true; unpersisted.add(key); }
    }
    async function locked(key, signal, action) {
      signal?.throwIfAborted();
      if (!locks) return action();
      return locks.request(`${namespace}:${key}`, { signal }, action);
    }
    function channelsFrom(entry) {
      return valid(entry) && Array.isArray(entry.channels) ? entry.channels.filter(channel =>
        /^UC[\w-]{22}$/.test(channel?.id) && Array.isArray(channel.aliases)) : null;
    }
    function videosFrom(entry, channelId) {
      if (!valid(entry) || !Array.isArray(entry.videos)) return null;
      return selectVideos(entry.videos.filter(video => video?.channelId === channelId && typeof video.title === "string"), new Date(clock()));
    }
    async function readView(account, channels) {
      if (!account) return null;
      let subscriptions;
      if (!channels) {
        const key = subscriptionsKey(account);
        subscriptions = (await read([key]))[key];
        channels = channelsFrom(subscriptions);
        if (!channels) return null;
      }
      const entries = await read(channels.map(channel => videoKey(account, channel.id)));
      const videos = [];
      const pending = [];
      let nextCheckAt = Infinity;
      for (const channel of channels) {
        const entry = entries[videoKey(account, channel.id)];
        const saved = videosFrom(entry, channel.id);
        if (saved) videos.push(...saved);
        nextCheckAt = Math.min(nextCheckAt, valid(entry) ? entry.checkedAt + VIDEOS_TTL : clock());
        if (!saved || !fresh(entry, VIDEOS_TTL)) pending.push(channel);
      }
      return { channels, videos, pending, entries, nextCheckAt, checkedAt: subscriptions?.checkedAt || 0,
        subscriptionsFresh: fresh(subscriptions, SUBSCRIPTIONS_TTL) };
    }
    async function getChannels(account, { signal, force = false } = {}) {
      if (!account) return { channels: await fetchChannels({ signal }), checkedAt: clock() };
      const key = subscriptionsKey(account);
      const baseline = (await read([key]))[key];
      return locked(key, signal, async () => {
        const current = (await read([key]))[key];
        const channels = channelsFrom(current);
        if (channels && fresh(current, SUBSCRIPTIONS_TTL) && (!force || current.checkedAt > (baseline?.checkedAt || 0))) return current;
        const loaded = await fetchChannels({ signal });
        signal?.throwIfAborted();
        const entry = { schema: 1, channels: loaded, checkedAt: Math.max(clock(), (current?.checkedAt || 0) + 1) };
        await write(key, entry);
        return entry;
      });
    }
    async function getChannel(account, channel, { signal, force = false, ...settings } = {}) {
      if (!account) return fetchVideos(channel, { ...settings, signal, account: null, force });
      const key = videoKey(account, channel.id);
      const baseline = (await read([key]))[key];
      return locked(key, signal, async () => {
        const current = (await read([key]))[key];
        const saved = videosFrom(current, channel.id);
        if (saved && fresh(current, VIDEOS_TTL) && (!force || current.checkedAt > (baseline?.checkedAt || 0))) return saved;
        const videos = await fetchVideos(channel, { ...settings, signal, account, force, knownVideos: saved || [] });
        signal?.throwIfAborted();
        await write(key, { schema: 1, checkedAt: Math.max(clock(), (current?.checkedAt || 0) + 1), videos });
        return videos;
      });
    }
    async function refreshVideos(account, channels, { signal, force = false, onProgress = () => {}, view, ...settings } = {}) {
      const cached = view || await readView(account, channels);
      const pending = force || !cached ? channels : cached.pending;
      const alreadyCompleted = channels.length - pending.length;
      const result = await collectVideos(pending, { ...settings, signal,
        seedVideos: cached?.videos || [],
        loadChannel: (channel, options) => getChannel(account, channel, { ...options, force }),
        onProgress: progress => onProgress({ ...progress, completed: alreadyCompleted + progress.completed, total: channels.length })
      });
      return { ...result, completed: channels.length, total: channels.length };
    }
    return { readView, getChannels, getChannel, refreshVideos, get warning() { return warning; } };
  }

  root.YTSubscriptionFilterCache = { accountKey, createCache, SUBSCRIPTIONS_TTL, VIDEOS_TTL, PREFIX };
  if (typeof module !== "undefined" && module.exports) module.exports = root.YTSubscriptionFilterCache;
})(globalThis);
