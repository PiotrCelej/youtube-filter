"use strict";
// Read-only public diagnostics. No browser profile, cookies or account is used.
const fs = require("node:fs");
const path = require("node:path");
const channelId = process.argv.slice(2).find(value => /^UC[\w-]{22}$/.test(value)) || "UC_x5XG1OV2P6uZZ5FSM9Ttw";
if (!/^UC[\w-]{22}$/.test(channelId)) throw new Error("Invalid public channel ID");
const directory = path.join(__dirname, "..", ".test-output");
fs.mkdirSync(directory, { recursive: true });
const report = value => fs.appendFileSync(path.join(directory, "live-probe.txt"), `${value}\n`);
fs.writeFileSync(path.join(directory, "live-probe.txt"), "Public YouTube probe (no account)\n");
(async () => {
  if (process.argv.includes("--verify")) {
    require("../extension/core.js");
    require("../extension/subscriptions.js");
    const uploads = require("../extension/uploads.js");
    const videos = await uploads.fetchChannelVideos({ id: channelId }, {
      origin: "https://www.youtube.com", cookie: "", signal: AbortSignal.timeout(60000)
    });
    if (!videos.length) throw new Error("Public verification returned no videos");
    report(`PASS actual fetchChannelVideos: ${channelId}, selected ${videos.length} videos, fallback=${videos[0].fallback}, published=${videos[0].published}`);
    return;
  }
  for (const [name, route] of [
    ["rss", `/feeds/videos.xml?channel_id=${channelId}`],
    ["playlist", `/playlist?list=UU${channelId.slice(2)}&hl=en`],
    ["videos", `/channel/${channelId}/videos?hl=en`]
  ]) {
    try {
      const response = await fetch(`https://www.youtube.com${route}`, { signal: AbortSignal.timeout(20000) });
      const body = await response.text();
      fs.writeFileSync(path.join(directory, `live-${name}.txt`), body);
      report(`${name}: ${response.status} ${response.url} ${response.headers.get("content-type")} ${body.length} characters`);
      report(body.slice(0, name === "rss" ? 1800 : 180));
    } catch (cause) {
      report(`${name}: ${cause.message} ${cause.cause?.code || ""}`);
    }
  }
})().catch(cause => { report(cause.stack); process.exitCode = 1; });
