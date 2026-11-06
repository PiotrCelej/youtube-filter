(() => {
  "use strict";
  globalThis.YTSubscriptionFilterUploadsView = function createUploadsView(retry) {
    const element = document.createElement("section");
    element.id = "ytsf-uploads";
    element.hidden = true;
    element.setAttribute("aria-labelledby", "ytsf-uploads-title");
    const heading = document.createElement("h2");
    heading.id = "ytsf-uploads-title";
    heading.textContent = "Filmy z Twoich subskrypcji";
    const description = document.createElement("p");
    description.textContent = "Wszystkie publikacje z ostatniego miesiąca. Dla kanałów bez nowych publikacji — jeden najnowszy film.";
    const progress = document.createElement("p");
    progress.className = "ytsf-uploads-progress";
    progress.setAttribute("role", "status");
    progress.setAttribute("aria-live", "polite");
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "Odśwież filmy";
    refresh.addEventListener("click", retry);
    const grid = document.createElement("div");
    grid.className = "ytsf-uploads-grid";
    const failures = document.createElement("details");
    const summary = document.createElement("summary");
    const errorList = document.createElement("ul");
    failures.append(summary, errorList);
    element.append(heading, description, progress, refresh, failures, grid);
    let renderedVersion = -1;
    const formatter = new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

    function render(state, browse) {
      if (state.phase === "idle") { element.hidden = true; return; }
      // Keep the section below the native recommendation grid, outside its observer-managed contents.
      if (element.parentElement !== browse) browse.append(element);
      element.hidden = false;
      if (renderedVersion === state.version) return;
      renderedVersion = state.version;
      refresh.disabled = state.phase === "loading";
      progress.textContent = state.phase === "loading"
        ? `Pobieranie filmów · odczytano ${state.completed} z ${state.total} kanałów · znalezione filmy: ${state.videos.length}`
        : `Filmy: ${state.videos.length} · sprawdzone kanały: ${state.completed} z ${state.total}${state.errors.length ? " · lista jest niepełna, użyj przycisku Odśwież filmy" : ""}`;
      if (state.phase === "ready" && !state.videos.length && !state.errors.length) progress.textContent += " · Brak dostępnych opublikowanych filmów.";
      failures.hidden = !state.errors.length;
      summary.textContent = `Nie udało się odczytać filmów z ${state.errors.length} kanałów`;
      errorList.replaceChildren(...state.errors.map(error => {
        const item = document.createElement("li");
        item.textContent = `${error.channelName}: ${error.message}`;
        return item;
      }));
      const videos = [...state.videos].sort((a, b) => Date.parse(b.published) - Date.parse(a.published) || a.id.localeCompare(b.id));
      grid.replaceChildren(...videos.map(video => {
        const card = document.createElement("article");
        card.dataset.videoId = video.id;
        card.dataset.channelId = video.channelId;
        const link = document.createElement("a");
        link.href = `/watch?v=${video.id}`;
        link.className = "ytsf-upload-video";
        const image = document.createElement("img");
        image.src = `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`;
        image.alt = "";
        image.width = 320;
        image.height = 180;
        image.loading = "lazy";
        image.decoding = "async";
        const title = document.createElement("h3");
        title.textContent = video.title;
        link.append(image, title);
        const channel = document.createElement("a");
        channel.href = `/channel/${video.channelId}`;
        channel.className = "ytsf-upload-channel";
        channel.textContent = video.channelName;
        const date = document.createElement("time");
        date.dateTime = video.published;
        date.textContent = formatter.format(new Date(video.published));
        card.append(link, channel, date);
        if (video.fallback) {
          const badge = document.createElement("span");
          badge.className = "ytsf-upload-fallback";
          badge.textContent = "Najnowszy film kanału · starszy niż miesiąc";
          card.append(badge);
        }
        return card;
      }));
    }

    function clear() {
      element.hidden = true;
      grid.replaceChildren();
      errorList.replaceChildren();
      renderedVersion = -1;
    }
    return { element, render, clear };
  };
})();
