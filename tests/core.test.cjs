"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extension/core.js");
const { fetchSubscriptions, authorization } = require("../extension/subscriptions.js");
const A = "UCaaaaaaaaaaaaaaaaaaaaaa";
const B = "UCbbbbbbbbbbbbbbbbbbbbbb";
const renderer = (id, handle) => ({ channelRenderer: {
  channelId: id, title: { simpleText: "Identical display name" },
  navigationEndpoint: { browseEndpoint: { browseId: id, canonicalBaseUrl: `/@${handle}` } }
} });
const continuation = token => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
const data = items => ({ contents: { twoColumnBrowseResultsRenderer: { tabs: [
  { tabRenderer: { selected: true, content: { sectionListRenderer: { contents: items } } } }
] } } });
const config = { LOGGED_IN: true, SESSION_INDEX: "2", DELEGATED_SESSION_ID: "brand-account", INNERTUBE_CONTEXT: { client: { clientVersion: "test", clientName: "WEB" } } };
function page(initial, settings = config) {
  return `<script>ytcfg.set(${JSON.stringify(settings)});</script><script>var ytInitialData = ${JSON.stringify(initial)};</script>`;
}
const htmlResponse = html => ({ ok: true, url: "https://www.youtube.com/feed/channels", text: async () => html });
const nextResponse = items => ({ ok: true, json: async () => ({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items } }] }) });

test("parse embedded JSON with escaped quotes and braces without executing page scripts", () => {
  const initial = data([renderer(A, 'braces{and}quotes"')]);
  assert.deepEqual(core.parsePage(page(initial)).initial, initial);
  assert.deepEqual(core.parsePage(`window['ytInitialData'] = ${JSON.stringify(initial)};ytcfg.set({"LOGGED_IN":true});ytcfg.set({"SESSION_INDEX":3});`).config,
    { LOGGED_IN: true, SESSION_INDEX: 3 });
  assert.throws(() => core.parsePage("<script>alert('not JSON')</script>"));
  assert.throws(() => core.jsonAt('{"a":', 0));
});

test("non-JSON YouTube bootstrap config does not block valid subscription data or account config", () => {
  const initial = data([renderer(A, "creator")]);
  const bootstrap = `<script>ytcfg.set({"SERVICE_NAME": 'youtube', "OPTIONS": {'label': 'bootstrap {not JSON}'},});</script>`;
  const optional = `<script>ytcfg.set({"SERVICE_WORKER": 'youtube'});</script>`;
  const result = core.parsePage(bootstrap + page(initial) + optional);
  assert.deepEqual(result.initial, initial);
  assert.deepEqual(result.config, config);
});

test("unsupported JavaScript config is skipped without executing expressions", () => {
  globalThis.ytsfParserExecutedCode = false;
  try {
    const source = `<script>ytcfg.set({"SERVICE_NAME": (globalThis.ytsfParserExecutedCode = true)});</script>` + page(data([]));
    assert.deepEqual(core.parsePage(source).config, config);
    assert.equal(globalThis.ytsfParserExecutedCode, false);
  } finally {
    delete globalThis.ytsfParserExecutedCode;
  }
});

test("subscriptions with JavaScript bootstrap config still paginate using valid JSON config", async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return htmlResponse(`<script>ytcfg.set({"SERVICE_NAME": 'youtube'});</script>`
        + page(data([renderer(A, "first"), continuation("next")])));
    }
    return nextResponse([renderer(B, "second")]);
  };
  const channels = await fetchSubscriptions({ fetcher, cookie: "", origin: "https://www.youtube.com" });
  assert.equal(channels.length, 2);
  assert.equal(requests[1].options.headers["X-Goog-AuthUser"], "2");
  assert.equal(requests[1].options.headers["X-Goog-PageId"], "brand-account");
});

test("channel identifiers are case sensitive; handles normalize case, encoding and tabs", () => {
  assert.equal(core.channelKey(`https://www.youtube.com/channel/${A}/videos?x=1`), `/channel/${A}`);
  assert.equal(core.channelKey("/@ZA%C5%BB%C3%93%C5%81%C4%86/videos"), "/@zażółć");
  assert.equal(core.channelKey("https://youtube.com/@Creator/"), "/@creator");
  for (const value of ["https://evil.example/@creator", "https://www.youtube.com.evil.example/@creator", "javascript:alert(1)", "/watch?v=123", "/channel/UCshort", "/@bad%XX"]) assert.equal(core.channelKey(value), null);
});

test("subscription extraction excludes guide links and unselected tabs", () => {
  const initial = data([renderer(A, "creator")]);
  initial.guide = renderer(B, "not-subscribed");
  initial.contents.twoColumnBrowseResultsRenderer.tabs.push({ tabRenderer: { selected: false, content: renderer(B, "other") } });
  const result = core.readChannels(core.feedRoots(initial));
  assert.equal(result.channels.length, 1);
  const index = core.makeIndex(result.channels);
  assert.equal(core.isSubscribed(["/@CREATOR"], index), true);
  assert.equal(core.isSubscribed([`/channel/${A}`], index), true);
  assert.equal(core.isSubscribed(["/@not-subscribed"], index), false);
  assert.equal(core.isSubscribed([`/channel/${B}`], index), false);
  assert.equal(core.isSubscribed([], index), false);
});

test("new channel lockups and plain handle labels are supported", () => {
  const root = [{ lockupViewModel: { contentType: "LOCKUP_CONTENT_TYPE_CHANNEL", contentId: A, navigation: { url: "/@new" } } },
    { channelRenderer: { channelId: B, channelHandleText: { simpleText: "@label" } } }];
  const index = core.makeIndex(core.readChannels([root]).channels);
  assert.equal(core.isSubscribed(["/@new"], index), true);
  assert.equal(core.isSubscribed(["/@label"], index), true);
});

test("read all subscription pages, retain selected account and use only YouTube requests", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return htmlResponse(page(data([renderer(A, "first"), continuation("next")])));
    return nextResponse([renderer(B, "second")]);
  };
  const channels = await fetchSubscriptions({ fetcher, cookie: "", origin: "https://www.youtube.com" });
  assert.equal(channels.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers["X-Goog-AuthUser"], "2");
  assert.equal(calls[1].options.headers["X-Goog-PageId"], "brand-account");
  assert.equal(JSON.parse(calls[1].options.body).continuation, "next");
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, "https://www.youtube.com");
    assert.equal(call.options.credentials, "same-origin");
  }
});

test("duplicate channel identities across pages merge aliases", async () => {
  let request = 0;
  const fetcher = async () => ++request === 1
    ? htmlResponse(page(data([renderer(A, "old"), continuation("next")])))
    : nextResponse([renderer(A, "new")]);
  const channels = await fetchSubscriptions({ fetcher, cookie: "", origin: "https://www.youtube.com" });
  assert.equal(channels.length, 1);
  assert.equal(core.isSubscribed(["/@old"], core.makeIndex(channels)), true);
  assert.equal(core.isSubscribed(["/@new"], core.makeIndex(channels)), true);
});

test("empty subscriptions are valid; signed-out, consent and unknown formats fail explicitly", async () => {
  const read = response => fetchSubscriptions({ fetcher: async () => response, cookie: "", origin: "https://www.youtube.com" });
  assert.deepEqual(await read(htmlResponse(page(data([])))), []);
  await assert.rejects(read(htmlResponse(page(data([]), { LOGGED_IN: false }))), /Zaloguj/);
  await assert.rejects(read(htmlResponse(page({ contents: {} }))), /rozpoznać/);
  await assert.rejects(read({ ok: true, url: "https://consent.youtube.com/" }), /zgód/);
  await assert.rejects(read({ ok: false, status: 503 }), /503/);
});

test("partial failures, malformed continuation and looping pagination never return a partial allowlist", async () => {
  for (const next of [{ ok: false, status: 403 }, { ok: true, json: async () => ({}) }, nextResponse([continuation("same")])]) {
    let request = 0;
    const fetcher = async () => ++request === 1 ? htmlResponse(page(data([renderer(A, "first"), continuation("same")]))) : next;
    await assert.rejects(fetchSubscriptions({ fetcher, cookie: "", origin: "https://www.youtube.com" }));
  }
});

test("abort propagates so disabling the filter can cancel network work", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetcher = async (_, options) => { options.signal.throwIfAborted(); };
  await assert.rejects(fetchSubscriptions({ fetcher, signal: controller.signal, cookie: "", origin: "https://www.youtube.com" }), { name: "AbortError" });
});

test("request signing hashes session cookies, never includes their raw value", async () => {
  const value = await authorization("SAPISID=secret-test-cookie; other=value", { USER_SESSION_ID: "user-id" }, "https://www.youtube.com");
  assert.match(value, /^SAPISIDHASH \d+_[a-f0-9]{40}_u$/);
  assert.equal(value.includes("secret-test-cookie"), false);
  const [, signed] = value.split(" ");
  const timestamp = signed.split("_")[0];
  const hash = require("node:crypto").createHash("sha1").update(`user-id ${timestamp} secret-test-cookie https://www.youtube.com`).digest("hex");
  assert.equal(value, `SAPISIDHASH ${timestamp}_${hash}_u`);
});

test("manifest is restricted to desktop YouTube and contains all packaged references", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const folder = path.join(__dirname, "..", "extension");
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal(manifest.host_permissions.length, 2);
  for (const script of manifest.content_scripts) for (const filename of [...script.js, ...script.css]) assert.ok(fs.existsSync(path.join(folder, filename)));
  assert.ok(fs.existsSync(path.join(folder, manifest.action.default_popup)));
});
