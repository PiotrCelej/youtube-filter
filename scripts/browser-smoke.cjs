"use strict";
// Real Chromium/Brave integration checks using CDP and offline YouTube fixtures.
// Usage: node scripts/browser-smoke.cjs /path/to/brave
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const uploadFixtures = require("../tests/uploads-fixtures.cjs");
const { EventEmitter } = require("node:events");
const root = path.resolve(__dirname, "..");
const executable = process.argv[2] || process.env.BRAVE_PATH;
if (!executable) throw new Error("Pass the Brave executable path as the first argument or BRAVE_PATH.");
const profile = path.join(root, ".test-profile", `run-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(path.join(root, ".test-output"), { recursive: true });
const resultPath = path.join(root, ".test-output", "browser-results.txt");
fs.writeFileSync(resultPath, "Starting offline Brave checks…\n");
const report = (...values) => {
  const message = values.map(value => value instanceof Error ? value.stack : String(value)).join(" ");
  fs.appendFileSync(resultPath, `${message}\n`);
  process.stdout.write(`${message}\n`);
};
const log = fs.openSync(path.join(root, ".test-output", "browser.log"), "w");
const extension = path.join(root, "extension");
const browser = spawn(executable, [
  "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0",
  `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
  "--disable-component-update", "--disable-sync", "about:blank"
], { windowsHide: true, stdio: ["ignore", log, log] });
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let launchError;
browser.on("error", cause => { launchError = cause; });

class CDP extends EventEmitter {
  constructor(url) {
    super();
    this.socket = new WebSocket(url);
    this.next = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timeout);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else this.emit(message.method, message.params);
    });
  }
  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

const A = "UCaaaaaaaaaaaaaaaaaaaaaa";
const B = "UCbbbbbbbbbbbbbbbbbbbbbb";
const channel = (id, handle) => ({ channelRenderer: { channelId: id, navigationEndpoint: { browseEndpoint: { browseId: id, canonicalBaseUrl: `/@${handle}` } } } });
const token = { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "second-page" } } } };
const initial = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: {
  selected: true, content: { sectionListRenderer: { contents: [channel(A, "first"), token] } }
} }] } } };
const config = { LOGGED_IN: true, INNERTUBE_CONTEXT: { client: { clientVersion: "offline-test" } } };
const daysAgo = days => new Date(Date.now() - days * 86400000).toISOString();
const channelUploads = {
  [A]: [uploadFixtures.video(1, daysAgo(2)), uploadFixtures.video(2, daysAgo(15)), uploadFixtures.video(3, daysAgo(60))],
  [B]: [uploadFixtures.video(4, daysAgo(60), B), uploadFixtures.video(5, daysAgo(90), B)]
};
function subscriptionsPage() {
  // Match the real bootstrap syntax from the reported Brave parsing failure.
  return `<script>ytcfg.set({"SERVICE_NAME": 'youtube',});</script>`
    + `<script>ytcfg.set(${JSON.stringify(config)});</script><script>var ytInitialData = ${JSON.stringify(initial)};</script>`
    + `<script>ytcfg.set({"SERVICE_WORKER": 'youtube'});</script>`;
}
function card(id, author, extra = "") {
  const thumbnail = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#245c43"/><path d="M140 60v60l50-30z" fill="#e6f3ea"/></svg>').toString("base64")}`;
  return `<ytd-rich-item-renderer id="${id}"><a href="/watch?v=${id}"><img src="${thumbnail}" alt="${id} thumbnail">Video ${id}</a>${author ? `<ytd-channel-name><a href="${author}">Channel</a></ytd-channel-name>` : ""}${extra}</ytd-rich-item-renderer>`;
}
const modernCard = card("modern", "/@second")
  .replaceAll("ytd-rich-item-renderer", "yt-lockup-view-model")
  .replaceAll("<ytd-channel-name>", '<div class="yt-content-metadata-view-model__metadata-row">').replaceAll("</ytd-channel-name>", "</div>");
const home = `<!doctype html><html><head><meta charset="utf-8"><script>globalThis.ytcfg={set(){}};ytcfg.set({"LOGGED_IN":true,"DATASYNC_ID":"offline-account-A||"});</script><style>
body { margin: 8px; font: 14px system-ui; } ytd-app, ytd-browse, ytd-rich-grid-renderer { display:block; }
ytd-rich-grid-row > #contents { display:flex; min-height:180px; }
ytd-rich-item-renderer, yt-lockup-view-model { display:block; width:300px; margin:12px; }
img { display:block; width:100%; aspect-ratio:16 / 9; border-radius:10px; }
a { color: #173e2d; text-decoration: none; }
</style></head><body><ytd-app>
<ytd-browse page-subtype="home"><ytd-rich-grid-renderer><div id="contents">
<ytd-rich-grid-row><div id="contents">
${card("subscribed", "/@first")}${card("other", "/@stranger")}${card("unknown", null)}
</div></ytd-rich-grid-row><ytd-rich-grid-row><div id="contents">
${card("second-page", `/channel/${B}`)}${card("ad", "/@first", "<ytd-ad-slot-renderer></ytd-ad-slot-renderer>")}
<ytd-rich-section-renderer id="shorts">Shorts shelf</ytd-rich-section-renderer>
</div></ytd-rich-grid-row>
${modernCard}<ytd-mystery-renderer id="unrecognized">Unverified recommendation</ytd-mystery-renderer>
<ytd-continuation-item-renderer id="continuation"></ytd-continuation-item-renderer>
</div></ytd-rich-grid-renderer></ytd-browse></ytd-app></body></html>`;

async function run() {
  const portFile = path.join(profile, "DevToolsActivePort");
  const until = Date.now() + 20000;
  while (!fs.existsSync(portFile) && Date.now() < until) {
    if (launchError) throw launchError;
    await sleep(100);
  }
  if (!fs.existsSync(portFile)) throw new Error("Brave did not start. See .test-output/browser.log");
  const [port, browserPath] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
  const browserCDP = new CDP(`ws://127.0.0.1:${port}${browserPath}`);
  let tab;
  let worker;
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(item => item.type === "page");
    tab = new CDP(target.webSocketDebuggerUrl);
    const contexts = new Map();
    const exceptions = [];
    tab.on("Runtime.executionContextCreated", ({ context }) => contexts.set(context.id, context));
    tab.on("Runtime.executionContextsCleared", () => contexts.clear());
    tab.on("Runtime.exceptionThrown", event => exceptions.push(event.exceptionDetails));
    await tab.send("Runtime.enable");
    await tab.send("Page.enable");
    let failRequests = false;
    let delayedResolve;
    let delayRequests = false;
    let failUploadB = false;
    let delayUploads = false;
    let useModernPlaylists = false;
    let testAccount = "offline-account-A||";
    const pendingUploads = [];
    const calls = [];
    async function intercept(client) {
    client.on("Fetch.requestPaused", async event => {
      try {
        const url = new URL(event.request.url);
        calls.push(url.pathname);
        let body;
        let contentType = "text/html; charset=utf-8";
        let responseCode = 200;
        if (url.hostname === "i.ytimg.com") {
          contentType = "image/svg+xml";
          body = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#245c43"/><path d="M140 60v60l50-30z" fill="#e6f3ea"/></svg>';
        } else if (url.pathname === "/feeds/videos.xml") {
          if (delayUploads) await new Promise(resolve => pendingUploads.push(resolve));
          const channelId = url.searchParams.get("channel_id");
          contentType = "application/atom+xml";
          if (useModernPlaylists) { responseCode = 404; body = "RSS unavailable"; }
          else if (failUploadB && channelId === B) { responseCode = 503; body = "unavailable"; }
          else body = uploadFixtures.atom(channelId, channelUploads[channelId] || []);
        } else if (url.pathname === "/playlist") {
          const playlist = url.searchParams.get("list");
          const channelId = `UC${playlist.slice(2)}`;
          if (failUploadB && channelId === B) { responseCode = 503; body = "unavailable"; }
          else body = uploadFixtures.modernPlaylist(channelUploads[channelId] || []);
        } else if (url.pathname === "/feed/channels") {
          if (delayRequests) await new Promise(resolve => { delayedResolve = resolve; });
          if (failRequests) { responseCode = 503; body = "unavailable"; }
          else body = subscriptionsPage();
        } else if (url.pathname === "/youtubei/v1/browse") {
          contentType = "application/json";
          body = JSON.stringify({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [channel(B, "second")] } }] });
        } else if (url.pathname === "/watch" && Object.values(channelUploads).flat().some(video => video.id === url.searchParams.get("v"))) {
          body = uploadFixtures.watch(Object.values(channelUploads).flat().find(video => video.id === url.searchParams.get("v")));
        } else if (url.pathname === "/" || url.pathname === "/watch") body = home.replace("offline-account-A||", testAccount);
        else { responseCode = 404; body = ""; }
        await client.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode,
          responseHeaders: [{ name: "Content-Type", value: contentType }], body: Buffer.from(body).toString("base64") });
      } catch (cause) {
        if (!/closed|Invalid InterceptionId|Fetch domain is not enabled/i.test(cause.message)) exceptions.push({ text: cause.message });
      }
    });
    await client.send("Fetch.enable", { patterns: [{ urlPattern: "https://*youtube.com/*" }, { urlPattern: "https://i.ytimg.com/*" }] });
    }
    await intercept(tab);
    let workerTarget;
    const workerDeadline = Date.now() + 10000;
    while (!workerTarget && Date.now() < workerDeadline) {
      const live = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      workerTarget = live.find(item => item.type === "service_worker" && item.url.endsWith("/background.js"));
      if (!workerTarget) await sleep(50);
    }
    assert.ok(workerTarget, "The startup service worker must load");
    worker = new CDP(workerTarget.webSocketDebuggerUrl);
    worker.on("Runtime.exceptionThrown", event => exceptions.push(event.exceptionDetails));
    await worker.send("Runtime.enable");
    await intercept(worker);
    await tab.send("Page.navigate", { url: "https://www.youtube.com/" });
    async function evaluate(expression, contextId) {
      const result = await tab.send("Runtime.evaluate", { expression, contextId, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + " " + (result.exceptionDetails.exception?.description || ""));
      return result.result.value;
    }
    async function waitFor(expression, contextId) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (await evaluate(expression, contextId)) return;
        await sleep(50);
      }
      throw new Error(`Timed out: ${expression}`);
    }
    let isolated;
    const deadline = Date.now() + 10000;
    while (!isolated && Date.now() < deadline) {
      for (const context of contexts.values()) {
        if (!context.auxData?.isDefault && await evaluate('Boolean(globalThis.chrome?.runtime?.id)', context.id)) isolated = context.id;
      }
      if (!isolated) await sleep(100);
    }
    assert.ok(isolated, "The extension content script must be loaded by Brave");
    await waitFor('document.getElementById("ytsf-status")?.textContent.includes("2 kanałów")');
    const visibility = () => evaluate(`Object.fromEntries([...document.querySelectorAll('ytd-rich-item-renderer,ytd-rich-section-renderer,yt-lockup-view-model,ytd-mystery-renderer')].map(card => [card.id, getComputedStyle(card).display !== 'none']))`);
    assert.deepEqual(await visibility(), { subscribed: true, other: false, unknown: false, "second-page": true, ad: false, shorts: false, modern: true, unrecognized: false });
    report("PASS initial recommendations, complete pagination, unknown authors, ads and Shorts shelves");
    await waitFor('["subscribed", "second-page", "modern"].every(id => document.querySelector(`#${id} img`).naturalWidth > 0)');
    const layout = await evaluate(`(() => {
      const ids = ['subscribed', 'second-page', 'modern'];
      window.originalThumbnails = ids.map(id => document.querySelector('#' + id + ' img'));
      return ids.map(id => {
        const card = document.getElementById(id);
        const image = card.querySelector('img');
        const rect = image.getBoundingClientRect();
        return { top: rect.top, width: rect.width, height: rect.height, link: card.querySelector('a').getAttribute('href') };
      });
    })()`);
    assert.equal(layout[0].top, layout[1].top, "Videos from different native rows must pack into one row");
    assert.ok(layout.every(item => item.width > 200 && item.height > 100 && item.link.startsWith("/watch?v=")));
    assert.equal(await evaluate('getComputedStyle(document.getElementById("continuation")).gridColumn'), "1 / -1");
    const screenshot = await tab.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(root, ".test-output", "home-filtered.png"), Buffer.from(screenshot.data, "base64"));
    report("PASS subscribed thumbnails and original video links stay visible; cards pack across native rows without gaps");

    await waitFor('document.querySelector("#ytsf-uploads .ytsf-uploads-progress")?.textContent.includes("Filmy: 3")');
    const uploads = await evaluate(`Array.from(document.querySelectorAll('#ytsf-uploads article'), card => ({
      id: card.dataset.videoId, channel: card.dataset.channelId,
      fallback: Boolean(card.querySelector('.ytsf-upload-fallback')),
      href: card.querySelector('a').getAttribute('href'), src: card.querySelector('img').src
    }))`);
    assert.deepEqual(uploads.map(video => [video.id, video.channel, video.fallback]), [
      [uploadFixtures.id(1), A, false], [uploadFixtures.id(2), A, false], [uploadFixtures.id(4), B, true]
    ]);
    assert.ok(uploads.every(video => video.href === `/watch?v=${video.id}` && video.src === `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`));
    assert.equal(await evaluate('Boolean(document.querySelector("ytd-rich-grid-renderer").compareDocumentPosition(document.getElementById("ytsf-uploads")) & Node.DOCUMENT_POSITION_FOLLOWING)'), true);
    await evaluate('document.getElementById("ytsf-uploads").scrollIntoView()');
    await waitFor('Array.from(document.querySelectorAll("#ytsf-uploads img")).every(img => img.complete && img.naturalWidth > 0)');
    const uploadsScreenshot = await tab.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(root, ".test-output", "subscription-uploads.png"), Buffer.from(uploadsScreenshot.data, "base64"));
    report("PASS section below recommendations has every recent upload, one older fallback per inactive channel, thumbnails and working video links");

    useModernPlaylists = true;
    await evaluate('document.querySelector("#ytsf-uploads button").click()');
    await waitFor('document.querySelectorAll("#ytsf-uploads article").length === 3 && !document.querySelector("#ytsf-uploads button").disabled');
    assert.equal(await evaluate('document.querySelector("#ytsf-uploads details").hidden'), true);
    assert.equal(await evaluate('document.querySelectorAll("#ytsf-uploads .ytsf-upload-fallback").length'), 1);
    useModernPlaylists = false;
    report("PASS unavailable RSS recovers via current lockupViewModel playlists and exact publication metadata");

    failUploadB = true;
    await evaluate('document.querySelector("#ytsf-uploads button").click()');
    await waitFor('document.querySelector("#ytsf-uploads .ytsf-uploads-progress")?.textContent.includes("lista jest niepełna")');
    assert.equal(await evaluate('document.querySelectorAll("#ytsf-uploads article").length'), 3);
    assert.equal((await visibility()).subscribed, true);
    assert.equal(await evaluate('document.querySelector("#ytsf-uploads details").hidden'), false);
    failUploadB = false;
    await evaluate('document.querySelector("#ytsf-uploads button").click()');
    await waitFor('document.querySelector("#ytsf-uploads .ytsf-uploads-progress")?.textContent.includes("Filmy: 3")');
    report("PASS failed background channel refresh retains cached videos, reports errors, and retry recovers");

    delayUploads = true;
    await evaluate('document.querySelector("#ytsf-uploads button").click()');
    await waitFor('document.querySelector("#ytsf-uploads .ytsf-uploads-progress")?.textContent.includes("Odświeżanie w tle")');
    await evaluate('chrome.storage.local.set({enabled:false})', isolated);
    await waitFor('document.getElementById("ytsf-uploads").hidden');
    delayUploads = false;
    for (const resolve of pendingUploads.splice(0)) resolve();
    await sleep(100);
    assert.equal(await evaluate('document.getElementById("ytsf-uploads").hidden'), true);
    assert.equal(await evaluate('document.querySelectorAll("#ytsf-uploads article").length'), 0);
    await evaluate('chrome.storage.local.set({enabled:true})', isolated);
    await waitFor('document.getElementById("subscribed").hasAttribute("data-ytsf-allowed")');
    await waitFor('document.querySelector("#ytsf-uploads .ytsf-uploads-progress")?.textContent.includes("Filmy: 3")');
    report("PASS disabling during upload loading cancels requests and clears the section; enabling loads it again");

    await evaluate(`document.getElementById('contents').insertAdjacentHTML('beforeend', ${JSON.stringify(card("dynamic-no", "/@stranger") + card("dynamic-yes", "/@second"))})`);
    await waitFor('document.getElementById("dynamic-yes").hasAttribute("data-ytsf-allowed")');
    assert.equal((await visibility())["dynamic-no"], false);
    await evaluate(`document.querySelector('#dynamic-yes ytd-channel-name a').href='/@stranger'`);
    await waitFor('document.getElementById("dynamic-yes").hasAttribute("data-ytsf-hidden")');
    report("PASS infinite-scroll cards and reused author links");

    await evaluate('chrome.storage.local.set({enabled:false})', isolated);
    await waitFor('!document.documentElement.hasAttribute("data-ytsf-active")');
    assert.ok(Object.values(await visibility()).every(Boolean));
    assert.equal(await evaluate('document.querySelector("[data-ytsf-grid]")'), null);
    assert.equal(await evaluate('getComputedStyle(document.querySelector("ytd-rich-grid-row > #contents")).display'), "flex");
    assert.equal(await evaluate('["subscribed", "second-page", "modern"].every((id, i) => document.querySelector(`#${id} img`) === window.originalThumbnails[i])'), true);
    report("PASS switch off restores every hidden card without reload");
    await evaluate('chrome.storage.local.set({enabled:true})', isolated);
    await waitFor('document.getElementById("subscribed").hasAttribute("data-ytsf-allowed")');

    await evaluate(`history.pushState({}, '', '/watch?v=test'); document.dispatchEvent(new Event('yt-navigate-finish'))`);
    await waitFor('!document.documentElement.hasAttribute("data-ytsf-active") && !document.querySelector("[data-ytsf-hidden]")');
    assert.ok(Object.values(await visibility()).every(Boolean));
    await evaluate(`history.pushState({}, '', '/'); document.dispatchEvent(new Event('yt-navigate-finish'))`);
    await waitFor('document.getElementById("other").hasAttribute("data-ytsf-hidden")');
    report("PASS YouTube SPA navigation leaves watch pages untouched and filters home again");

    failRequests = true;
    await evaluate(`document.querySelector('#ytsf-status button').click()`);
    await waitFor('document.getElementById("ytsf-status").textContent.includes("HTTP 503")');
    assert.equal((await visibility()).subscribed, true);
    assert.equal(await evaluate('document.querySelectorAll("#ytsf-uploads article").length'), 3);
    failRequests = false;
    await evaluate(`document.querySelector('#ytsf-status button').click()`);
    await waitFor('document.getElementById("subscribed").hasAttribute("data-ytsf-allowed")');
    report("PASS failed subscription refresh keeps the account's cached view and retry recovers");

    delayRequests = true;
    await evaluate(`document.querySelector('#ytsf-status button').click()`);
    await waitFor('document.getElementById("ytsf-status").textContent.includes("Aktualizacja kanałów w tle")');
    await evaluate('chrome.storage.local.set({enabled:false})', isolated);
    await waitFor('!document.documentElement.hasAttribute("data-ytsf-active")');
    delayedResolve?.();
    await sleep(150);
    assert.ok(Object.values(await visibility()).every(Boolean));
    report("PASS disabling during a pending fetch cannot re-enable the filter");
    delayRequests = false;

    const extensionId = await evaluate('chrome.runtime.id', isolated);
    const popupTarget = await browserCDP.send("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html`, background: true });
    const popupTargets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const popup = new CDP(popupTargets.find(item => item.id === popupTarget.targetId).webSocketDebuggerUrl);
    try {
      await popup.send("Runtime.enable");
      async function popupEval(expression) {
        const result = await popup.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
      }
      for (let attempt = 0; attempt < 100 && !await popupEval('Boolean(document.getElementById("enabled") && !document.getElementById("enabled").disabled)'); attempt++) await sleep(50);
      assert.equal(await popupEval('document.getElementById("enabled").checked'), false);
      await popupEval('document.getElementById("enabled").click()');
      await waitFor('document.getElementById("subscribed").hasAttribute("data-ytsf-allowed")');
      assert.equal(await popupEval('document.getElementById("enabled").checked'), true);
      await popupEval('document.getElementById("enabled").click()');
      await waitFor('!document.documentElement.hasAttribute("data-ytsf-active")');
      assert.ok(Object.values(await visibility()).every(Boolean));
    } finally {
      popup.close();
      await browserCDP.send("Target.closeTarget", { targetId: popupTarget.targetId });
    }
    const requestCount = calls.filter(value => value === "/feed/channels").length;
    await tab.send("Page.reload");
    await waitFor('document.readyState === "complete" && Boolean(document.getElementById("subscribed")) && !document.documentElement.hasAttribute("data-ytsf-active")');
    assert.ok(Object.values(await visibility()).every(Boolean));
    assert.equal(calls.filter(value => value === "/feed/channels").length, requestCount);
    report("PASS popup switch controls filtering and disabled state survives reload without fetching subscriptions");

    async function isolatedContext() {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        for (const context of contexts.values()) {
          if (!context.auxData?.isDefault && await evaluate('Boolean(globalThis.chrome?.runtime?.id)', context.id)) return context.id;
        }
        await sleep(30);
      }
      throw new Error("No extension context after reload");
    }
    let currentIsolated = await isolatedContext();
    await evaluate('chrome.storage.local.set({enabled:true})', currentIsolated);
    await waitFor('document.querySelectorAll("#ytsf-uploads article").length === 3 && !document.querySelector("#ytsf-uploads button").disabled');
    const dataRequests = () => calls.filter(value => ["/feed/channels", "/feeds/videos.xml", "/playlist", "/youtubei/v1/browse"].includes(value)).length;
    const warmRequests = dataRequests();
    const warmStart = Date.now();
    await tab.send("Page.reload");
    await waitFor('document.querySelectorAll("#ytsf-uploads article").length === 3 && !document.querySelector("#ytsf-uploads button").disabled');
    const warmElapsed = Date.now() - warmStart;
    assert.equal(dataRequests(), warmRequests, "A fresh cached revisit must not fetch channels or film lists");
    report(`PASS warm revisit displays persisted films in ${warmElapsed} ms with zero data requests`);

    currentIsolated = await isolatedContext();
    await evaluate(`(async () => {
      const entries = await chrome.storage.local.get(null);
      const stale = Object.fromEntries(Object.entries(entries).filter(([key]) => key.startsWith('ytsf-cache-v1:')).map(([key, value]) => [key, {...value, checkedAt: Date.now()-3600000}]));
      await chrome.storage.local.set(stale);
    })()`, currentIsolated);
    delayRequests = true;
    delayUploads = true;
    delayedResolve = undefined;
    const staleStart = Date.now();
    await tab.send("Page.reload");
    await waitFor('document.querySelectorAll("#ytsf-uploads article").length === 3');
    assert.equal(await evaluate('document.querySelector("#ytsf-uploads").hidden'), false);
    assert.equal((await visibility()).subscribed, true);
    report(`PASS stale cache displays films in ${Date.now()-staleStart} ms while all refresh responses are paused`);
    const pendingDeadline = Date.now() + 10000;
    while ((!delayedResolve || pendingUploads.length < 2) && Date.now() < pendingDeadline) await sleep(30);
    assert.ok(delayedResolve && pendingUploads.length >= 2, "The stale cache must refresh in the background");
    await evaluate('window.cachedThumbnail = document.querySelector("#ytsf-uploads img")');
    delayRequests = false;
    delayUploads = false;
    delayedResolve();
    for (const resolve of pendingUploads.splice(0)) resolve();
    await waitFor('document.querySelectorAll("#ytsf-uploads article").length === 3 && !document.querySelector("#ytsf-uploads button").disabled');
    assert.equal(await evaluate('window.cachedThumbnail === document.querySelector("#ytsf-uploads img")'), true);
    report("PASS background refresh reuses existing thumbnail nodes without rebuilding the film grid");

    testAccount = "offline-account-B||";
    delayRequests = true;
    delayedResolve = undefined;
    await tab.send("Page.reload");
    const accountDeadline = Date.now() + 10000;
    while (!delayedResolve && Date.now() < accountDeadline) await sleep(30);
    assert.ok(delayedResolve);
    assert.equal(await evaluate('document.querySelectorAll("#ytsf-uploads article").length'), 0, "A different account must never inherit the previous account's cached films");
    delayRequests = false;
    delayedResolve();
    await waitFor('document.querySelectorAll("#ytsf-uploads article").length === 3 && !document.querySelector("#ytsf-uploads button").disabled');
    report("PASS account changes isolate persisted subscription lists and film caches");

    currentIsolated = await isolatedContext();
    testAccount = "offline-account-startup||";
    await evaluate(`(async () => {
      const key = await YTSubscriptionFilterCache.accountKey({DATASYNC_ID: ${JSON.stringify(testAccount)}});
      await chrome.storage.local.set({['ytsf-cache-v1:'+key+':subscriptions']: {
        schema:1, checkedAt:Date.now(), channels:[
          {id:${JSON.stringify(A)},name:'A',aliases:['/@first']},
          {id:${JSON.stringify(B)},name:'B',aliases:['/@second']}
        ]
      }});
    })()`, currentIsolated);
    await tab.send("Page.navigate", { url: "about:blank" });
    const pages = (await browserCDP.send("Target.getTargets")).targetInfos.filter(target => target.type === "page");
    assert.ok(pages.every(page => !page.url.startsWith("https://www.youtube.com")), "Preload must start without any YouTube tab");
    const beforeStartup = calls.filter(value => value === "/feeds/videos.xml").length;
    delayUploads = true;
    await worker.send("Runtime.evaluate", { expression: 'globalThis.preloadDone=false; startup.run("startup-smoke", true).then(()=>{globalThis.preloadDone=true}); "started"', returnByValue: true });
    const preloadDeadline = Date.now() + 10000;
    while (pendingUploads.length < 2 && Date.now() < preloadDeadline) await sleep(30);
    assert.equal(pendingUploads.length, 2, "The worker must fetch both channel lists with no YouTube page open");
    await tab.send("Page.navigate", { url: "https://www.youtube.com/" });
    await waitFor('document.getElementById("ytsf-status")?.textContent.includes("2 kanałów")');
    await sleep(100);
    assert.equal(calls.filter(value => value === "/feeds/videos.xml").length - beforeStartup, 2, "Opening YouTube must share the worker's in-flight startup requests");
    delayUploads = false;
    for (const resolve of pendingUploads.splice(0)) resolve();
    await waitFor('document.querySelectorAll("#ytsf-uploads article").length === 3 && !document.querySelector("#ytsf-uploads button").disabled');
    const finishDeadline = Date.now() + 10000;
    while (Date.now() < finishDeadline) {
      const done = await worker.send("Runtime.evaluate", { expression: "globalThis.preloadDone", returnByValue: true });
      if (done.result.value) break;
      await sleep(30);
    }
    const preload = await worker.send("Runtime.evaluate", { expression: `(async()=>({
      done:globalThis.preloadDone,
      alarm:Boolean(await chrome.alarms.get('ytsf-startup-refresh')),
      state:(await chrome.storage.local.get('ytsf-startup-refresh-v1'))['ytsf-startup-refresh-v1']
    }))()`, returnByValue: true, awaitPromise: true });
    assert.equal(preload.result.value.done, true);
    assert.equal(preload.result.value.alarm, false);
    assert.equal(preload.result.value.state.queue.length, 0);
    const afterPreload = dataRequests();
    await tab.send("Page.reload");
    await waitFor('document.querySelectorAll("#ytsf-uploads article").length === 3 && !document.querySelector("#ytsf-uploads button").disabled');
    assert.equal(dataRequests(), afterPreload);
    report("PASS worker preloads films with no YouTube tab, shares requests with an opening tab, and serves the next visit without fetching");
    assert.ok(calls.includes("/feed/channels") && calls.includes("/youtubei/v1/browse"));
    assert.deepEqual(exceptions, [], "No unhandled page or content-script exceptions");
    report("All browser smoke checks passed (offline fixtures, fresh Brave profile).");
  } finally {
    if (tab) tab.close();
    if (worker) worker.close();
    await browserCDP.send("Browser.close").catch(() => {});
    browserCDP.close();
  }
}
run().catch(cause => {
  report(cause);
  process.exitCode = 1;
}).finally(() => {
  if (!browser.killed) browser.kill();
  fs.closeSync(log);
});
