"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("../extension/core.js");
require("../extension/subscriptions.js");
require("../extension/uploads.js");
const { createCache, PREFIX } = require("../extension/cache.js");
const { createStartupRefresher, STATE_KEY, ALARM } = require("../extension/startup.js");
const f = require("./uploads-fixtures.cjs");
const ACCOUNT = "a".repeat(64);
const CHANNEL = { id: f.A, name: "A", aliases: [`/channel/${f.A}`] };
function harness({ channels = [CHANNEL], fail = false, maxBatches, load } = {}) {
  const data = { [`${PREFIX}${ACCOUNT}:subscriptions`]: { schema: 1, checkedAt: Date.now(), channels } };
  const storage = {
    async get(keys) {
      if (keys === null) return structuredClone(data);
      if (typeof keys === "string") return { [keys]: structuredClone(data[keys]) };
      if (Array.isArray(keys)) return structuredClone(Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]])));
      return { ...keys, ...structuredClone(Object.fromEntries(Object.keys(keys).filter(key => key in data).map(key => [key, data[key]]))) };
    },
    async set(entries) { Object.assign(data, structuredClone(entries)); }
  };
  const scheduled = new Map();
  const alarms = { async create(name, value) { scheduled.set(name, value); }, async clear(name) { scheduled.delete(name); } };
  const calls = [];
  const cache = createCache({ storage, fetchVideos: async (channel, options) => {
    calls.push(channel.id);
    if (load) return load(channel, options);
    if (fail) throw new Error("Offline");
    return [f.video(1, new Date(Date.now() - 86400000).toISOString(), channel.id)];
  } });
  return { data, storage, scheduled, calls, cache,
    runner: createStartupRefresher({ storage, alarms, cache, maxBatches }) };
}

test("startup fills cached videos for saved subscriptions without a page or document", async () => {
  const state = harness();
  await state.runner.run("browser-startup", true);
  assert.deepEqual(state.calls, [f.A]);
  assert.equal((await state.cache.readView(ACCOUNT)).videos.length, 1);
  assert.equal(state.data[STATE_KEY].reason, "browser-startup");
  assert.equal(state.data[STATE_KEY].queue.length, 0);
  assert.ok(state.data[STATE_KEY].finishedAt);
  assert.equal(state.scheduled.has(ALARM), false);
});

test("a fresh cache avoids repeat fetching on browser restarts", async () => {
  const state = harness();
  await state.runner.run("browser-startup", true);
  await state.runner.run("browser-startup", true);
  assert.deepEqual(state.calls, [f.A]);
});

test("disabled filtering never starts startup network work", async () => {
  const state = harness();
  state.data.enabled = false;
  await state.runner.run("browser-startup", true);
  assert.deepEqual(state.calls, []);
  assert.equal(state.scheduled.size, 0);
});

test("a first installation without saved subscriptions requires no network or browser tab", async () => {
  const state = harness();
  delete state.data[`${PREFIX}${ACCOUNT}:subscriptions`];
  await state.runner.run("extension-installed", true);
  assert.deepEqual(state.calls, []);
  assert.equal(state.data[STATE_KEY].queue.length, 0);
});

test("a persisted queue resumes after a worker restart and removes its alarm when finished", async () => {
  const channels = Array.from({ length: 6 }, (_, i) => ({ ...CHANNEL, id: `UC${String(i).padStart(22, "0")}` }));
  const state = harness({ channels, maxBatches: 1 });
  await state.runner.run("browser-startup", true);
  assert.equal(state.calls.length, 4);
  assert.equal(state.data[STATE_KEY].queue.length, 2);
  assert.equal(state.scheduled.has(ALARM), true);
  await state.runner.resume();
  assert.equal(state.calls.length, 6);
  assert.equal(state.data[STATE_KEY].queue.length, 0);
  assert.equal(state.scheduled.has(ALARM), false);
});

test("startup events and alarms cannot create overlapping refresh runs", async () => {
  let release;
  const state = harness({ load: async () => {
    await new Promise(resolve => { release = resolve; });
    return [];
  } });
  const first = state.runner.run("browser-startup", true);
  const second = state.runner.run("alarm");
  assert.equal(first, second);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release();
  await first;
  assert.equal(state.calls.length, 1);
});

test("offline channels retry once through the alarm while preserving old cache", async () => {
  const state = harness({ fail: true });
  const key = `${PREFIX}${ACCOUNT}:videos:${f.A}`;
  state.data[key] = { schema: 1, checkedAt: Date.now() - 3600000, videos: [f.video(1, new Date().toISOString())] };
  await state.runner.run("browser-startup", true);
  assert.equal(state.calls.length, 1);
  assert.equal(state.data[STATE_KEY].queue[0].attempts, 1);
  assert.equal(state.scheduled.has(ALARM), true);
  await state.runner.run("alarm");
  assert.equal(state.calls.length, 2);
  assert.equal(state.data[STATE_KEY].failed, 1);
  assert.equal(state.scheduled.has(ALARM), false);
  assert.equal(state.data[key].videos.length, 1);
});

test("a startup event racing an old resume queue still discovers newly saved subscriptions", async () => {
  let release;
  const state = harness({ load: async channel => {
    if (channel.id === f.A) await new Promise(resolve => { release = resolve; });
    return [];
  } });
  const resumed = state.runner.run("resume", true);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  state.data[`${PREFIX}${ACCOUNT}:subscriptions`].channels.push({ ...CHANNEL, id: f.B });
  const startup = state.runner.run("browser-startup", true);
  release();
  await Promise.all([resumed, startup]);
  assert.deepEqual(state.calls, [f.A, f.B]);
  assert.equal(state.data[STATE_KEY].reason, "browser-startup");
});

test("disabling filtering aborts active startup work and cancels continuation", async () => {
  const state = harness({ load: (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }) });
  const pending = state.runner.run("browser-startup", true);
  while (!state.calls.length) await new Promise(resolve => setImmediate(resolve));
  state.data.enabled = false;
  await state.runner.stop();
  await pending;
  assert.equal(state.scheduled.size, 0);
  assert.equal(state.data[STATE_KEY].queue.length, 0);
  assert.equal((await state.cache.readView(ACCOUNT)).videos.length, 0);
});

test("background entrypoint registers the real browser startup event and loads only packaged code", () => {
  const vm = require("node:vm");
  const fs = require("node:fs");
  const listeners = {};
  const calls = [];
  const event = name => ({ addListener(callback) { listeners[name] = callback; } });
  const context = {
    importScripts(...files) { assert.deepEqual(files, ["core.js", "subscriptions.js", "uploads.js", "cache.js", "startup.js"]); },
    YTSubscriptionFilterCache: { createCache: () => ({}) },
    YTSubscriptionFilterUploads: { fetchChannelVideos() {} },
    YTSubscriptionFilterStartup: { ALARM, createStartupRefresher: () => ({
      async run(...args) { calls.push(args); }, async resume() {}, async stop() {}
    }) },
    navigator: {}, console,
    chrome: { runtime: { id: "test", onStartup: event("startup"), onInstalled: event("installed"), onMessage: event("message") },
      storage: { local: {}, onChanged: event("storage") }, alarms: { onAlarm: event("alarm") } }
  };
  vm.runInNewContext(fs.readFileSync(require("node:path").join(__dirname, "../extension/background.js"), "utf8"), context);
  listeners.startup();
  assert.deepEqual(calls[0], ["browser-startup", true]);
  listeners.alarm({ name: "irrelevant" });
  assert.equal(calls.length, 1);
});
