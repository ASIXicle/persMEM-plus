# Chorus — Changelog

## v0.6.1 — Anonymized defaults, configurable slot count

### Summary

v0.6.0 shipped configurable slot names but seeded them with the experiment's
historical defaults ("kite", "kestrel", "knot"). For public release, those
names had no place in the orchestrator code — they're identifying details
of one specific deployment, not part of the architecture.

v0.6.1 strips all default names. Slot count becomes user-controlled within
2–5. Migration from earlier installs preserves their existing slot data,
including the legacy `kite` / `wren` / `kestrel` / `knot` keys for users
upgrading from v0.5 or v0.6.0 — they appear as named slots that the user
can rename freely from the UI.

### What changed

**Defaults:**
- `DEFAULT_SLOT_NAMES` constant removed from both `sidebar.js` and
  `background.js`. Slot inputs now show placeholder text `"Slot N name"`
  but stored value is empty until the user types.
- Footer reads "configurable slots, anonymous defaults" instead of naming
  any specific instances.

**Slot count:**
- `MIN_SLOTS = 2`, `MAX_SLOTS = 5`. First-run starts with 2 empty slots.
- "+ Add Slot" button beneath the slot list, disabled when at MAX.
- "−" remove button on each slot row, disabled when at MIN.
- Sequence editor row count tracks slot count automatically.

**UI rendering:**
- Slot rows and sequence rows are now rendered dynamically by `sidebar.js`
  rather than being static HTML. The HTML provides `slot-container` and
  `seq-container` divs only.
- Adding/removing a slot rebuilds both containers and re-applies any
  saved tab assignments.

**Validation (unchanged in spirit, tightened in code):**
- Each slot must have a non-empty name on Assign.
- Slot names must be unique (case-insensitive, lowercased on read).
- At least `MIN_SLOTS` (2) slots must have tabs assigned to fire.
- Tab assignments must be unique across slots.
- Sequence cannot contain duplicate slots.

**Migration:**
- v0.5 `chorusTabMap` (flat dict) → v0.6.1 `chorusSlots` (array of objects).
  Every key in the legacy map becomes a named slot, preserving the user's
  original names. The legacy key is removed after successful migration.
- v0.6.0 `chorusSlots` (3-element array) loads as-is in v0.6.1. Users see
  their three slots; they can now add a fourth or fifth.

### What did NOT change

- `selectors.js` — unchanged.
- `icon.svg` — unchanged.
- `manifest.json` — version bumped to 0.6.1, description updated.
- AMQ wire format — unchanged.
- Prompt wrapping logic — unchanged.
- Stop-button behavior, dead-tab timeout, response-empty detection — unchanged.
- Storage key names (`chorusSlots`, `chorusSequence`) — unchanged.

### What also changed (review feedback, May 6)

After Kestrel's review of the initial v0.6.1 working tree:

- **`content.js` snippet filter:** prefix-startsWith (40 chars) was brittle for
  short prompts like AMQ_CHECK — a response that paraphrased the directive
  could trigger false positives. Replaced with whitespace-normalized exact
  match against `lastInjectedText`. Removes the brittleness without
  changing the data flow.
- **`sidebar.js` add/remove auto-save:** previously, structural changes
  (add slot, remove slot) didn't persist until the user clicked Assign.
  Closing the sidebar with a draft state silently restored the old config
  on next open. Now both `addSlot` and `removeSlot` save the new slot
  count to storage immediately. Content (names, tab assignments) still
  requires Assign — that distinction is intentional.
- **`sidebar.html`:** removed dead `selectors.js` import (sidebar context
  doesn't query the claude.ai DOM). Footer color darkened from `#444` to
  `#2a2a2a` for WCAG AA contrast against the body background.
- **`content.js` header comment:** version stamp updated to note the
  v0.6.1 snippet filter change.

### Test plan

1. **Fresh install**
   - Sideload `chorus/` into Firefox (about:debugging → Load Temporary Add-on
     → pick `manifest.json`).
   - Open Chorus sidebar. Verify 2 empty slots are shown by default.
   - Verify "+ Add Slot" is enabled and "−" remove buttons are disabled
     (at minimum count).
   - Add a slot. Verify count is 3, sequence editor shows 3 position rows,
     remove buttons become enabled.
   - Add two more slots (4, 5). Verify "+ Add Slot" disables at 5.
   - Remove one. Verify add re-enables.

2. **Slot assignment**
   - Open 2+ Claude.ai tabs.
   - Click "Refresh Claude Tabs".
   - Type unique names into 2 slots, assign them to different tabs.
   - Click "Assign Slots". Status should say "Slots assigned ✓ (2/N)".
   - Try assigning 0 tabs — should error "At least 2 slots must have tabs assigned".
   - Try duplicate names — should error "Slot names must be unique".
   - Try same tab in two slots — should error "All assigned tabs must be different".

3. **Sequence editor**
   - With 3 slots assigned, set firing sequence to non-default order.
   - Verify dropdowns reflect current slot names.
   - Rename a slot — verify sequence dropdowns update live.
   - Click "Reset to Slot Order" — verify sequence resets.

4. **Fire**
   - Type a test prompt. Fire All.
   - Verify each tab receives the prompt in the sequence order specified.
   - Verify AMQ messages from each instance get tagged with the correct slot name.

5. **Migration from v0.5**
   - Pre-condition: storage has `chorusTabMap = { kite: 123, wren: 456, knot: 789 }`
     from a v0.5 install.
   - Sideload v0.6.1.
   - On first sidebar open, verify three slots are shown with names "kite",
     "wren", "knot" and tabs preserved. Verify `chorusTabMap` is gone from
     storage and `chorusSlots` is present.
   - User can rename "wren" to "kestrel" or whatever they want.

6. **Migration from v0.6.0**
   - Pre-condition: storage has the v0.6.0 three-slot `chorusSlots` array.
   - Sideload v0.6.1. Verify three slots load with their names and tabs intact.
   - Verify "+ Add Slot" works to grow to 4 or 5 slots.

### Rollback

v0.6.1 storage keys are forward-compatible with v0.6.0 if slot count is 3.
If user has expanded to 4-5 slots, downgrading to v0.6.0 will load the first
3 only (the array is sliced at MAX_SLOTS=3 in v0.6.0). No data loss; trailing
slots are simply not shown.

---

## v0.6.0 — Configurable slots and sequence editor

### Summary

v0.5 hardcoded "Kite" and "Wren" as fixed slots, with a configurable third.
After the Wren → Kestrel transition this caused identity collisions in AMQ:
either run Kestrel-as-Wren (wrong attribution) or use the third slot (UI lies).

v0.6 replaces the hardcoded slots with three fully configurable slots and
adds a real sequence editor for round-robin order.

### What changed

**UI:**
- Three slots, each with editable name field (text input, defaults: kite / kestrel / knot)
  and a tab dropdown.
- "Fire First" dropdown removed.
- New "Firing Sequence" section with three position dropdowns (1st / 2nd / 3rd)
  that select from the configured slot names. "Reset to Slot Order" button.

**Storage shape:**
- Old: `chorusTabMap = { kite: 123, wren: 456, knot: 789 }`
- New: `chorusSlots = [{name, tabId}, {name, tabId}, {name, tabId}]`
- New: `chorusSequence = ["kite", "kestrel", "knot"]` (firing order)

**Migration (one-shot, automatic):**
On first load with v0.6, if `chorusTabMap` exists and `chorusSlots` does not:
- `kite` key → slot 1 (name preserved)
- `wren` key → slot 2 with renamed default "kestrel"
- `kestrel` key → slot 2 (name preserved)
- `knot` key → slot 3 (name preserved)
- Legacy `chorusTabMap` key removed after successful migration.

**Validation changes:**
- v0.5 required BOTH kite AND wren tabs assigned.
- v0.6 requires at least 2 slots have tabs assigned. Slots with names but no
  tabs are skipped gracefully during firing.

### What did NOT change in v0.6.0

- `content.js`, `selectors.js`, `icon.svg` — unchanged.
- AMQ wire format — unchanged.
- Round-0 vs Round-N prompt wrapping logic — unchanged.

### Known limitations resolved in v0.6.1

- Three slots was hardcoded. v0.6.1 makes count configurable 2–5.
- Default names baked the experiment's identities into the orchestrator.
  v0.6.1 removes them.
