(function (root) {
  "use strict";
  const core = root.YTSubscriptionFilterCore;

  async function authorization(cookie, config, origin) {
    const cookies = new Map(cookie.split(/;\s*/).map(part => {
      const split = part.indexOf("=");
      return [part.slice(0, split), part.slice(split + 1)];
    }));
    const timestamp = Math.floor(Date.now() / 1000);
    const sync = String(config.DATASYNC_ID || "").split("||");
    const user = config.USER_SESSION_ID || (sync[1] || sync[0]);
    const schemes = [
      ["SAPISIDHASH", cookies.get("SAPISID") || cookies.get("__Secure-3PAPISID")],
      ["SAPISID1PHASH", cookies.get("__Secure-1PAPISID")],
      ["SAPISID3PHASH", cookies.get("__Secure-3PAPISID")]
    ];
    const values = [];
    for (const [scheme, sid] of schemes) {
      if (!sid) continue;
      const input = [user, timestamp, sid, origin].filter(value => value !== undefined && value !== "").join(" ");
      const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      values.push(`${scheme} ${timestamp}_${hash}${user ? "_u" : ""}`);
    }
    return values.join(" ");
  }

  async function requestBrowse(payload, config, { signal, fetcher = fetch, cookie = document.cookie, origin = location.origin } = {}) {
    if (!["https://www.youtube.com", "https://youtube.com"].includes(origin)) throw new Error("Nieprawidłowy adres YouTube.");
    if (!config.INNERTUBE_CONTEXT?.client) throw new Error("Brakuje konfiguracji kolejnej strony YouTube.");
    const headers = {
      "Content-Type": "application/json",
      "X-Youtube-Client-Name": String(config.INNERTUBE_CONTEXT_CLIENT_NAME || 1),
      "X-Youtube-Client-Version": config.INNERTUBE_CLIENT_VERSION || config.INNERTUBE_CONTEXT.client.clientVersion,
      "X-Goog-AuthUser": String(config.SESSION_INDEX || 0),
      "X-Origin": origin
    };
    const auth = await authorization(cookie, config, origin);
    if (auth) headers.Authorization = auth;
    const sync = String(config.DATASYNC_ID || "").split("||");
    const delegated = config.DELEGATED_SESSION_ID || (sync[1] && sync[0]);
    if (delegated) headers["X-Goog-PageId"] = delegated;
    const visitor = config.VISITOR_DATA || config.INNERTUBE_CONTEXT.client.visitorData;
    if (visitor) headers["X-Goog-Visitor-Id"] = visitor;
    const url = new URL("/youtubei/v1/browse", origin);
    url.searchParams.set("prettyPrint", "false");
    if (config.INNERTUBE_API_KEY) url.searchParams.set("key", config.INNERTUBE_API_KEY);
    const response = await fetcher(url.href, {
      method: "POST", credentials: "same-origin", headers, signal,
      body: JSON.stringify({ context: config.INNERTUBE_CONTEXT, ...payload })
    });
    if (!response.ok) throw new Error(`Nie udało się odczytać kolejnej strony YouTube (HTTP ${response.status}).`);
    const data = await response.json();
    if (data.error) throw new Error("YouTube odrzucił odczyt kolejnej strony.");
    return data;
  }

  async function fetchSubscriptions({ signal, fetcher = fetch, cookie = document.cookie, origin = location.origin } = {}) {
    if (!["https://www.youtube.com", "https://youtube.com"].includes(origin)) throw new Error("Nieprawidłowy adres YouTube.");
    const response = await fetcher(`${origin}/feed/channels`, {
      credentials: "same-origin", cache: "no-store", signal
    });
    if (!response.ok) throw new Error(`Nie udało się pobrać kanałów (HTTP ${response.status}). Spróbuj ponownie.`);
    if (response.url && new URL(response.url).origin !== origin) {
      throw new Error("YouTube wymaga zalogowania lub zaakceptowania zgód. Otwórz listę kanałów.");
    }
    const { initial, config } = core.parsePage(await response.text());
    if (config.LOGGED_IN === false || initial.responseContext?.mainAppWebResponseContext?.loggedOut === true) {
      throw new Error("Zaloguj się na YouTube, aby odczytać subskrypcje.");
    }
    const first = core.readChannels(core.feedRoots(initial));
    const channels = new Map(first.channels.map(channel => [channel.id, channel]));
    const pending = [...first.tokens];
    const seen = new Set();
    let page = 0;
    while (pending.length) {
      const token = pending.shift();
      if (seen.has(token) || ++page > 200) throw new Error("Nie udało się odczytać pełnej listy kanałów. Spróbuj ponownie.");
      seen.add(token);
      const data = await requestBrowse({ continuation: token }, config, { signal, fetcher, cookie, origin });
      const batch = core.readChannels(core.feedRoots(data, true));
      for (const channel of batch.channels) {
        const previous = channels.get(channel.id);
        channels.set(channel.id, { ...channel, aliases: [...new Set([...(previous?.aliases || []), ...channel.aliases])] });
      }
      pending.push(...batch.tokens);
    }
    return [...channels.values()];
  }

  root.YTSubscriptionFilterSubscriptions = { fetchSubscriptions, authorization, requestBrowse };
  if (typeof module !== "undefined" && module.exports) module.exports = root.YTSubscriptionFilterSubscriptions;
})(globalThis);
