/**
 * sidebar.js — Chorus Sidebar Logic v0.6.1
 *
 * Configurable slots (2 minimum, 5 maximum) with full sequence editor.
 * Slot names are user-supplied; no defaults are baked in. Placeholders
 * read "Slot N name" but the empty value is rejected on assign.
 *
 * Backward-compat: the legacy chorusTabMap migration in background.js
 * preserves any existing v0.5/v0.6 storage on first load. Users with
 * prior installs see their previously-assigned tabs and names appear
 * in slots 1-3 automatically. After that, they can rename, add more
 * (up to 5), or remove (down to 2).
 */

(() => {
  "use strict";

  // ── Slot count bounds ──
  const MIN_SLOTS = 2;
  const MAX_SLOTS = 5;

  // ── DOM refs (containers; rows are dynamic) ──
  const slotContainer = document.getElementById("slot-container");
  const seqContainer  = document.getElementById("seq-container");

  const btnRefresh = document.getElementById("btn-refresh");
  const btnAddSlot = document.getElementById("btn-add-slot");
  const btnAssign  = document.getElementById("btn-assign");
  const btnResetSeq = document.getElementById("btn-reset-seq");
  const inputMsg   = document.getElementById("input-msg");
  const inputRounds = document.getElementById("input-rounds");
  const inputCeiling = document.getElementById("input-ceiling");
  const selMode    = document.getElementById("sel-mode");
  const btnFire    = document.getElementById("btn-fire");
  const btnStop    = document.getElementById("btn-stop");
  const statusEl   = document.getElementById("status");
  const roundEl    = document.getElementById("round-display");

  let firing = false;
  let availableTabs = [];   // cached from list-claude-tabs
  let currentSlotCount = MIN_SLOTS;  // grows up to MAX_SLOTS

  // ── Helpers ──
  function setStatus(cls, text) {
    statusEl.className = `status ${cls}`;
    statusEl.textContent = text;
  }

  function getSlotNameInputs() {
    return Array.from(slotContainer.querySelectorAll("input.slot-name"));
  }

  function getSlotSelects() {
    return Array.from(slotContainer.querySelectorAll("select.slot-select"));
  }

  function getSeqSelects() {
    return Array.from(seqContainer.querySelectorAll("select.seq-select"));
  }

  function getSlotName(idx) {
    const inputs = getSlotNameInputs();
    if (!inputs[idx]) return "";
    return (inputs[idx].value || "").trim().toLowerCase();
  }

  // ── Render slot rows ──
  function renderSlotRow(idx, slot) {
    const row = document.createElement("div");
    row.className = "slot-row";
    row.dataset.slotIdx = String(idx);

    const tag = document.createElement("span");
    tag.className = "slot-tag";
    tag.textContent = String(idx + 1);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "slot-name";
    nameInput.placeholder = `Slot ${idx + 1} name`;
    nameInput.maxLength = 12;
    if (slot && slot.name) nameInput.value = slot.name;

    const select = document.createElement("select");
    select.className = "slot-select";
    populateTabSelect(select, slot && slot.tabId ? String(slot.tabId) : "");

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-remove";
    removeBtn.textContent = "−";
    removeBtn.title = "Remove this slot";
    removeBtn.addEventListener("click", () => removeSlot(idx));

    row.appendChild(tag);
    row.appendChild(nameInput);
    row.appendChild(select);
    row.appendChild(removeBtn);

    // Live-update sequence dropdowns when a name changes
    nameInput.addEventListener("input", refreshSequenceOptions);

    return row;
  }

  function renderSeqRow(idx) {
    const row = document.createElement("div");
    row.className = "seq-row";

    const tag = document.createElement("span");
    tag.className = "seq-tag";
    tag.textContent = ordinal(idx + 1);

    const select = document.createElement("select");
    select.className = "seq-select";
    select.dataset.seqIdx = String(idx);
    select.innerHTML = '<option value="">—</option>';
    select.addEventListener("change", saveSequence);

    row.appendChild(tag);
    row.appendChild(select);

    return row;
  }

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function populateTabSelect(select, selectedValue) {
    select.innerHTML = '<option value="">—</option>';
    for (const tab of availableTabs) {
      const opt = document.createElement("option");
      opt.value = String(tab.id);
      const title = (tab.title || "Claude").substring(0, 50);
      opt.textContent = `[${tab.id}] ${title}`;
      select.appendChild(opt);
    }
    if (selectedValue) select.value = selectedValue;
  }

  function rebuildSlots(slots) {
    slotContainer.innerHTML = "";
    const count = Math.max(MIN_SLOTS, Math.min(MAX_SLOTS, slots.length || MIN_SLOTS));
    currentSlotCount = count;

    for (let i = 0; i < count; i++) {
      slotContainer.appendChild(renderSlotRow(i, slots[i]));
    }

    rebuildSeqRows(count);
    updateAddRemoveButtonStates();
  }

  function rebuildSeqRows(count) {
    seqContainer.innerHTML = "";
    for (let i = 0; i < count; i++) {
      seqContainer.appendChild(renderSeqRow(i));
    }
    refreshSequenceOptions();
  }

  function updateAddRemoveButtonStates() {
    const rows = slotContainer.querySelectorAll(".slot-row");
    btnAddSlot.disabled = rows.length >= MAX_SLOTS;

    // Enable remove only when above the minimum
    const removeBtns = slotContainer.querySelectorAll(".btn-remove");
    for (const btn of removeBtns) {
      btn.disabled = rows.length <= MIN_SLOTS;
    }
  }

  function addSlot() {
    if (currentSlotCount >= MAX_SLOTS) return;
    const idx = currentSlotCount;
    slotContainer.appendChild(renderSlotRow(idx, null));
    currentSlotCount++;
    rebuildSeqRows(currentSlotCount);
    updateAddRemoveButtonStates();

    // Persist the count change so it survives sidebar close.
    // Content (names, tab assignments) still requires Assign to commit.
    const slots = getSlotNameInputs().map((inp, i) => ({
      name: (inp.value || "").trim(),
      tabId: getSlotSelects()[i].value ? parseInt(getSlotSelects()[i].value, 10) : 0,
    }));
    browser.runtime.sendMessage({
      type: "chorus:save-slots",
      slots: slots,
    });
  }

  function removeSlot(idx) {
    if (currentSlotCount <= MIN_SLOTS) return;

    // Capture current state from DOM
    const names = getSlotNameInputs().map(inp => inp.value);
    const tabIds = getSlotSelects().map(sel => sel.value);

    // Drop the removed index
    names.splice(idx, 1);
    tabIds.splice(idx, 1);

    // Rebuild
    const slots = names.map((n, i) => ({
      name: (n || "").trim(),
      tabId: tabIds[i] ? parseInt(tabIds[i], 10) : 0,
    }));
    currentSlotCount = slots.length;
    slotContainer.innerHTML = "";
    for (let i = 0; i < slots.length; i++) {
      slotContainer.appendChild(renderSlotRow(i, slots[i]));
    }
    rebuildSeqRows(currentSlotCount);
    updateAddRemoveButtonStates();

    // Persist immediately so closing the sidebar without Assign doesn't
    // silently restore the removed slot from stale storage on next open.
    // Names may be empty here (user hadn't typed yet) — that's fine, the
    // user re-opens and sees the same draft state they left.
    browser.runtime.sendMessage({
      type: "chorus:save-slots",
      slots: slots,
    });
    saveSequence();
  }

  // ── Sequence editor population ──
  function refreshSequenceOptions() {
    const names = getSlotNameInputs().map(inp => (inp.value || "").trim().toLowerCase()).filter(Boolean);
    const seqSelects = getSeqSelects();

    for (let i = 0; i < seqSelects.length; i++) {
      const sel = seqSelects[i];
      const current = sel.value;
      sel.innerHTML = '<option value="">—</option>';
      for (const name of names) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      }
      // Restore prior selection if still valid; otherwise default to position
      if (names.includes(current)) {
        sel.value = current;
      } else {
        sel.value = names[i] || "";
      }
    }
  }

  function resetSequenceToSlotOrder() {
    const names = getSlotNameInputs().map(inp => (inp.value || "").trim().toLowerCase());
    const seqSelects = getSeqSelects();
    for (let i = 0; i < seqSelects.length; i++) {
      seqSelects[i].value = names[i] || "";
    }
    saveSequence();
  }

  async function saveSequence() {
    const seq = getSeqSelects().map(s => s.value);
    await browser.runtime.sendMessage({
      type: "chorus:save-sequence",
      sequence: seq,
    });
  }

  // ── Refresh available Claude tabs ──
  async function refreshTabs() {
    availableTabs = await browser.runtime.sendMessage({
      type: "chorus:list-claude-tabs",
    }) || [];

    // Re-populate existing slot selects, preserving current selection
    for (const sel of getSlotSelects()) {
      const currentVal = sel.value;
      populateTabSelect(sel, currentVal);
    }

    // Restore saved slot config
    const saved = await browser.runtime.sendMessage({
      type: "chorus:get-slots",
    });

    if (saved && Array.isArray(saved.slots) && saved.slots.length >= MIN_SLOTS) {
      rebuildSlots(saved.slots);

      // Restore saved sequence if present and matches slot count
      if (saved.sequence && Array.isArray(saved.sequence)) {
        const seqSelects = getSeqSelects();
        for (let i = 0; i < seqSelects.length && i < saved.sequence.length; i++) {
          if (saved.sequence[i]) seqSelects[i].value = saved.sequence[i];
        }
      }
    } else {
      // First run: render minimum number of empty slots
      rebuildSlots([]);
    }
  }

  // ── Assign slots ──
  async function assignSlots() {
    const nameInputs = getSlotNameInputs();
    const slotSelects = getSlotSelects();

    const slots = [];
    const names = [];
    const tabIds = [];
    let assignedCount = 0;

    for (let i = 0; i < nameInputs.length; i++) {
      const name = (nameInputs[i].value || "").trim().toLowerCase();
      const tabIdStr = slotSelects[i].value;
      const tabId = tabIdStr ? parseInt(tabIdStr, 10) : 0;

      if (!name) {
        setStatus("error", `Slot ${i + 1} needs a name`);
        return;
      }
      if (names.includes(name)) {
        setStatus("error", `Slot names must be unique ("${name}" repeats)`);
        return;
      }
      names.push(name);

      slots.push({ name: name, tabId: tabId });
      if (tabId) {
        tabIds.push(tabId);
        assignedCount++;
      }
    }

    if (assignedCount < MIN_SLOTS) {
      setStatus("error", `At least ${MIN_SLOTS} slots must have tabs assigned`);
      return;
    }

    const uniqTabs = new Set(tabIds);
    if (uniqTabs.size !== tabIds.length) {
      setStatus("error", "All assigned tabs must be different");
      return;
    }

    await browser.runtime.sendMessage({
      type: "chorus:save-slots",
      slots: slots,
    });

    refreshSequenceOptions();
    await saveSequence();

    setStatus("complete", `Slots assigned ✓ (${assignedCount}/${slots.length})`);
  }

  // ── Fire ──
  async function fire() {
    const text = inputMsg.value.trim();
    if (!text) {
      setStatus("error", "Enter a message");
      return;
    }

    const _r = parseInt(inputRounds.value, 10);
    const rounds = Number.isFinite(_r) ? _r : 3;
    const _c = parseInt(inputCeiling.value, 10);
    const ceilingSec = Number.isFinite(_c) ? _c : 300;
    const ceilingMs = ceilingSec * 1000;
    const mode = selMode.value || "roundrobin";

    // Build sequence from selectors. Empty = skip.
    const sequence = getSeqSelects().map(s => s.value).filter(Boolean);

    // Sequence validation: no duplicates
    const seqSet = new Set(sequence);
    if (seqSet.size !== sequence.length) {
      setStatus("error", "Sequence has duplicate slots");
      return;
    }

    firing = true;
    btnFire.disabled = true;
    btnFire.textContent = "Running...";
    btnStop.style.display = "block";
    setStatus("firing", `Sending (${mode}, ${ceilingSec}s ceiling)...`);

    try {
      const result = await browser.runtime.sendMessage({
        type: "chorus:fire",
        text: text,
        rounds: rounds,
        mode: mode,
        ceilingMs: ceilingMs,
        sequence: sequence,
      });

      if (result.success) {
        setStatus("complete", "All rounds complete ✓");
      } else {
        setStatus("error", result.error || "Failed");
      }
    } catch (e) {
      setStatus("error", e.message);
    } finally {
      firing = false;
      btnFire.disabled = false;
      btnFire.textContent = "▶ Fire All";
      btnStop.style.display = "none";
    }
  }

  // ── Status updates from background ──
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "chorus:status") {
      const { state, round, maxRounds, agentLabel } = msg;

      if (state === "firing") {
        const label = round === 0 ? "Initial prompt" : `Exchange ${round}`;
        setStatus("firing", `${label} — waiting...`);
        roundEl.textContent = `${round} / ${maxRounds}`;
      } else if (state === "firing-agent") {
        const label = agentLabel || "agent";
        setStatus("firing", `Exchange ${round} — ${label} responding...`);
        roundEl.textContent = `${round} / ${maxRounds}`;
      } else if (state === "complete") {
        const label = round === 0 ? "Initial" : `Exchange ${round}`;
        setStatus("complete", `${label} complete`);
      } else if (state === "done") {
        setStatus("complete", "All exchanges complete ✓");
        roundEl.textContent = "";
      } else if (state === "done-early") {
        setStatus("complete", "All empty — stopped at exchange " + round + " ✓");
        roundEl.textContent = "";
      } else if (state === "stopped") {
        setStatus("complete", "Stopped by user at exchange " + round + " ✓");
        roundEl.textContent = "";
      } else if (state === "skipped") {
        console.log(`[Chorus] Skipped agent: ${agentLabel}`);
      }
    }
  });

  // ── Events ──
  btnRefresh.addEventListener("click", refreshTabs);
  btnAddSlot.addEventListener("click", addSlot);
  btnAssign.addEventListener("click", assignSlots);
  btnResetSeq.addEventListener("click", resetSequenceToSlotOrder);
  btnFire.addEventListener("click", fire);
  btnStop.addEventListener("click", function() {
    browser.runtime.sendMessage({ type: "chorus:stop" });
    setStatus("complete", "Stopped by user ✓");
    btnStop.style.display = "none";
  });

  inputMsg.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !firing) {
      e.preventDefault();
      fire();
    }
  });

  refreshTabs();
})();
