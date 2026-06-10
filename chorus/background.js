/**
 * background.js — Chorus Background Script v0.7.1
 *
 * Minimal SSE relay. No sidebar, no UI. Tab assignment lives
 * in the dashboard (/chorus/ui). This script:
 *   1. Reports available claude.ai tabs to the server
 *   2. Subscribes to SSE for fire commands
 *   3. Injects into tabs via content.js
 *   4. Reports completion back to server
 */

(() => {
  "use strict";

  const CHORUS_SERVER = "http://YOUR_PERSMEM_HOST:8000";
  const TAB_REPORT_INTERVAL = 10000; // report tabs every 10s

  let eventSource = null;
  const _processedFireIds = new Set();

  // ── Tab Reporting ──

  async function reportTabs() {
    try {
      const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });
      const tabList = tabs.map(t => ({
        id: t.id,
        title: t.title || "New conversation",
        url: t.url,
      }));
      await fetch(`${CHORUS_SERVER}/chorus/tabs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabs: tabList }),
      });
    } catch (e) {
      console.warn("[Chorus] Tab report failed:", e.message);
    }
  }

  // Report on startup, then periodically, and on tab changes
  reportTabs();
  setInterval(reportTabs, TAB_REPORT_INTERVAL);
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.url && tab.url.includes("claude.ai")) reportTabs();
  });
  browser.tabs.onRemoved.addListener(() => reportTabs());

  // ── SSE Connection ──

  function connectSSE() {
    if (eventSource) eventSource.close();

    eventSource = new EventSource(`${CHORUS_SERVER}/chorus/events`);

    eventSource.onopen = () => {
      console.log("[Chorus] SSE connected");
    };

    eventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "fire") handleFire(event);
      } catch (err) {
        console.error("[Chorus] SSE parse error:", err);
      }
    };

    eventSource.onerror = () => {
      console.warn("[Chorus] SSE disconnected — auto-reconnecting");
    };
  }

  // ── Fire Handling ──

  async function handleFire(event) {
    const agent = event.agent;
    const tabId = event.tab_id;
    const prompt = event.prompt;
    const ceilingMs = event.ceiling_ms || 300000;
    const fireId = event.fire_id || "";

    // Dedup: skip if we've already processed this fire event
    if (fireId && _processedFireIds.has(fireId)) {
      console.log(`[Chorus] Dedup: skipping already-processed fire ${fireId}`);
      return;
    }
    if (fireId) {
      _processedFireIds.add(fireId);
      // Clean old entries after 5 minutes
      setTimeout(() => _processedFireIds.delete(fireId), 300000);
    }

    if (!tabId) {
      console.error(`[Chorus] No tab_id in fire event for ${agent}`);
      await reportCompletion(agent, false, "[NO TAB — assign in dashboard]");
      return;
    }

    console.log(`[Chorus] Firing ${agent} → tab ${tabId}`);

    try {
      await browser.tabs.update(tabId, { active: true });
      const response = await browser.tabs.sendMessage(tabId, {
        type: "chorus:inject",
        text: prompt,
        tabId: tabId,
        ceilingMs: ceilingMs,
      });

      if (!response || !response.success) {
        console.error(`[Chorus] ${agent} injection failed:`, response);
        await reportCompletion(agent, false, response?.error || "injection failed");
      } else {
        console.log(`[Chorus] ${agent} injected, waiting for completion`);
      }
    } catch (e) {
      console.error(`[Chorus] ${agent} tab unreachable:`, e.message);
      await reportCompletion(agent, false, `tab unreachable: ${e.message}`);
    }
  }

  async function reportCompletion(agent, success, snippet) {
    try {
      await fetch(`${CHORUS_SERVER}/chorus/fire-completed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, success, snippet: snippet || "" }),
      });
    } catch (e) {
      console.error(`[Chorus] Failed to report completion for ${agent}:`, e);
    }
  }

  // ── Content Script Response Handler ──

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type === "chorus:response-complete") {
      const tabId = msg.tabId || (sender.tab && sender.tab.id);
      if (!tabId) return;

      // Find agent by tab_id from the fire event context
      // The server tracks which agent is on which tab — just report the tab
      // Server resolves tab_id → agent from its own assignment state
      fetch(`${CHORUS_SERVER}/chorus/fire-completed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tab_id: tabId,
          success: true,
          snippet: msg.responseSnippet || "",
        }),
      }).catch(e => console.error("[Chorus] completion report failed:", e));
    }
  });

  // ── Init ──
  connectSSE();
  console.log("[Chorus] Background v0.7.3 — minimal SSE relay + fire dedup");
})();
