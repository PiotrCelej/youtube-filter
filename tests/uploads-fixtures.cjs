"use strict";
const A = "UCaaaaaaaaaaaaaaaaaaaaaa";
const B = "UCbbbbbbbbbbbbbbbbbbbbbb";
const config = { LOGGED_IN: true, INNERTUBE_CONTEXT: { client: { clientVersion: "offline-test" } } };
const id = number => `v${String(number).padStart(10, "0")}`;
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const video = (number, published, channelId = A) => ({ id: id(number), title: `Film ${number}`, published, channelId, channelName: channelId === A ? "Kanał A" : "Kanał B" });
function atom(channelId, videos) {
  // The real feed header omits UC; each entry retains the full channel ID.
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><yt:channelId>${channelId.slice(2)}</yt:channelId><title>Kanał</title>${videos.map(item => `<entry><yt:videoId>${item.id}</yt:videoId><yt:channelId>${item.channelId}</yt:channelId><title>${escape(item.title)}</title><published>${item.published}</published><author><name>${escape(item.channelName)}</name></author></entry>`).join("")}</feed>`;
}

function lockup(item) {
  return { lockupViewModel: { contentId: item.id, contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
    metadata: { lockupMetadataViewModel: { title: { content: item.title } } },
    rendererContext: { commandContext: { onTap: { innertubeCommand: { watchEndpoint: { videoId: item.id } } } } }
  } };
}
function modernPlaylist(videos, token) {
  const items = [...videos.map(lockup), ...playlistItems([], token)];
  const initial = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: {
    selected: true, tabIdentifier: "VL", content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }] } }
  } }] } } };
  return `<script>ytcfg.set(${JSON.stringify(config)});</script><script>var ytInitialData = ${JSON.stringify(initial)};</script>`;
}
function playlistItems(videos, token) {
  return [...videos.map(item => ({ playlistVideoRenderer: { videoId: item.id, title: { simpleText: item.title }, isPlayable: true } })),
    ...(token ? [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } }] : [])];
}
function playlist(videos, token) {
  const initial = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: {
    sectionListRenderer: { contents: [{ playlistVideoListRenderer: { contents: playlistItems(videos, token) } }] }
  } } }] } } };
  return `<script>ytcfg.set(${JSON.stringify(config)});</script><script>var ytInitialData = ${JSON.stringify(initial)};</script>`;
}
function watch(item, extra = {}) {
  const player = { playabilityStatus: { status: "OK" }, videoDetails: { channelId: item.channelId, author: item.channelName },
    microformat: { playerMicroformatRenderer: { publishDate: item.published } }, ...extra };
  return `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`;
}
const response = body => ({ ok: true, text: async () => body });
const continuationResponse = (videos, token) => ({ ok: true, json: async () => ({ onResponseReceivedActions: [{
  appendContinuationItemsAction: { continuationItems: playlistItems(videos, token) }
}] }) });
module.exports = { A, B, id, video, atom, playlist, modernPlaylist, lockup, watch, response, continuationResponse };
