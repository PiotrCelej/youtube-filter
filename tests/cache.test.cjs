"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("../extension/core.js");
require("../extension/subscriptions.js");
require("../extension/uploads.js");
const { createCache, accountKey, SUBSCRIPTIONS_TTL, VIDEOS_TTL } = require("../extension/cache.js");
const f = require("./uploads-fixtures.cjs");
const A = { id: f.A, name: "A", aliases: [`/channel/${f.A}`] };
const B = { id: f.B, name: "B", aliases: [`/channel/${f.B}`] };
const NOW = Date.parse("2026-11-06T12:00:00Z");
function storage() {
  const data = {};
  return { data,
    async get(keys) { return structuredClone(Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]]))); },
    async set(entries) { Object.assign(data, structuredClone(entries)); }
  };
}
function locks() {
  const queue = new Map();
  return { request(key, { signal }, action) {
    const result = (queue.get(key) || Promise.resolve()).catch(() => {}).then(() => { signal?.throwIfAborted(); return action(); });
    queue.set(key, result);
    return result;
  } };
}
function setup(overrides = {}) {
  let timestamp = NOW;
  let subscriptions = 0;
  const videoRequests = [];
  const sharedStorage = storage();
  const sharedLocks = locks();
  const settings = { storage: sharedStorage, locks: sharedLocks, clock: () => timestamp,
    fetchChannels: async () => { subscriptions++; return [A, B]; },
    fetchVideos: async channel => { videoRequests.push(channel.id); return [f.video(channel.id === f.A ? 1 : 2, "2026-11-01", channel.id)]; },
    ...overrides };
  return { settings, cache: createCache(settings), sharedStorage, videoRequests,
    get subscriptions() { return subscriptions; }, advance(milliseconds) { timestamp += milliseconds; } };
}

test("cache identity requires a stable account and separates users and brand accounts without storing raw IDs", async () => {
  const first = await accountKey({ LOGGED_IN: true, DATASYNC_ID: "account-A||" });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, await accountKey({ DATASYNC_ID: "account-A||", SESSION_INDEX: "2" }));
  assert.notEqual(first, await accountKey({ DATASYNC_ID: "account-B||" }));
  assert.notEqual(first, await accountKey({ DATASYNC_ID: "account-A||", DELEGATED_SESSION_ID: "brand" }));
  assert.equal(await accountKey({ SESSION_INDEX: "0" }), null);
  assert.equal(await accountKey({ DATASYNC_ID: "account-A||", LOGGED_IN: false }), null);
});

test("a new page immediately restores persisted channels and videos without any network fetch", async () => {
  const state = setup();
  await state.cache.getChannels("account-A");
  await state.cache.refreshVideos("account-A", [A, B]);
  const reopened = createCache(state.settings);
  const saved = await reopened.readView("account-A");
  assert.equal(saved.channels.length, 2);
  assert.equal(saved.videos.length, 2);
  assert.equal(saved.pending.length, 0);
  await reopened.getChannels("account-A");
  await reopened.refreshVideos("account-A", saved.channels, { view: saved });
  assert.equal(state.subscriptions, 1);
  assert.equal(state.videoRequests.length, 2);
});

test("stale entries remain displayable while refresh is pending and are replaced only on success", async () => {
  const state = setup();
  await state.cache.getChannels("account-A");
  await state.cache.refreshVideos("account-A", [A, B]);
  state.advance(VIDEOS_TTL + 1);
  let release;
  const refreshed = createCache({ ...state.settings, fetchVideos: async channel => {
    await new Promise(resolve => { release = resolve; });
    return [f.video(9, "2026-11-06T10:00:00Z", channel.id)];
  } });
  const saved = await refreshed.readView("account-A");
  assert.equal(saved.videos.length, 2);
  assert.equal(saved.pending.length, 2);
  const pending = refreshed.getChannel("account-A", A);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await refreshed.readView("account-A")).videos.length, 2);
  release();
  await pending;
  assert.ok((await refreshed.readView("account-A")).videos.some(video => video.id === f.id(9)));
});

test("refresh skips fresh channels and fetches only new or expired channels", async () => {
  const state = setup();
  await state.cache.getChannel("account-A", A);
  await state.cache.refreshVideos("account-A", [A, B]);
  assert.deepEqual(state.videoRequests, [f.A, f.B]);
  state.advance(VIDEOS_TTL + 1);
  await state.cache.refreshVideos("account-A", [A]);
  assert.deepEqual(state.videoRequests, [f.A, f.B, f.A]);
});

test("parallel tabs share one fetch for both the subscription list and each video's channel", async () => {
  const state = setup();
  const second = createCache(state.settings);
  await Promise.all([state.cache.getChannels("account-A"), second.getChannels("account-A")]);
  await Promise.all([state.cache.getChannel("account-A", A), second.getChannel("account-A", A)]);
  assert.equal(state.subscriptions, 1);
  assert.deepEqual(state.videoRequests, [f.A]);
});

test("manual refresh bypasses freshness; simultaneous manual refreshes still share their fetch", async () => {
  const state = setup();
  await state.cache.getChannel("account-A", A);
  const second = createCache(state.settings);
  await Promise.all([state.cache.getChannel("account-A", A, { force: true }), second.getChannel("account-A", A, { force: true })]);
  assert.deepEqual(state.videoRequests, [f.A, f.A]);
});

test("account partitions and a changed subscription list never return other accounts' or unsubscribed channels' videos", async () => {
  const state = setup();
  await state.cache.getChannels("account-A");
  await state.cache.refreshVideos("account-A", [A, B]);
  assert.equal(await state.cache.readView("account-B"), null);
  assert.equal((await state.cache.readView("account-A", [A])).videos.length, 1);
  assert.equal((await state.cache.readView("account-A", [A])).videos[0].channelId, f.A);
});

test("network failures preserve old videos and report an incomplete refresh", async () => {
  const state = setup();
  await state.cache.getChannel("account-A", A);
  state.advance(VIDEOS_TTL + 1);
  const failing = createCache({ ...state.settings, fetchVideos: async () => { throw new Error("HTTP 503"); } });
  const result = await failing.refreshVideos("account-A", [A]);
  assert.equal(result.videos.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal((await failing.readView("account-A", [A])).videos.length, 1);
});

test("cached results are reselected at the current month's boundary instead of blindly keeping old fallback flags", async () => {
  const state = setup({ fetchVideos: async () => [f.video(1, "2026-10-20"), f.video(2, "2026-10-10")] });
  await state.cache.getChannel("account-A", A);
  state.advance(45 * 86400000);
  const videos = (await state.cache.readView("account-A", [A])).videos;
  assert.equal(videos.length, 1);
  assert.equal(videos[0].id, f.id(1));
  assert.equal(videos[0].fallback, true);
});

test("subscription TTL is independent of the longer video TTL", async () => {
  const state = setup();
  await state.cache.getChannels("account-A");
  await state.cache.getChannel("account-A", A);
  state.advance(SUBSCRIPTIONS_TTL + 1);
  await state.cache.getChannels("account-A");
  await state.cache.getChannel("account-A", A);
  assert.equal(state.subscriptions, 2);
  assert.equal(state.videoRequests.length, 1);
});

test("unavailable persistent storage does not block fetching or using in-memory results", async () => {
  const state = setup({ storage: { async get() { throw new Error("Unavailable"); }, async set() { throw new Error("Quota"); } } });
  await state.cache.getChannels("account-A");
  await state.cache.getChannel("account-A", A);
  assert.equal((await state.cache.readView("account-A")).videos.length, 1);
  assert.equal(state.cache.warning, true);
});

test("a worker's storage updates are authoritative even when a tab has an older in-memory copy", async () => {
  const state = setup();
  await state.cache.getChannel("account-A", A);
  const key = Object.keys(state.sharedStorage.data).find(key => key.endsWith(`:videos:${f.A}`));
  state.sharedStorage.data[key] = { schema: 1, checkedAt: NOW - 3600000, videos: [f.video(9, "2026-11-01")] };
  const view = await state.cache.readView("account-A", [A]);
  assert.equal(view.videos[0].id, f.id(9));
  assert.equal(view.pending.length, 1);
});

test("aborted refreshes cannot overwrite successful persistent entries", async () => {
  const controller = new AbortController();
  const state = setup({ fetchVideos: async () => { controller.abort(); return [f.video(1, "2026-11-01")]; } });
  await assert.rejects(state.cache.getChannel("account-A", A, { signal: controller.signal }), { name: "AbortError" });
  assert.equal((await state.cache.readView("account-A", [A])).videos.length, 0);
});
