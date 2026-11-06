(function (root) {
  "use strict";
  const { PREFIX } = root.YTSubscriptionFilterCache;
  const STATE_KEY = "ytsf-startup-refresh-v1";
  const ALARM = "ytsf-startup-refresh";

  function createStartupRefresher({ storage, alarms, cache, clock = Date.now, maxBatches = Infinity,
    runBudgetMs = 210000, channelTimeoutMs = 90000 } = {}) {
    let active;
    let controller;
    let pendingRebuild;
    async function enabled() { return (await storage.get({ enabled: true })).enabled !== false; }
    async function save(state) { await storage.set({ [STATE_KEY]: { ...state, updatedAt: clock() } }); }
    async function build(reason) {
      const all = await storage.get(null);
      const queue = [];
      for (const [key, entry] of Object.entries(all)) {
        if (!key.startsWith(PREFIX) || !key.endsWith(":subscriptions") || entry?.schema !== 1 || !Array.isArray(entry.channels)) continue;
        const account = key.slice(PREFIX.length, -":subscriptions".length);
        if (!/^[a-f0-9]{64}$/.test(account)) continue;
        const view = await cache.readView(account);
        for (const channel of view?.pending || []) queue.push({ account, channel, attempts: 0 });
      }
      return { schema: 1, reason, startedAt: clock(), queue, completed: 0, failed: 0, errors: [] };
    }
    async function process(reason, rebuild) {
      if (!await enabled()) { await alarms.clear(ALARM); return; }
      const saved = (await storage.get(STATE_KEY))[STATE_KEY];
      const state = rebuild || saved?.schema !== 1 ? await build(reason) : saved;
      controller = new AbortController();
      const signal = controller.signal;
      const started = clock();
      let batches = 0;
      const retry = [];
      await save(state);
      if (state.queue.length) {
        // Persist the queue and recovery alarm before network work, so worker
        // termination never loses the remaining jobs. No endless polling when done.
        await alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
      }
      while (state.queue.length && !signal.aborted && batches++ < maxBatches
        && clock() - started + channelTimeoutMs < runBudgetMs) {
        if (!await enabled()) break;
        const batch = state.queue.slice(0, 4);
        await Promise.all(batch.map(async job => {
          const requestController = new AbortController();
          const abort = () => requestController.abort();
          signal.addEventListener("abort", abort, { once: true });
          const timer = setTimeout(abort, channelTimeoutMs);
          try {
            await cache.getChannel(job.account, job.channel, { signal: requestController.signal });
            if (!signal.aborted) state.completed++;
          } catch (cause) {
            if (signal.aborted) return;
            if (job.attempts < 1) retry.push({ ...job, attempts: job.attempts + 1 });
            else {
              state.failed++;
              state.errors = [...state.errors, { channelId: job.channel.id, message: cause.message }].slice(-10);
            }
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
          }
        }));
        if (signal.aborted) break;
        state.queue.splice(0, batch.length);
        await save(state);
      }
      state.queue.push(...retry);
      if (!await enabled()) state.queue = [];
      if (!state.queue.length) {
        state.finishedAt = clock();
        await alarms.clear(ALARM);
      }
      await save(state);
      return state;
    }
    function run(reason = "resume", rebuild = false) {
      if (active) {
        if (!rebuild) return active;
        // A resume event can race browser startup. After resuming the old queue,
        // still discover every channel that became stale while Brave was closed.
        pendingRebuild = reason;
        const restart = () => {
          if (!pendingRebuild) return active;
          const next = pendingRebuild;
          pendingRebuild = undefined;
          return run(next, true);
        };
        return active.then(restart, restart);
      }
      active = process(reason, rebuild).finally(() => { active = undefined; controller = undefined; });
      return active;
    }
    async function resume() {
      const state = (await storage.get(STATE_KEY))[STATE_KEY];
      if (state?.schema === 1 && state.queue?.length) return run();
    }
    async function stop() {
      controller?.abort();
      await alarms.clear(ALARM);
    }
    return { run, resume, stop };
  }

  root.YTSubscriptionFilterStartup = { createStartupRefresher, STATE_KEY, ALARM };
  if (typeof module !== "undefined" && module.exports) module.exports = root.YTSubscriptionFilterStartup;
})(globalThis);
