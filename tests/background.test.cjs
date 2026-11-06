"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
require("../extension/core.js");
require("../extension/subscriptions.js");
const uploads = require("../extension/uploads.js");
const f = require("./uploads-fixtures.cjs");
const source = fs.readFileSync(require.resolve("../extension/background.js"), "utf8");
const origin = "https://www.youtube.com";

function worker(fetcher, enabled = true) {
  const listener = { addListener() {} };
  let loadChannel;
  const context = vm.createContext({
    importScripts() {}, URL, AbortController, DOMException, setTimeout, clearTimeout,
    fetch: fetcher, navigator: { locks: {} }, console,
    chrome: {
      storage: { local: { get: async () => ({ enabled }) }, onChanged: listener },
      runtime: { id: "test", onStartup: listener, onInstalled: listener, onMessage: listener },
      alarms: { onAlarm: listener }
    },
    YTSubscriptionFilterCache: { createCache(settings) { loadChannel = settings.fetchVideos; return {}; } },
    YTSubscriptionFilterUploads: uploads,
    YTSubscriptionFilterStartup: { createStartupRefresher: () => ({ resume: async () => {} }) }
  });
  vm.runInContext(source, context);
  return { request: context.youtubeFetch, loadChannel };
}

test("background playlist fallback uses browser consent cookies for HTML and publication dates", async () => {
  const item = f.video(1, "2026-08-01");
  const paths = [];
  const { loadChannel } = worker(async (url, settings) => {
    const path = new URL(url).pathname;
    paths.push(path);
    // Model YouTube in an EU region: anonymous HTML is redirected to consent.
    if (settings.credentials !== "include") return { type: "opaqueredirect", status: 0 };
    assert.equal(settings.redirect, "manual");
    if (path === "/feeds/videos.xml") return { ok: false, status: 404, text: async () => "" };
    if (path === "/playlist") return f.response(f.modernPlaylist([item]));
    if (path === "/watch") return f.response(f.watch(item));
    throw new Error("Unexpected request");
  });
  const result = await loadChannel({ id: f.A }, { now: new Date("2026-11-06T12:00:00Z") });
  assert.deepEqual(paths, ["/feeds/videos.xml", "/playlist", "/watch"]);
  assert.equal(result[0].id, item.id);
  assert.equal(result[0].fallback, true);
});

test("background continuation preserves the POST payload and headers while including browser cookies", async () => {
  const body = JSON.stringify({ continuation: "next" });
  const headers = { "Content-Type": "application/json" };
  const { request } = worker(async (url, settings) => {
    assert.equal(url, `${origin}/youtubei/v1/browse`);
    assert.equal(settings.method, "POST");
    assert.equal(settings.body, body);
    assert.equal(settings.headers, headers);
    assert.equal(settings.credentials, "include");
    assert.equal(settings.redirect, "manual");
    return { ok: true, status: 200, text: async () => '{"contents":[]}' };
  });
  const response = await request(`${origin}/youtubei/v1/browse`, { method: "POST", body, headers });
  assert.equal(Array.isArray((await response.json()).contents), true);
  assert.equal((await response.json()).contents.length, 0);
});

test("a redirect yields an actionable error without reading the consent page", async () => {
  for (const response of [{ type: "opaqueredirect", status: 0 }, { status: 302 }]) {
    const { request } = worker(async () => ({ ...response, text() { assert.fail("Do not read redirects"); } }));
    await assert.rejects(request(`${origin}/playlist?list=UU${f.A.slice(2)}`), /Otwórz YouTube.*zgód.*odśwież filmy/);
  }
});

test("background requests reject origins outside the YouTube host permissions", async () => {
  const { request } = worker(() => assert.fail("Do not send cookies to another origin"));
  await assert.rejects(request("https://consent.youtube.com/m"), /Nieprawidłowy adres/);
  await assert.rejects(request("https://www.youtube.com.example.org/playlist"), /Nieprawidłowy adres/);
});

test("disabled background requests do not fetch; cancellation also covers the response body", async () => {
  const disabled = worker(() => assert.fail("Disabled filter must not fetch"), false);
  await assert.rejects(disabled.request(`${origin}/playlist`), { name: "AbortError" });
  const controller = new AbortController();
  const { request } = worker(async (_, settings) => ({
    ok: true, status: 200,
    text: () => new Promise((resolve, reject) => {
      settings.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      controller.abort();
    })
  }));
  await assert.rejects(request(`${origin}/playlist`, { signal: controller.signal }), { name: "AbortError" });
});
