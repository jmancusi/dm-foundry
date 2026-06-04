# dm-sync v0.4 — telemetry expansion spec (DRAFT)

Planning spec for the next module bump. Goal: **capture as much structured signal per action as Foundry exposes**, log state rather than infer structure, and let the Laravel side decide later what to surface or ignore. When built, fold the relevant parts into `EVENTS.md` and bump `module.json` to `0.4.0`.

Status: **draft for review** — nothing here is implemented yet. Hook signatures verified against Foundry v13/v14 (`hookEvents`) and dnd5e v5 (system Hooks wiki).

---

## Design principles

1. **Log state, never infer structure.** Initiative order is dynamic (combatants die, get added, re-roll). So we never store a static "turn 5 = Chomper" map — we snapshot *who is actually active* on every turn change, and the current order whenever it changes. Reconstruction happens on the Laravel side from the event stream.
2. **Assert, don't guess.** Every signal that identifies an actor (attacker, target, who's up) is captured from a hook that *knows* it, and logged as its own field. The turn-based attacker guess remains only as a last resort, and is now corrected (see §Robustness).
3. **Capture wide, filter later.** New events fire whether or not they're "interesting." The Laravel side filters. Per Jimmy: "the more we log, the more we can make sense of it."
4. **Additive & backwards-compatible.** v0.4 adds new events, new endpoints, and new fields on existing payloads. No existing field changes meaning. A v0.3.1 Laravel backend keeps working (it just ignores the new stuff).
5. **The UI thread stays sacred.** All new posts are fire-and-forget (CLAUDE.md §0). Frequently-firing hooks are gated and deduped.
6. **Correct multi-client emission.** Hooks fire on different sets of clients depending on type — get it wrong and you either duplicate rows or silently drop player actions. See [§Emission model](#emission-model-multi-client).

---

## Emission model (multi-client)

Everyone in this game is remote with a client open, so emission matters: each hook fires on a *different set* of clients, and the wrong rule either duplicates rows or drops player actions. **Verified against last session's real data — zero duplicate damage events, zero duplicate rolls, zero duplicate attacks** — so the current design already single-emits correctly. v0.4 must preserve that, per hook type.

**A. Document-propagation hooks** — `updateActor`, `createChatMessage`, `combatTurnChange`, `combatRound`, `create/update/deleteCombatant`, `create/update/deleteActiveEffect`. These fire on **all** connected clients when the change propagates; the GM's client always sees them.
- Dedup rule: a natural **idempotency key** (rolls use `(campaign, uuid, roll_index)` → safe even if every client posts), or where there's no key, **emit only from the active GM** (`game.user === game.users.activeGM`). The new turn/round/combatant/effect streams are append-only with no clean key → **GM-emitter**. Nothing is lost because the GM always sees document hooks.
- The existing **damage path** already single-emits by a neat accident: `preUpdateActor` (which fills `hpCache`) fires *only on the initiating client*, while `updateActor` (which reads it and posts) fires on all — so non-initiators miss the cache and suppress. That's why there are no doubles. Keep it; it correctly credits whoever applied, GM or player.

**B. Workflow hooks** — `dnd5e.useActivity`, `dnd5e.restCompleted`, `dnd5e.calculateDamage`, the `dnd5e.roll*` hooks. These fire **only on the acting user's client** — the GM's client does *not* fire them. This is your Q4 intuition exactly: **they must run on everyone, ungated.** GM-gating them would drop every player-initiated activity/rest. They fire exactly once (one client), so no duplication.
- `calculateDamage` is special-but-fine: it fires on the *applying* client, which is the same client that posts the damage event (the `hpCache` originator) — so its `pendingBreakdown` stash is read back on the same client. Correlates without a gate.

**Rule of thumb:** structural / combat / effect state → **GM-emitter**; player workflow actions → **acting-client, ungated**; damage → **unchanged** (originator via `hpCache`).

---

## New / changed hooks

Added to the EVENTS.md "Hooks listened to" table:

| Hook | Posts? | What we send |
|---|---|---|
| `combatTurnChange(combat, prior, current)` | Yes | `POST /combat` `event="turn"` — snapshot of who's now active + the current turn order. GM-emitter only. |
| `combatRound(combat, updateData, updateOptions)` | Yes | `POST /combat` `event="round"` — round advance/rewind with direction. GM-emitter only. |
| `createCombatant` / `deleteCombatant` / `updateCombatant` | Yes | `POST /combat` `event="combatant"` — add / remove / initiative-or-defeated change. GM-emitter only. (Existing `defeated→synthetic kill` path on `updateCombatant` is unchanged.) |
| `dnd5e.useActivity` | Yes | `POST /activity` — every activity used (attack, spell, feature, even non-damage). The action-economy log. **Acting-client emit** — fires only on the user's client; do NOT GM-gate or player actions are lost. |
| `createActiveEffect` / `updateActiveEffect` / `deleteActiveEffect` | Yes | `POST /effect` — conditions, buffs, **and concentration** (concentration is itself an active effect; detect via `statuses`/dnd5e flags rather than a separate hook, to keep one source). **GM-emitter** (document hook, fires on all clients). |
| `dnd5e.calculateDamage(actor, damages, options)` | No | Stashes the **typed `damages` array** into a `pendingBreakdown` map; `updateActor` reads it to attach a native per-type `damage_type_breakdown`. Fires on the applying client (same one that posts the damage event). |
| `dnd5e.restCompleted(actor, result, config)` | Yes | `POST /rest` — short/long rest recovery (HP, slots, hit dice). **Acting-client emit.** |
| death saves | Yes (enrich) | No new hook — enrich the existing death-save `/roll` (already flows via `createChatMessage`) with success/failure + running 0–3 count read from the message's dnd5e flags. |

**Not their own event stream (too noisy, low standalone value):** `targetToken` and `controlToken`. Targeting and selection are captured as **envelope fields** on real events instead (see below) by reading `game.user.targets` / `canvas.tokens.controlled` at emit time.

---

## The shared `context` envelope

A reusable block attached to combat-relevant events (`/combat` damage/healing/turn/round/combatant, `/attack`, `/activity`, `/effect`). Everything here is captured from live state at emit time and logged **separately** from the asserted attacker — so the Laravel side always has both "who the system says did it" and "what was going on."

```json
"context": {
  "round":                 2,
  "turn":                  5,
  "active_combatant_uuid": "Scene.x.Token.y.Actor.Ekwh8p6vXtBIPEKi",
  "active_combatant_name": "Chomper",
  "acting_user_id":        "user_abc",
  "targets":  [ { "uuid": "Scene.x.Token.z.Actor.6Qj...", "name": "Pterafolk" } ],
  "selected": [ { "uuid": "Scene.x.Token.y.Actor.Ekwh...", "name": "Chomper" } ]
}
```

- `active_combatant_*` — `game.combats.active.combatant` at emit time. **Always logged**, even on a click-attributed damage event, so we can see "applied during turn 5" vs. the asserted attacker.
- `acting_user_id` — the `userId` the hook provides (or `game.user.id`). Lets us see who drove the action.
- `targets` — `game.user.targets` snapshot (the crosshair targets of the acting user).
- `selected` — `canvas.tokens.controlled` snapshot (the acting GM's selected tokens; array).

> Why both targets and selected: they diverge constantly (you target a mob with the crosshair but have your own token selected). Logging both lets us disambiguate later.

This **supersedes** the loose top-level `round`/`turn`/`target_uuids` on existing payloads — those stay for backwards compatibility but `context` is the richer source.

---

## Changed: `/combat` `event="damage"` / `"healing"`

Three additions:

1. **`context` block** (above).
2. **Native per-type `damage_type_breakdown`.** Today this is `null` for native attacks. v0.4 hooks `dnd5e.calculateDamage` to capture the post-resistance typed `damages` array into a `pendingBreakdown` map keyed by `actor.uuid` (mirroring `pendingApply`); `updateActor` consumes it within the same 2s window. So a native bite that lands 8 piercing now carries:
   ```json
   "damage_type_breakdown": [ { "type": "piercing", "amount": 8 } ]
   ```
3. **Corrected heuristic attacker** (see §Robustness) — when attribution falls back to the heuristic, `attacker_uuid` now comes from the matched attack's actor, not the active combatant.

---

## New `/combat` event types

### `event: "turn"` — turn-change snapshot
From `combatTurnChange(combat, prior, current)`. The dynamic-order fix: we record the actual active combatant and order *every time the turn advances*.

```json
{
  "uuid":  "Combat.abc",
  "event": "turn",
  "round": 2,
  "turn":  5,
  "active_combatant_uuid": "Scene.x.Token.y.Actor.Ekwh...",
  "active_combatant_name": "Chomper",
  "prior_combatant_uuid":  "Scene.x.Token.w.Actor.s94d...",
  "turn_order": [
    { "uuid": "Actor.daeris",  "name": "Daeris",  "initiative": 21, "defeated": false, "hidden": false },
    { "uuid": "Actor.chomper", "name": "Chomper", "initiative": 17, "defeated": false, "hidden": false },
    { "uuid": "Actor.kinren",  "name": "Kinren",  "initiative": 12, "defeated": false, "hidden": false }
  ],
  "occurred_at": 1735776000000
}
```

`turn_order` is `combat.turns` mapped at emit time — captures reorders, mid-fight joins, and defeated/skipped combatants as they actually are. With this stream, the Laravel side can label *every* prior damage event with the correct combatant for that round/turn, retroactively — and we'd never have shipped the Chomper cross.

### `event: "round"` — round advance
From `combatRound`. Carries `direction` (1 advance / -1 rewind) so we don't double-count on rewinds.

```json
{ "uuid": "Combat.abc", "event": "round", "round": 3, "direction": 1, "occurred_at": 1735776000000 }
```

### `event: "combatant"` — combatant lifecycle
From `createCombatant` / `deleteCombatant` / `updateCombatant`. Captures mid-fight joins, removals, initiative changes, and defeated flags (your "Chomper was 5th, now 1st" case).

```json
{
  "uuid":         "Combat.abc",
  "event":        "combatant",
  "action":       "added",          // "added" | "removed" | "updated"
  "actor_uuid":   "Scene.x.Token.y.Actor.Ekwh...",
  "display_name": "Chomper",
  "initiative":   17,
  "defeated":     false,
  "round":        2,
  "turn":         5,
  "occurred_at":  1735776000000
}
```

---

## New endpoint: `POST /activity`

From `dnd5e.useActivity` / `postUseActivity(activity, usageConfig, results)`. The action-economy log — *what* each combatant did each turn, damage or not (Dash, Hide, cast a non-damage spell, use a feature). Fires in or out of combat (`context.round`/`turn` null when no combat).

```json
{
  "activity_uuid":   "Actor.daeris.Item.longbow.Activity.attack1",
  "activity_type":   "attack",            // attack | damage | save | heal | utility | summon | ...
  "activity_name":   "Longbow Attack",
  "actor_uuid":      "Actor.daeris",
  "actor_name":      "Daeris",
  "item_uuid":       "Actor.daeris.Item.longbow",
  "item_name":       "Longbow",
  "consumed": {
    "uses":          { "item_uuid": "Actor.daeris.Item.dreadAmbusher", "delta": 1 },
    "spell_slot":    null,
    "resource":      null
  },
  "context": { /* shared envelope */ },
  "occurred_at": 1735776000000
}
```

> `consumed` is best-effort from `usageConfig`/`results`; null sub-fields are fine. Even a bare "actor X used activity Y at round/turn Z" is valuable.

---

## New endpoint: `POST /effect`

From the active-effect hooks and the concentration hooks. Conditions (prone, poisoned, blessed, frightened), concentration (Hunter's Mark!), and any active effect lifecycle.

```json
{
  "action":      "applied",          // applied | changed | removed
  "kind":        "condition",        // condition | concentration | effect
  "actor_uuid":  "Actor.kinren",
  "actor_name":  "Kinren",
  "effect_name": "Poisoned",
  "statuses":    ["poisoned"],       // dnd5e status ids when present
  "origin":      "Actor.daeris.Item.huntersMark",   // the item/spell that caused it, when known
  "duration":    { "rounds": 10, "seconds": 60 },
  "context":     { /* shared envelope */ },
  "occurred_at": 1735776000000
}
```

- **Concentration is captured here, not via a separate hook.** dnd5e implements concentration as an active effect, so `createActiveEffect`/`deleteActiveEffect` already fire for it (on all clients incl. the GM). Detect it via the effect's `statuses`/dnd5e flags and set `kind="concentration"`, `origin` = the concentrated item/spell. This tags when Daeris' Hunter's Mark rider is live without a second, acting-client-only source that would risk double-capture.
- **Gotcha:** on *unlinked* tokens, the `create/update/deleteActiveEffect` hooks pass the synthetic Actor as the first arg, not the ActiveEffect (Foundry issue #5021). The handler must detect the arg type.

---

## New endpoint: `POST /rest`

From `dnd5e.restCompleted(actor, result, config)`.

```json
{
  "actor_uuid": "Actor.daeris",
  "actor_name": "Daeris",
  "type":       "long",              // "short" | "long"
  "hp_recovered":        24,
  "hit_dice_recovered":  3,
  "spell_slots_recovered": true,
  "occurred_at": 1735776000000
}
```

---

## Robustness fixes (no new data — correctness)

1. **Heuristic attacker = matched attack's actor.** `recentAttacks` already stores `actor_uuid` ([main.js:549](scripts/main.js)). When `heuristicMatch` returns, set `attacker_uuid` from *it*, not from `activeCombatantActor()`. This alone would have prevented the Chomper cross even with the raw-HP quick macro. (The Laravel side already corrects this server-side via the linked-attack guard; this makes the payload itself honest and reduces reliance on the correction.)
2. **Flag the loose fallback.** `heuristicMatch`'s "any recent attack regardless of target" branch ([main.js:567-569](scripts/main.js)) is low-confidence. Emit it as `attributed_by: "heuristic_loose"` (or add a `confidence` field) so the Laravel side can treat it more skeptically than a target-matched heuristic.
3. **(Optional) Multi-type injected Apply.** The injected macro Apply buttons apply the whole amount as the first component's type ([main.js:738,745](scripts/main.js)). Improve to apply one `applyDamage` entry per typed component so multi-type macros (Daeris piercing+psychic) respect per-type resistance — closing the gap called out in MACROS.md. Native cards already do this; this is only for the macro fallback.

---

## Backwards compatibility & the Laravel work this implies

- **Module side:** all additive. v0.4 against a v0.3.1 Laravel backend just means the new endpoints 404 (harmless, fire-and-forget) and the new fields are ignored. Safe to ship the module first.
- **Laravel side (companion spec, separate pass):** new migrations/handlers for `/activity`, `/effect`, `/rest`, and the new `/combat` event types (`turn`, `round`, `combatant`); store the `context` block on damage/attack events; consume `damage_type_breakdown` on native damage; treat `heuristic_loose` as low-confidence. The `turn` stream unlocks the round-by-round timeline asked about earlier and a retroactive attribution audit.

---

## Decisions (resolved)

1. **`/effect` volume — capture everything.** No module-side whitelist; the Laravel side filters. (Confirmed no Foundry-side performance concern.)
2. **`/activity` — log every activity used**, damaging or not. Full action-economy record.
3. **Death saves — enrich `/roll`** with success/fail + running 0–3 count, read from the chat message's dnd5e flags (no extra hook, no new event type). Same posture for other rolls: enrich, don't add parallel streams.
4. **Multi-client emission — resolved (see [§Emission model](#emission-model-multi-client)).** All players remote with clients open; real data shows no doubles. Structural / combat / effect state → active-GM emitter; player workflow events (`useActivity`, `restCompleted`) → acting-client, ungated; damage path unchanged (originator via `hpCache`).
5. **Scope — ship everything in one `0.4.0`.** Single bump, verified all at once at the table.

---

## Version

Target `module.json` → `0.4.0`. On implementation, merge the relevant sections into `EVENTS.md`, add a `0.4.0` row to its version history, and cut a release per `RELEASING.md`.
