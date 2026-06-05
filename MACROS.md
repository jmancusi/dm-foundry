# dm-sync — macro authoring guide

How to write a damage / healing macro that flows correctly into the DM campaign-prep tool. If you can describe what a macro needs to bundle, this doc tells you exactly how to build it so attribution, per-type damage, and the Apply workflow all "just work."

Read alongside [`EVENTS.md`](EVENTS.md) (the payload contract) and the `dmSync` helper in [`scripts/main.js`](scripts/main.js).

---

## The one rule: native first, macro as fallback

A macro is a **workaround for damage that core dnd5e won't bundle or fire conditionally**. Be realistic about what "native" actually does **out of the box** (no automation modules):

| Need | Core dnd5e (no modules)? | Macro needed? |
|---|---|---|
| A weapon's own damage, doubled on crit | ✅ native, automatic | No |
| A **static** always-on extra damage part on a weapon | ✅ native (add a damage part to the activity); doubles on crit | No |
| **Conditional rider** — Hunter's Mark only on a marked target | ❌ **not native.** Picking "Longbow attack" rolls the longbow only; nothing extra fires. Needs an automation stack (Midi-QOL / DAE / *Automated Conditions 5e* / *Better Curses*). | **Yes** |
| **Situational feature die** — Dread Ambusher (round 1 only), Sneak Attack, etc. | ❌ not native conditionally | **Yes** |
| Reroll-and-keep-higher (Savage Attacker) across a bundle | ❌ not native across mixed sources | **Yes** |

> **Reality check (learned the hard way):** earlier drafts of this doc claimed Hunter's Mark / Dread Ambusher could "usually" be native. They can't, in *core* dnd5e — targeting happens outside the action and the system does not add marked-target or first-round dice to a plain weapon attack. Making that automatic means adopting and babysitting a heavy automation module stack, which isn't worth it for a working table. **Conditional bundling is exactly what these macros are for — they're the correct tool, not a smell.**

What you *don't* need a separate macro for is **crit**: don't keep a doubled-dice "crit" copy of an attack as its own concept in the data — see [Crit variants](#crit-variants).

**The goal isn't "zero macros"** — it's that every macro flows through `dmSync.attackMessage` so its damage is tracked and attributable. The rest of this doc is the recipe.

---

## The contract: every attack macro calls `dmSync.attackMessage()`

A macro must **not** end in a bare `ChatMessage.create(...)`. That posts a card the module can't attribute — no attack record, no source label, no Apply buttons. Instead, hand your message data to `dmSync.attackMessage()`. It does three things:

1. Stamps the chat card with a `dm-sync` flag.
2. POSTs a `/attack` event (source label, typed components, targets, total) so the Laravel side knows the cause.
3. Triggers the module to inject **Apply Full / Half / None** (or **Apply Healing**) buttons onto the card.

```js
await dmSync.attackMessage({
  source:     "Longbow + Hunter's Mark + Dreadful Strike", // headline label, shown in breakdowns
  kind:       "damage",      // "damage" (default) or "healing"
  total:      totalDamage,   // MUST equal the sum of component amounts
  components: [              // itemize per source, each TYPED — this drives the per-type breakdown
    { label: "Longbow",         type: "piercing", amount: weaponDie.total + dexBonus },
    { label: "Hunter's Mark",   type: "piercing", amount: huntersMarkDie.total },
    { label: "Dreadful Strike", type: "psychic",  amount: dreadfulStrikeDie.total },
  ],
  message:    rollData,      // your existing ChatMessage.create payload: { content, rolls, speaker, sound, ... }
  // optional:
  // targets:   [actorUuid, ...]  // defaults to a snapshot of game.user.targets
  // crit:      false             // pass true if this was a critical hit
  // attack_id: "..."             // defaults to a random id; only set to dedupe a re-run
});
```

`message` is your **entire** existing `ChatMessage.create()` payload — so you keep your custom card, art, percentile meter, sounds, everything. `attackMessage` just wraps it.

### Field rules that matter

- **`components` must be typed.** Use real dnd5e damage types (`piercing`, `slashing`, `bludgeoning`, `fire`, `cold`, `psychic`, `radiant`, `necrotic`, `force`, `poison`, `acid`, `lightning`, `thunder`). This is what lets the tool split "26 damage" into "17 piercing / 9 psychic" and reason about resistances. Untyped or one lumped component throws that away.
- **Itemize per source, not per die.** One component per meaningful source (the weapon, the rider, the feature). Fold flat modifiers (Dex, etc.) into their weapon's component.
- **`total` must equal the sum of component amounts** and match what the card shows. The tool reconciles them.
- **`kind: "healing"`** for healing macros — amounts stay positive; the module flips the sign on apply.
- **Targets:** target the token(s) before running the macro (normal targeting, the crosshair). The attack snapshots `game.user.targets`. If you forget, the Apply buttons fall back to whatever you have targeted at click time.

### Crit variants

A crit isn't a different attack — it's the same attack with the dice doubled. When you keep a separate "crit" copy of a macro (the doubled-dice version), give it the **same `source` as its normal version** and just set **`crit: true`**:

```js
// normal:  source: "Longbow + Hunter's Mark",  crit: false
// crit:    source: "Longbow + Hunter's Mark",  crit: true
```

Keeping `source` identical means the by-action breakdown aggregates crit and non-crit hits under one label (e.g. all "Longbow + Hunter's Mark" damage together) instead of splitting "Longbow (Crit)" into its own wedge — while `crit` stays queryable on the attack record. The doubled dice are already in `total`/`components`, so nothing else changes.

> If you're maintaining a 2×2 of macros (mode × crit), that's fine — it's a content choice, not a tracking concern. They all carry the same two `source` labels; only `crit` differs.

---

## The Apply workflow (this is where attribution is won)

After the card posts, **apply damage by clicking the card's Apply Full / Half / None buttons** — with the target token(s) targeted or selected.

Those buttons route through dnd5e's `applyDamage`, which fires the hook the module listens for, so the resulting damage is stamped with the **correct attacker** (the card's actor), the **attack_id**, `attributed_by: "click"`, and a per-type breakdown scaled for Half/resistance.

**Do not apply combat damage with the raw "Quick Damage / Healing" macro.** That macro writes HP directly (`actor.update`) with no attacker and no link to the roll — the tool is then forced to *guess* the source from whose turn it is, which mis-credits companions, reactions, and anything applied a beat late. The quick macro is a **fallback only**, for damage that never had a card (environmental, "just take 10", narrative).

> Decision stays yours. Full / Half / None is exactly the DM call (resisted? saved for half? missed?) — you make it at click time, the same as a native card. The macro never decides damage for you.

---

## Template

```js
// === <Character> — <attack name> ===

// 1. Roll everything this bundle needs.
const weaponDie = new Roll("1d8"); await weaponDie.evaluate();
// ...more dice...

// 2. Compute per-type totals.
const piercing = weaponDie.total + /* mods */ 0;
const psychic  = /* ... */ 0;
const total    = piercing + psychic;

// 3. (Optional) build your custom card content + handle resource bookkeeping
//    (decrement feature uses, play sounds, etc.) — all fine, it's local actor state.
const rollData = {
  speaker: ChatMessage.getSpeaker(),
  content: /* your HTML */ "",
  rolls:   [weaponDie /*, ... */],
  sound:   CONFIG.sounds.dice,
};

// 4. Hand off to dm-sync instead of ChatMessage.create.
await dmSync.attackMessage({
  source:     "<headline label>",
  kind:       "damage",
  total,
  components: [
    { label: "<source>", type: "<damage-type>", amount: piercing },
    // ...
  ],
  message:    rollData,
});

// 5. At the table: target the mob → click Apply Full / Half / None on the card.
```

### Worked example — migrating the Daeris opening-round macro

Everything in the existing macro stays (the rolls, the custom card HTML, the sound, the Dread Ambusher uses decrement). **Only the final `ChatMessage.create(rollData)` changes:**

```js
// BEFORE:
ChatMessage.create(rollData);

// AFTER:
await dmSync.attackMessage({
  source:     "Longbow + Hunter's Mark + Dreadful Strike",
  kind:       "damage",
  total:      totalDamage,
  components: [
    { label: "Longbow",         type: "piercing", amount: weaponDie.total + dexBonus },
    { label: "Hunter's Mark",   type: "piercing", amount: huntersMarkDie.total },
    { label: "Dreadful Strike", type: "psychic",  amount: dreadfulStrikeDie.total },
  ],
  message:    rollData,
});
```

Then target the mob and click **Apply Full / Half / None** instead of running the quick-damage macro.

---

## Anti-patterns

| Don't | Why | Do instead |
|---|---|---|
| End an attack macro in `ChatMessage.create(...)` | No attack record, no source label, no Apply buttons → damage logs as `none` | `dmSync.attackMessage({ ..., message })` |
| Apply combat damage via the raw-HP quick macro | No attacker, no link → tool guesses the source by turn (mis-credits companions/reactions) | Click the card's Apply Full/Half/None |
| One lumped `{ type: "none", amount: total }` component | Loses the per-type breakdown and resistance reasoning | One typed component per source |
| `total` ≠ sum of components | Tool can't reconcile the breakdown | Keep them equal |
| Heavy work or `await fetch` in a frequently-firing hook | UI hitches at the table (see CLAUDE.md §0) | Macros are user-triggered, so fine — but never add hooks here |

> **Escape hatch:** a DM admin macro that should never log can set `flags.dm_sync_ignore = true` on its message — the module skips it entirely.

---

## Known limitation: multi-type apply

The module's **injected** Apply buttons apply the whole amount as the **first component's damage type** (e.g. all of Daeris' 26 as piercing). For a creature resistant to *only one* of the bundled types, that's slightly off at apply time. The logged breakdown is still correctly per-type; only the HP math is approximate.

dnd5e's **native** damage tray handles multi-type resistance correctly. This is the strongest argument for the native-first rule above: the more an attack is modeled as a real activity, the more correct the table math becomes. (v0.4 of the module may improve the injected buttons to apply per-type — tracked in the EVENTS spec.)

---

## How to request a new macro

When you need one, specify it in these terms and it maps 1:1 to `dmSync.attackMessage`:

- **Character & attack name** → `source` (the headline label)
- **Each bundled source**: name + dice/formula + **damage type** → one `components` entry
- **Damage or healing?** → `kind`
- **Single or multi-target?** (affects targeting workflow)
- **Any resource to spend** (feature uses, spell slot, ammo) → local bookkeeping in the macro
- **Any conditional rider** (only on first round, only when target is marked, reroll-and-keep-higher) → note it; we check whether native can do it before writing a macro at all

Example request → build:
> "Daeris needs a sustained-round macro: Longbow 1d8+5 piercing, Hunter's Mark 1d6 piercing. No Dreadful Strike after round 1."

→ two components (`Longbow`/piercing, `Hunter's Mark`/piercing), `kind: "damage"`, `total` = their sum, no resource decrement.

---

## Reference: the Daeris longbow family (fully migrated)

The four macros in `dm/macros/daeris/` are the worked reference for the **single-target bundled weapon attack**, all migrated to `dmSync.attackMessage`:

| File | source | crit | components |
|---|---|---|---|
| `hunters-mark+bow+no-crit` | Longbow + Hunter's Mark | `false` | Longbow (piercing), Hunter's Mark (piercing) |
| `hunters-mark+bow-crit` | Longbow + Hunter's Mark | `true` | same (dice doubled) |
| `oepning-round-no-crit` | Longbow + Hunter's Mark + Dreadful Strike | `false` | + Dreadful Strike (psychic) |
| `opening-round-crit` | Longbow + Hunter's Mark + Dreadful Strike | `true` | + Dreadful Strike (psychic) |

Sustained vs. opening-round = which riders are in the bundle; crit vs. non-crit = the `crit` flag (same `source`). Dex is folded into the Longbow component.

## Variants still to document

Folded in so far: the bundled single-target attack + crit variants (above) and the quick-apply fallback. Still to capture from the remaining macros:

- **Healing macros** (`kind: "healing"`, Apply Healing button).
- **Savage Attacker / reroll-and-keep-higher** — how to evaluate two rolls and report the kept one (Shargalar — next).
- **Save-for-half / AOE multi-target** — targeting and per-target application.
