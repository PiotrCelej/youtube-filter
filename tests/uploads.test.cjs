"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("../extension/core.js");
require("../extension/subscriptions.js");
const uploads = require("../extension/uploads.js");
const f = require("./uploads-fixtures.cjs");
const now = new Date("2026-11-06T12:00:00Z");
const channel = { id: f.A, name: "Kanał A" };
const options = { origin: "https://www.youtube.com", cookie: "", now };

test("a calendar month clamps month ends and leap years, including January year rollover", () => {
  for (const [input, expected] of [["2026-11-06", "2026-10-06"], ["2026-03-31", "2026-02-28"],
    ["2024-03-31", "2024-02-29"], ["2026-01-31", "2025-12-31"]]) {
    assert.equal(uploads.monthCutoff(new Date(`${input}T12:00:00Z`)).toISOString(), `${expected}T00:00:00.000Z`);
  }
});

test("include every recent upload and the boundary day; exclude old, future, invalid and duplicate entries", () => {
  const videos = [f.video(1, "2026-11-05T12:00:00Z"), f.video(2, "2026-10-06T00:00:00Z"),
    f.video(3, "2026-10-05T23:59:59Z"), f.video(4, "2026-11-07"), f.video(5, "invalid")];
  assert.deepEqual(uploads.selectVideos([...videos, videos[0]], now).map(item => [item.id, item.fallback]), [[f.id(1), false], [f.id(2), false]]);
});

test("a channel without recent uploads contributes exactly its newest older video", () => {
  const result = uploads.selectVideos([f.video(1, "2025-01-01"), f.video(2, "2026-09-01"), f.video(3, "2026-08-01")], now);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, f.id(2));
  assert.equal(result[0].fallback, true);
  assert.deepEqual(uploads.selectVideos([], now), []);
  assert.deepEqual(uploads.selectVideos([f.video(4, "2026-12-01")], now), []);
});

test("RSS uses exact published dates, decodes titles and validates channel ownership", () => {
  const item = { ...f.video(1, "2026-11-01T12:00:00+01:00"), title: 'A & B <title> "tekst"' };
  assert.deepEqual(uploads.parseFeed(f.atom(f.A, [item]), channel), [item]);
  assert.deepEqual(uploads.parseFeed(f.atom(f.A, []), channel), []);
  assert.throws(() => uploads.parseFeed(f.atom(f.B, [f.video(2, "2026-11-01", f.B)]), channel), /innego/);
  assert.throws(() => uploads.parseFeed(f.atom(f.A, [f.video(2, "invalid")]), channel), /Niekompletne/);
  assert.throws(() => uploads.parseFeed("<html>Not an XML feed</html>", channel));
  // Accept both known header forms; entry authors must still match exactly.
  const prefixed = f.atom(f.A, [item]).replace(`<yt:channelId>${f.A.slice(2)}</yt:channelId>`, `<yt:channelId>${f.A}</yt:channelId>`);
  assert.deepEqual(uploads.parseFeed(prefixed, channel), [item]);
  assert.throws(() => uploads.parseFeed(f.atom(f.A, [f.video(2, "2026-11-01", f.B)]), channel), /Niekompletne/);
});

test("modern upload playlists use lockupViewModel in the selected tab, not the legacy list renderer", () => {
  const core = globalThis.YTSubscriptionFilterCore;
  const videos = [f.video(1, "2026-11-01"), f.video(2, "2026-10-01")];
  const initial = core.parsePage(f.modernPlaylist(videos, "more")).initial;
  initial.contents.twoColumnBrowseResultsRenderer.secondaryContents = f.lockup(f.video(99, "2026-11-01"));
  const batch = uploads.playlistPage(initial);
  assert.deepEqual(batch.videos, videos.map(({ id, title }) => ({ id, title })));
  assert.deepEqual(batch.tokens, ["more"]);
  const next = { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [f.lockup(videos[1])] } }] };
  assert.deepEqual(uploads.playlistPage(next, true).videos, [{ id: videos[1].id, title: videos[1].title }]);
});

test("RSS failure recovers through a modern playlist and exact watch metadata", async () => {
  const item = f.video(1, "2026-08-01");
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.pathname === "/feeds/videos.xml") return { ok: false, status: 404 };
    if (parsed.pathname === "/playlist") return f.response(f.modernPlaylist([item]));
    if (parsed.pathname === "/watch") return f.response(f.watch(item));
    throw new Error("Unexpected request");
  };
  const result = await uploads.fetchChannelVideos(channel, { ...options, fetcher });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, item.id);
  assert.equal(result[0].fallback, true);
});

test("RSS covering the cutoff needs one request and includes only the month's uploads", async () => {
  const recent = [f.video(1, "2026-11-05"), f.video(2, "2026-10-06"), f.video(3, "2026-09-01")];
  const calls = [];
  const result = await uploads.fetchChannelVideos(channel, { ...options, fetcher: async (url, settings) => {
    calls.push(url);
    assert.equal(settings.credentials, "same-origin");
    return f.response(f.atom(f.A, recent));
  } });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).pathname, "/feeds/videos.xml");
  assert.deepEqual(result.map(item => item.id), [f.id(1), f.id(2)]);
});

test("RSS containing fifteen recent entries expands into the upload playlist and its next pages", async () => {
  const recent = Array.from({ length: 15 }, (_, i) => f.video(i + 1, "2026-11-01"));
  const extra = f.video(16, "2026-10-15");
  const old = f.video(17, "2026-09-01");
  const calls = [];
  const fetcher = async (url, settings) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    if (parsed.pathname === "/feeds/videos.xml") return f.response(f.atom(f.A, recent));
    if (parsed.pathname === "/playlist") return f.response(f.playlist(recent, "uploads-next"));
    if (parsed.pathname === "/youtubei/v1/browse") {
      assert.equal(JSON.parse(settings.body).continuation, "uploads-next");
      return f.continuationResponse([extra, old]);
    }
    if (parsed.pathname === "/watch") return f.response(f.watch(parsed.searchParams.get("v") === extra.id ? extra : old));
    throw new Error("Unexpected request");
  };
  const result = await uploads.fetchChannelVideos(channel, { ...options, fetcher });
  assert.equal(result.length, 16, "The month must not be limited to the 15-entry RSS feed");
  assert.equal(result.some(item => item.id === extra.id), true);
  assert.equal(result.some(item => item.id === old.id), false);
  assert.equal(calls.filter(path => path === "/watch").length, 2, "Reuse exact RSS dates instead of refetching those videos");
});

test("an unavailable RSS feed falls back to the complete upload playlist", async () => {
  const newest = f.video(1, "2026-08-01");
  const older = f.video(2, "2025-01-01");
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.pathname === "/feeds/videos.xml") return { ok: false, status: 404 };
    if (parsed.pathname === "/playlist") return f.response(f.playlist([newest, older], "unneeded-next"));
    if (parsed.pathname === "/watch") return f.response(f.watch(parsed.searchParams.get("v") === newest.id ? newest : older));
    throw new Error("Older pages must not be fetched after passing the cutoff");
  };
  const result = await uploads.fetchChannelVideos(channel, { ...options, fetcher });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, newest.id);
  assert.equal(result[0].fallback, true);
});

test("publication extraction rejects other authors, skips unavailable and upcoming videos", () => {
  const item = f.video(1, "2026-11-01");
  assert.equal(uploads.watchPublication(f.watch(item), item, channel).published, item.published);
  assert.throws(() => uploads.watchPublication(f.watch(f.video(2, "2026-11-01", f.B)), item, channel), /autora/);
  assert.equal(uploads.watchPublication(f.watch(item, { playabilityStatus: { status: "UNPLAYABLE" } }), item, channel), null);
  assert.equal(uploads.watchPublication(f.watch(item, { videoDetails: { channelId: f.A, isUpcoming: true } }), item, channel), null);
  assert.throws(() => uploads.watchPublication(f.watch({ ...item, published: "" }), item, channel), /daty/);
});

test("a failed continuation rejects the channel instead of returning a partial recent list", async () => {
  const recent = Array.from({ length: 15 }, (_, i) => f.video(i + 1, "2026-11-01"));
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.pathname === "/feeds/videos.xml") return f.response(f.atom(f.A, recent));
    if (parsed.pathname === "/playlist") return f.response(f.playlist(recent, "next"));
    return { ok: false, status: 503 };
  };
  await assert.rejects(uploads.fetchChannelVideos(channel, { ...options, fetcher }), /503/);
});

test("channel failures are reported independently while other channels keep their videos", async () => {
  const updates = [];
  const result = await uploads.collectVideos([channel, { id: f.B, name: "Kanał B" }], { ...options, onProgress: update => updates.push(update), fetcher: async url => {
    if (new URL(url).searchParams.get("channel_id") === f.A) return f.response(f.atom(f.A, [f.video(1, "2026-11-01")]));
    return { ok: false, status: 503 };
  } });
  assert.equal(result.videos.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].channelId, f.B);
  assert.equal(updates.at(-1).completed, 2);
});

test("requests use bounded concurrency and cancellation stops the current and queued channels", async () => {
  const controller = new AbortController();
  let requests = 0;
  const promise = uploads.collectVideos([channel, { id: f.B, name: "B" }, channel], {
    ...options, signal: controller.signal, concurrency: 2,
    fetcher: (_, settings) => new Promise((resolve, reject) => {
      requests++;
      settings.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })
  });
  assert.equal(requests, 2);
  controller.abort();
  await assert.rejects(promise, { name: "AbortError" });
  assert.equal(requests, 2);
});
