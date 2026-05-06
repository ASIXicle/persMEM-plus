/**
 * background.js — Chorus Background Script v0.6.1
 *
 * Configurable slots (2 minimum, 5 maximum) with full sequence editor.
 * Slot names are user-supplied; no defaults are baked into the orchestrator.
 *
 * Storage shape (v0.6.1):
 *   chorusSlots: [
 *     { name: "<user-chosen>", tabId: 123 },
 *     { name: "<user-chosen>", tabId: 456 },
 *     ...up to 5
 *   ]
 *   chorusSequence: ["<name1>", "<name2>", ...]  (firing order)
 *
 * Migration paths:
 *   - chorusSlots present: load as-is.
 *   - chorusTabMap (v0.5) present: convert to chorusSlots, drop legacy key.
 *     Known historical names from the original triad ("kite", "wren",
 *     "kestrel", "knot") are recognized in legacy maps for backward
 *     compatibility. The "wren" key is preserved with name "wren" in
 *     the new format — users can rename it from the UI.
 *   - Neither: create MIN_SLOTS empty slots awaiting user input.
 */

(() => {
  "use strict";

  const MIN_SLOTS = 2;
  const MAX_SLOTS = 5;

  // ── State ──
  let slots = [];           // array of {name, tabId}
  let sequence = [];        // array of slot names in firing order
  let pendingTabs = {};     // { tabId: agentName } for in-flight responses
  let loopState = null;
  let lastResponses = {};   // { agentName: snippet }
  let stopRequested = false;

  // ── Storage helpers ──

  async function loadSlots() {
    const data = await browser.storage.local.get(["chorusSlots", "chorusSequence", "chorusTabMap"]);

    if (data.chorusSlots && Array.isArray(data.chorusSlots) && data.chorusSlots.length >= MIN_SLOTS) {
      slots = data.chorusSlots.slice(0, MAX_SLOTS);
    } else if (data.chorusTabMap && typeof data.chorusTabMap === "object") {
      // ── Migrate v0.5 → v0.6.1 ──
      slots = migrateLegacyTabMap(data.chorusTabMap);
      await saveSlots();
      await browser.storage.local.remove("chorusTabMap");
      console.log("[Chorus] Migrated legacy chorusTabMap to chorusSlots");
    } else {
      // First run with no data: render the minimum number of empty slots
      slots = [];
      for (let i = 0; i < MIN_SLOTS; i++) {
        slots.push({ name: "", tabId: 0 });
      }
    }

    if (data.chorusSequence && Array.isArray(data.chorusSequence)) {
      sequence = data.chorusSequence;
    } else {
      sequence = slots.map(s => s.name).filter(Boolean);
    }
  }

  function migrateLegacyTabMap(legacy) {
    // Legacy is a flat dict like {kite: 123, wren: 456, knot: 789}.
    // Preserve every key as a named slot; the user can rename later.
    const out = [];
    for (const key of Object.keys(legacy)) {
      const tabId = parseInt(legacy[key], 10) || 0;
      if (!key) continue;
      out.push({ name: key, tabId: tabId });
      if (out.length >= MAX_SLOTS) break;
    }
    // Ensure at least MIN_SLOTS rows even if legacy had fewer
    while (out.length < MIN_SLOTS) {
      out.push({ name: "", tabId: 0 });
    }
    return out;
  }

  async function saveSlots() {
    await browser.storage.local.set({ chorusSlots: slots });
  }

  async function saveSequence() {
    await browser.storage.local.set({ chorusSequence: sequence });
  }

  function getTabIdForAgent(agentName) {
    const slot = slots.find(s => s.name === agentName);
    return slot ? slot.tabId : 0;
  }

  function getRegisteredAgents() {
    return slots.filter(s => s.name && s.tabId).map(s => s.name);
  }

  function getFiringOrder(reqSequence) {
    const agentsWithTabs = new Set(getRegisteredAgents());
    const order = [];
    if (reqSequence && reqSequence.length) {
      for (const name of reqSequence) {
        if (agentsWithTabs.has(name)) order.push(name);
      }
    }
    if (order.length === 0) {
      for (const slot of slots) {
        if (slot.name && slot.tabId) order.push(slot.name);
      }
    }
    return order;
  }

  // ── Prompt wrappers ──

  const AMQ_CHECK_PROMPT =
    "[AMQ-CHECK] Check your AMQ inbox (amq_check). " +
    "Read and respond to any messages from the other instances via amq_send. " +
    "If no new messages, reply with: No new AMQ messages.";

  const NO_MSG_PATTERNS = [
    /no new amq messages/i,
    /no new messages/i,
    /inbox.*empty/i,
    /new_count.*0/i,
  ];

  function wrapInitialPrompt(text) {
    return "[CHORUS] " + text + "\n\n" +
      "After processing, write your key thoughts/analysis to AMQ " +
      "(amq_send from yourself to the other instances) so they can " +
      "read and respond. Then answer normally.";
  }

  function wrapFollowUpPrompt(text, priorAgents) {
    const names = priorAgents.map(a => a.charAt(0).toUpperCase() + a.slice(1));
    const nameStr = names.join(" and ");
    return "[CHORUS] " + text + "\n\n" +
      "IMPORTANT: " + nameStr +
      " already processed this prompt and wrote analysis to AMQ. " +
      "Check your AMQ inbox FIRST (amq_check + amq_read), then build on " +
      "their analysis rather than duplicating work. Write your additional " +
      "thoughts/analysis to AMQ, then answer normally.";
  }

  function responseIsEmpty(text) {
    if (!text) return false;
    var tail = text.slice(-500).toLowerCase();
    for (var i = 0; i < NO_MSG_PATTERNS.length; i++) {
      if (NO_MSG_PATTERNS[i].test(tail)) return true;
    }
    return false;
  }

  function allResponsesEmpty() {
    var agents = Object.keys(lastResponses);
    if (agents.length === 0) return false;
    for (var i = 0; i < agents.length; i++) {
      if (!responseIsEmpty(lastResponses[agents[i]])) return false;
    }
    return true;
  }

  // ── Send to Tab ──

  async function sendToTab(tabId, text, ceilingMs) {
    try {
      await browser.tabs.update(tabId, { active: true });
      const response = await browser.tabs.sendMessage(tabId, {
        type: "chorus:inject",
        text: text,
        tabId: tabId,
        ceilingMs: ceilingMs || 300000,
      });
      return response;
    } catch (e) {
      console.error(`[Chorus] Failed to send to tab ${tabId}:`, e);
      return { success: false, error: e.message };
    }
  }

  async function fireToAllTabs(text, ceilingMs) {
    const agents = getRegisteredAgents();
    if (agents.length === 0) return { error: "No slots with tabs assigned" };

    pendingTabs = {};
    lastResponses = {};
    for (const agent of agents) {
      pendingTabs[getTabIdForAgent(agent)] = agent;
    }

    const results = {};
    for (const agent of agents) {
      const tabId = getTabIdForAgent(agent);
      try {
        await browser.tabs.get(tabId);
        const res = await sendToTab(tabId, text, ceilingMs);
        results[agent] = res;
      } catch (e) {
        results[agent] = { success: false, error: "tab closed or unreachable" };
        delete pendingTabs[tabId];
      }
    }
    return results;
  }

  async function fireToOneTab(agent, text, ceilingMs) {
    const tabId = getTabIdForAgent(agent);
    if (!tabId) {
      console.warn(`[Chorus] ${agent} has no tab assigned — skipping`);
      return { success: false, error: `No tab for ${agent}`, skipped: true };
    }

    pendingTabs = {};
    lastResponses = {};
    pendingTabs[tabId] = agent;

    try {
      await browser.tabs.get(tabId);
      const res = await sendToTab(tabId, text, ceilingMs);
      if (!res || !res.success) {
        console.error(`[Chorus] ${agent} tab ${tabId} injection failed:`, res);
        delete pendingTabs[tabId];
      } else {
        console.log(`[Chorus] ${agent} tab ${tabId} injection OK, waiting for completion`);
      }
      return res;
    } catch (e) {
      console.error(`[Chorus] ${agent} tab ${tabId} unreachable:`, e.message);
      delete pendingTabs[tabId];
      return { success: false, error: "tab closed or unreachable" };
    }
  }

  function allTabsComplete() {
    return Object.keys(pendingTabs).length === 0;
  }

  // ── Main Loop ──

  async function runLoop(text, maxRounds, mode, ceilingMs, reqSequence) {
    const status = [];
    const ceiling = ceilingMs || 300000;
    stopRequested = false;
    await loadSlots();

    const deadTabTimeout = Math.round(ceiling * 1.5);
    const agents = getFiringOrder(reqSequence);
    const agentCount = agents.length;

    if (agentCount === 0) {
      broadcastStatus("error", 0, maxRounds);
      return [{ error: "No slots with tabs assigned" }];
    }

    if (agentCount < MIN_SLOTS) {
      broadcastStatus("error", 0, maxRounds);
      return [{ error: `At least ${MIN_SLOTS} agents required for round-robin` }];
    }

    console.log(`[Chorus] Round 0: firing initial prompt (${mode} mode, ${ceiling}ms ceiling, ${agentCount} agents in order: ${agents.join(", ")})`);

    if (mode === "roundrobin") {
      for (let i = 0; i < agentCount; i++) {
        const agent = agents[i];
        const label = agent.charAt(0).toUpperCase() + agent.slice(1);
        broadcastStatus("firing-agent", 0, maxRounds, label);

        let prompt;
        if (i === 0) {
          prompt = wrapInitialPrompt(text);
        } else {
          prompt = wrapFollowUpPrompt(text, agents.slice(0, i));
        }

        await fireToOneTab(agent, prompt, ceiling);
        await waitForAllResponses(deadTabTimeout);
        if (stopRequested) { broadcastStatus("stopped", 0, maxRounds); return status; }
      }
      status.push({ round: 0, type: "initial-roundrobin" });
    } else {
      broadcastStatus("firing", 0, maxRounds);
      const r0 = await fireToAllTabs(wrapInitialPrompt(text), ceiling);
      status.push({ round: 0, type: "initial", results: r0 });
      await waitForAllResponses(deadTabTimeout);
      if (stopRequested) { broadcastStatus("stopped", 0, maxRounds); return status; }
    }

    broadcastStatus("complete", 0, maxRounds);

    // Rounds 1..N
    for (let round = 1; round <= maxRounds; round++) {
      if (stopRequested) {
        console.log(`[Chorus] Stop requested — halting at round ${round}`);
        broadcastStatus("stopped", round, maxRounds);
        return status;
      }

      console.log(`[Chorus] Round ${round}: AMQ check (${mode})`);

      if (mode === "roundrobin") {
        let allEmpty = true;

        for (let i = 0; i < agentCount; i++) {
          const agent = agents[i];
          const label = agent.charAt(0).toUpperCase() + agent.slice(1);
          broadcastStatus("firing-agent", round, maxRounds, label);

          await fireToOneTab(agent, AMQ_CHECK_PROMPT, ceiling);
          await waitForAllResponses(deadTabTimeout);
          if (stopRequested) { broadcastStatus("stopped", round, maxRounds); return status; }

          const resp = lastResponses[agent];
          if (resp && resp !== "[TIMEOUT — no response]" && !responseIsEmpty(resp)) {
            allEmpty = false;
          }
        }

        status.push({ round, type: "roundrobin", allEmpty });
        broadcastStatus("complete", round, maxRounds);

        if (allEmpty) {
          console.log(`[Chorus] Round ${round}: all empty — terminating`);
          broadcastStatus("done-early", round, maxRounds);
          return status;
        }

      } else {
        // Simultaneous
        broadcastStatus("firing", round, maxRounds);
        const rN = await fireToAllTabs(AMQ_CHECK_PROMPT, ceiling);
        status.push({ round, type: "amq_check", results: rN });

        await waitForAllResponses(deadTabTimeout);
        broadcastStatus("complete", round, maxRounds);

        if (allResponsesEmpty()) {
          console.log(`[Chorus] Round ${round}: all empty — terminating`);
          broadcastStatus("done-early", round, maxRounds);
          return status;
        }
      }
    }

    broadcastStatus("done", maxRounds, maxRounds);
    return status;
  }

  function waitForAllResponses(timeoutMs) {
    return new Promise((resolve) => {
      if (allTabsComplete()) {
        resolve();
        return;
      }
      loopState = { resolve };

      if (timeoutMs && timeoutMs > 0) {
        setTimeout(() => {
          if (!allTabsComplete()) {
            const deadAgents = Object.values(pendingTabs);
            console.warn(`[Chorus] Dead-tab timeout: ${deadAgents.join(", ")} did not respond within ${timeoutMs}ms`);
            for (const agent of deadAgents) {
              lastResponses[agent] = "[TIMEOUT — no response]";
            }
            pendingTabs = {};
            if (loopState) {
              loopState.resolve();
              loopState = null;
            }
          }
        }, timeoutMs);
      }
    });
  }

  function broadcastStatus(state, round, maxRounds, agentLabel) {
    browser.runtime.sendMessage({
      type: "chorus:status",
      state,
      round,
      maxRounds,
      agentLabel: agentLabel || null,
    }).catch(() => {});
  }

  // ── Message Handlers ──

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.type === "chorus:response-complete") {
      const tabId = msg.tabId || (sender.tab && sender.tab.id);
      if (tabId && pendingTabs[tabId]) {
        const agent = pendingTabs[tabId];
        console.log(`[Chorus] ${agent} (tab ${tabId}) response complete`);

        if (msg.responseSnippet) {
          lastResponses[agent] = msg.responseSnippet;
          console.log(`[Chorus] ${agent} snippet: "${msg.responseSnippet.substring(0, 80)}..."`);
        }

        delete pendingTabs[tabId];

        if (allTabsComplete() && loopState) {
          loopState.resolve();
          loopState = null;
        }
      }
      return;
    }

    if (msg.type === "chorus:save-slots") {
      const incoming = (msg.slots || []).slice(0, MAX_SLOTS);
      slots = incoming.length >= MIN_SLOTS ? incoming : slots;
      saveSlots().then(() => {
        sendResponse({ success: true });
      });
      return true;
    }

    if (msg.type === "chorus:get-slots") {
      loadSlots().then(() => {
        sendResponse({ slots, sequence });
      });
      return true;
    }

    if (msg.type === "chorus:save-sequence") {
      sequence = msg.sequence || [];
      saveSequence().then(() => {
        sendResponse({ success: true });
      });
      return true;
    }

    if (msg.type === "chorus:fire") {
      const { text, rounds, mode, ceilingMs, sequence: seqArg } = msg;
      runLoop(
        text,
        rounds ?? 3,
        mode || "roundrobin",
        ceilingMs || 300000,
        seqArg || []
      ).then((status) => {
        sendResponse({ success: true, status });
      }).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
    }

    if (msg.type === "chorus:stop") {
      console.log("[Chorus] Stop requested by user");
      stopRequested = true;
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "chorus:list-claude-tabs") {
      browser.tabs.query({ url: "*://claude.ai/*" }).then((tabs) => {
        sendResponse(tabs.map(t => ({
          id: t.id,
          title: t.title,
          url: t.url,
        })));
      });
      return true;
    }
  });

  // Load slots/sequence on startup so storage is hydrated before first fire
  loadSlots().catch((e) => {
    console.error("[Chorus] Failed to load slots on startup:", e);
  });

  console.log("[Chorus] Background script v0.6.1 loaded (configurable slots, anonymous defaults, legacy migration)");
})();
