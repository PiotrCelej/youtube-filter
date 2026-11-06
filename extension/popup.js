"use strict";
const toggle = document.getElementById("enabled");
const description = document.getElementById("toggle-description");
const status = document.getElementById("status");
const refresh = document.getElementById("refresh");
let tabId;
let timer;
let saving = false;

function displayEnabled(enabled) {
  toggle.checked = enabled;
  description.textContent = enabled ? "Włączony · tylko Twoje kanały" : "Wyłączony · wszystkie rekomendacje";
}

async function updateStatus() {
  status.removeAttribute("data-error");
  if (!toggle.checked) {
    status.textContent = "Filtr jest wyłączony. YouTube pokazuje wszystkie rekomendacje.";
    refresh.disabled = true;
    return;
  }
  if (!tabId) {
    status.textContent = "Otwórz kartę YouTube, aby sprawdzić filtr. Ustawienie jest już zapisane.";
    refresh.disabled = true;
    return;
  }
  try {
    const state = await chrome.tabs.sendMessage(tabId, { type: "status" });
    if (!toggle.checked) return;
    if (!state) throw new Error("No content script");
    refresh.disabled = !state.isHome || state.phase === "loading";
    if (!state.isHome) status.textContent = "Filtr działa tylko na głównej stronie YouTube. Wróć na główną, aby zobaczyć wynik.";
    else if (state.phase === "loading") status.textContent = "Pobieranie pełnej listy subskrybowanych kanałów…";
    else if (state.phase === "error") {
      status.textContent = state.error;
      status.setAttribute("data-error", "");
    } else if (state.phase === "ready") status.textContent = `Kanały: ${state.channelCount} · rekomendacje: ${state.visibleCount} · dodatkowe filmy: ${state.uploadsCount || 0}${state.uploadsPhase === "loading" ? " · pobieranie filmów…" : ""}${state.uploadsErrors ? ` · błędy kanałów: ${state.uploadsErrors}` : ""}`;
    else status.textContent = "Uruchamianie filtra…";
  } catch {
    status.textContent = "Odśwież kartę YouTube, aby uruchomić zainstalowane rozszerzenie.";
    refresh.disabled = true;
  }
}

toggle.addEventListener("change", async () => {
  const enabled = toggle.checked;
  saving = true;
  toggle.disabled = true;
  try {
    await chrome.storage.local.set({ enabled });
    displayEnabled(enabled);
    await updateStatus();
  } catch {
    displayEnabled(!enabled);
    status.textContent = "Nie udało się zapisać ustawienia. Spróbuj ponownie.";
    status.setAttribute("data-error", "");
  } finally {
    saving = false;
    toggle.disabled = false;
  }
});

refresh.addEventListener("click", async () => {
  refresh.disabled = true;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "refresh" });
    await updateStatus();
  } catch {
    status.textContent = "Odśwież kartę YouTube i spróbuj ponownie.";
    status.setAttribute("data-error", "");
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled && !saving) {
    displayEnabled(changes.enabled.newValue !== false);
    updateStatus();
  }
});

(async () => {
  try {
    const [settings, tabs] = await Promise.all([
      chrome.storage.local.get({ enabled: true }),
      chrome.tabs.query({ active: true, currentWindow: true })
    ]);
    displayEnabled(settings.enabled !== false);
    toggle.disabled = false;
    const tab = tabs[0];
    if (tab?.url && /^https:\/\/(www\.)?youtube\.com\//.test(tab.url)) tabId = tab.id;
    await updateStatus();
    timer = setInterval(updateStatus, 1000);
  } catch {
    status.textContent = "Nie udało się otworzyć ustawień. Zamknij panel i otwórz go ponownie.";
    status.setAttribute("data-error", "");
  }
})();
window.addEventListener("pagehide", () => clearInterval(timer));
