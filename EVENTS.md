# dm-sync — events & payload reference

What the `dm-sync` FoundryVTT module captures from a live world and how it ships to the Laravel side. This file is the source of truth when planning new features — read it before deciding what extra signals to add.

Last updated for module **v0.3.1**.

## Module settings

Registered at `init` (`scripts/main.js`). World-scoped, GM-edits via Foundry's Module Management.

| Key | Type | Default | Purpose |
|---|---|---|---|
| `endpoint` | string | `""` | Base URL of the Laravel API (e.g. `https://dm.example.com/api/foundry`). Module appends `/<event>` to each POST. |
| `campaign_id` | number | `0` | The DM-side Campaign primary key. Sent as the `X-DM-Campaign` header. |
| `shared_secret` | string | `""` | HMAC signing secret. Must match `campaigns.foundry_shared_secret` in the Laravel DB. |
| `enabled` | boolean | `true` | Master kill-switch. When false, no events are sent (settings can still be edited). |
| `sync_npcs` | boolean | `true` | When false, NPCs (`actor.type === "npc"`) are skipped on actor sync. PCs (`actor.type === "character"`) are always synced; monsters never. |

## Transport

Every event is a JSON POST to `<endpoint>/<event-name>` with these headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-DM-Signature` | `t=<unix-seconds>,v1=<hex>` where `<hex>` is `HMAC-SHA256(secret, "<t>.<json-body>")` |
| `X-DM-Campaign` | the campaign id |

Network calls are **fire-and-forget** from the Foundry hook (`post()` is async but no caller awaits it). See [CLAUDE.md §0](https://github.com/jmancusi/dm-foundry/blob/main/CLAUDE.md) — the UI thread is sacred at the table.

Idempotency keys are documented per event below; resending the same payload is always safe.

## Endpoints

| Path | Module trigger | Idempotency key |
|---|---|---|
| `POST /actor` | actor created / updated / deleted | `(campaign_id, uuid)` — upsert |
| `POST /journal` | journal created / updated | `(campaign_id, uuid)` — upsert |
| `POST /combat` | combat start, combat end, HP delta during combat, narrative kill | `start`/`end`: by combat uuid; damage/healing: append-only |
| `POST /roll` | any chat message containing rolls | `(campaign_id, uuid, roll_index)` |
| `POST /attack` | helper call (`dmSync.attackMessage()` / `dmSync.attack()`) OR auto-synthesized once per native dnd5e damage/healing roll with `flags.dnd5e.activity` | `(campaign_id, attack_id)` — upsert |
| `POST /full-sync` | manual macro (`dmSync.fullSync()`) | upserts all actors + journals |

## Hooks listened to

In source order (`scripts/main.js`). The `Posts?` column flags which hooks actually emit network traffic.

| Hook | Posts? | What we send |
|---|---|---|
| `init` | No | Registers settings. |
| `ready` | No | Logs version, exposes `globalThis.dmSync.fullSync()`. |
| `preUpdateActor` | No | Stashes old HP into a module-local `Map` so `updateActor` can compute a delta. |
| `createActor` | Yes | `POST /actor` with full actor payload (subject to filter). |
| `updateActor` | Yes | `POST /actor` with full actor payload (subject to filter). On HP delta during active combat, also `POST /combat` with `event=damage` or `event=healing`. |
| `deleteActor` | Yes | `POST /actor` with `{ uuid, type, deleted: true }` (subject to filter). |
| `createJournalEntry` | Yes | `POST /journal` with full journal + pages. |
| `updateJournalEntry` | Yes | `POST /journal` with full journal + pages. |
| `combatStart` | Yes | `POST /combat` with `event=start`, scene name, participants snapshot. |
| `deleteCombat` | Yes | `POST /combat` with `event=end`. |
| `updateCombatant` (defeated=true) | Yes | `POST /combat` with `event=damage`, `synthetic=true`, `killed=true`, amount = current HP. Skipped if current HP ≤ 0 (normal HP path already covered it). |
| `createChatMessage` | Yes | One `POST /roll` per Roll in the chat message (enriched with `item_uuid`, `activity_uuid`, `originating_message_id`, `attack_id`, `dice_results`). For messages containing DamageRoll instance(s) on an activity, also auto-synthesizes one `POST /attack` per `(msg.id, activity)` pair. Skipped if `msg.flags.dm_sync_ignore === true`. |
| `updateChatMessage` | Yes | Same handler as `createChatMessage`. Required because dnd5e v5.3.1+ mutates the activity USAGE card to add attack/damage rolls *after* it's created — those rolls would otherwise be missed. Per-message dedup via an in-memory Set<roll_index> prevents double-POST of rolls we've already sent. |
| `renderChatMessage` | No | GM-only: injects Apply Full/Half/None (or Apply Healing) buttons onto chat cards stamped with `flags["dm-sync"].attack` (the macro path). Native cards already get dnd5e's built-in `<damage-application>` tray. |
| `dnd5e.applyDamage` | Yes (indirectly) | Captures `(target_actor_uuid → attack_id)` into a 2s pendingApply map when the GM clicks Apply on a native or macro card. The subsequent `updateActor` event reads this and stamps `attack_id` + `attributed_by="click"` on its `POST /combat` damage event. |

## Actor filter rules

Lives in `shouldSyncActor()`:

| Actor type | Synced? |
|---|---|
| `character` (PC) | Always |
| `npc` | Only if the `sync_npcs` setting is true |
| anything else (monster, vehicle, group, etc.) | Never via actor sync |

> Note: monsters are *captured implicitly* via combat events — their UUIDs flow through `target_uuid` on damage payloads and the Laravel side maintains a separate `monsters` bestiary table from those signals. They just don't get a full actor sync of stat blocks.

## Payload reference

### Actor payload (`POST /actor`)

Built by `actorPayload()`. Sent on create/update.

```json
{
  "uuid":   "Actor.abc123",
  "type":   "character",
  "name":   "Bob the Bard",
  "img":    "icons/portraits/bob.webp",
  "system": {
    "abilities":  { "str": {...}, "dex": {...}, "...": "..." },
    "attributes": { "hp": { "value": 24, "max": 32, "temp": 0 }, "ac": {...}, "...": "..." },
    "skills":     { "acr": {...}, "...": "..." },
    "details":    { "biography": {...}, "race": "Half-elf", "...": "..." },
    "traits":     { "size": "med", "languages": {...}, "...": "..." },
    "spells":     { "spell1": { "value": 3, "max": 4 }, "...": "..." },
    "currency":   { "gp": 45, "sp": 12, "...": "..." }
  },
  "items": [
    {
      "uuid":   "Item.xyz",
      "name":   "Longsword",
      "type":   "weapon",
      "img":    "icons/weapons/longsword.webp",
      "system": { /* full item.system */ }
    }
  ]
}
```

The `system.*` keys passed through are the full dnd5e schema unchanged — useful for any future feature that wants more detail without a module bump.

On **delete**, the payload is the minimal stub:
```json
{ "uuid": "Actor.abc123", "type": "character", "deleted": true }
```

### Journal payload (`POST /journal`)

```json
{
  "uuid": "JournalEntry.abc",
  "name": "Session 3 — Goblin Cave",
  "pages": [
    {
      "uuid":  "JournalEntryPage.xyz",
      "title": "Encounter A",
      "text":  { "content": "<p>Three goblins ambush…</p>" },
      "type":  "text"
    }
  ]
}
```

### Combat payload (`POST /combat`)

A discriminated union on `event`. The five possible shapes:

#### `event: "start"`
```json
{
  "uuid":  "Combat.abc",
  "event": "start",
  "scene": "Goblin Cave",
  "participants": [
    {
      "foundry_actor_uuid": "Actor.bob",
      "display_name":       "Bob the Bard",
      "role":               "pc",
      "initiative":         18,
      "max_hp":             32,
      "source_uuid":        null,
      "img":                "icons/portraits/bob.webp"
    },
    {
      "foundry_actor_uuid": "Actor.goblin1",
      "display_name":       "Goblin",
      "role":               "monster",
      "initiative":         12,
      "max_hp":             7,
      "source_uuid":        "Compendium.dnd5e.monsters.GoblinABC",
      "img":                "icons/monsters/goblin.webp"
    }
  ]
}
```

`role` is derived by `roleOf(actor)`:
- `"pc"` — `actor.type === "character"`
- `"npc"` — `actor.type === "npc"`
- `"monster"` — anything else (heuristic; DM can correct in the UI)

`source_uuid` comes from `actor.flags.core.sourceId` or `actor._stats.compendiumSource`. Used by the Laravel side to dedupe bestiary entries across encounters.

#### `event: "end"`
```json
{ "uuid": "Combat.abc", "event": "end" }
```

#### `event: "damage"` — HP delta path
Fires on any `updateActor` where HP decreased while a combat is active.

```json
{
  "uuid":               "Combat.abc",
  "event":              "damage",
  "attacker_uuid":      "Actor.bob",
  "attacker_name":      "Bob the Bard",
  "target_uuid":        "Actor.goblin1",
  "target_name":        "Goblin",
  "target_source_uuid": "Compendium.dnd5e.monsters.GoblinABC",
  "target_img":         "icons/monsters/goblin.webp",
  "amount":             8,
  "hp_before":          7,
  "hp_after":           -1,
  "killed":             true,
  "round":              2,
  "turn":               0,
  "occurred_at":        1735776000000
}
```

- `attacker_*` reads from `game.combats.active.combatant.actor` — the active combatant at the moment HP changed. Best-effort attribution; ongoing-effect damage during the target's own turn will mis-attribute. DM can edit in Filament.
- `killed` is true iff `hp_before > 0` and `hp_after <= 0`.
- `target_source_uuid` and `target_img` are sent so the Laravel side can build a persistent bestiary entry without an extra lookup.

#### `event: "damage"` with `synthetic: true` — narrative kill
Fires when the DM marks a combatant defeated via the combat tracker (skull icon / right-click → Mark Defeated) **without** dropping HP to 0. Same shape as a normal damage event, plus:

```json
{
  "amount":     "<current HP>",
  "hp_before":  "<current HP>",
  "hp_after":   0,
  "killed":     true,
  "synthetic":  true
}
```

Skipped when current HP is already ≤ 0 (the normal HP-delta path already handled the kill).

#### `event: "healing"`
Same shape as `damage` but with `event: "healing"` and `amount` representing HP regained (always positive). `killed` is always false.

### Roll payload (`POST /roll`)

Fires on any `createChatMessage` whose `msg.rolls` array is non-empty. One POST per Roll instance — multi-roll messages (e.g. dnd5e cards that combine attack + damage) emit multiple events sharing `uuid` but with incrementing `roll_index`.

```json
{
  "uuid":           "ChatMessage.def456",
  "roll_index":     0,
  "actor_uuid":     "Actor.bob",
  "actor_name":     "Bob the Bard",
  "type":           "attack",
  "subtype":        "dex",
  "formula":        "2d20kh + 5",
  "total":          18,
  "d20":            13,
  "d20_other":      4,
  "advantage_mode": "advantage",
  "is_nat_20":      false,
  "is_nat_1":       false,
  "target_uuids":   ["Actor.goblin1"],
  "round":          3,
  "turn":           1,
  "occurred_at":    1735776000000
}
```

- `type` values from dnd5e: `attack`, `damage`, `save`, `ability`, `skill`, `death`, `initiative`, `tool`. When `flags.dnd5e.roll.type` is absent (e.g. on usage cards in v5.3.1+ that embed rolls), the module falls back to the Roll instance's class name: `D20Roll` → `"attack"`, `DamageRoll` → `"damage"`, else `"other"`.
- `dice_results` — array of every individual die rolled, e.g. `[{faces:20,result:14,kept:true}, {faces:6,result:4,kept:true}, {faces:6,result:2,kept:true}]`. Enables per-die-type averages on the Laravel side ("avg d6 for Bren"). Discarded dice (advantage drops, exploding dice cancellations) have `kept:false`.
- `subtype` — for ability/save rolls, the ability id (`str`/`dex`/…). For skills, the skill id (`athletics`/…). For tools, the tool id. Free-form pass-through from the dnd5e flag.
- `d20` — the chosen face when the Roll has a d20 term. `null` for pure damage rolls. Detected via `roll.dice.find(d => d.faces === 20)`.
- `d20_other` — the discarded face under advantage (`kh` modifier) or disadvantage (`kl` modifier). `null` for normal rolls.
- `advantage_mode` — `"advantage"`, `"disadvantage"`, or `"normal"`.
- `round` / `turn` — populated only when a combat is active at the moment of the roll. Used by the Laravel side to link the roll to its Encounter.
- `target_uuids` — actor UUIDs targeted at roll time (from `msg.flags.dnd5e.targets`). Empty for untargeted rolls.

**Escape hatch:** any chat message with `msg.flags.dm_sync_ignore === true` is skipped. Useful for DM-side admin macros that shouldn't pollute stats.

### Attack payload (`POST /attack`)

Introduced in v0.3.0. One event per discrete "attack" — captures the source item/skill/spell and a component-level breakdown of damage so the Laravel side can attribute HP changes to a specific cause. Idempotent on `(campaign_id, attack_id)`.

Two paths produce this event:

1. **Helper (macro)** — `dmSync.attackMessage({...})` or `dmSync.attack({...})`. Players add one call to their existing macros.
2. **Auto-synthesized (native)** — when a dnd5e damage or healing chat message lands with `flags.dnd5e.activity` populated, the module synthesizes one attack event per `(originatingMessage, activity)` pair. No player change required for native sheet attacks.

```json
{
  "attack_id":              "atk_abc123",
  "foundry_combat_uuid":    "Combat.xyz",
  "actor_uuid":             "Actor.bren",
  "actor_name":             "Bren",
  "source_label":           "Longbow + Hunter's Mark + Dreadful Strike",
  "source_kind":            "macro",
  "item_uuid":              null,
  "item_name":              null,
  "activity_uuid":          null,
  "originating_message_id": "msg_def456",
  "components": [
    { "label": "Longbow",          "type": "piercing", "amount": 12 },
    { "label": "Hunter's Mark",    "type": "piercing", "amount": 5  },
    { "label": "Dreadful Strike",  "type": "psychic",  "amount": 9  }
  ],
  "total":        26,
  "kind":         "damage",
  "target_uuids": ["Actor.gob1"],
  "crit":         false,
  "round":        2,
  "turn":         1,
  "occurred_at":  1735776000000
}
```

For native dnd5e attacks the same shape comes from the auto-synthesizer:
- `source_kind: "native"`
- `item_uuid` and `activity_uuid` populated from `flags.dnd5e.{item,activity}.uuid`
- `attack_id` deterministically derived: `"native:<originatingMessageId>"`
- `components` collapsed to a single entry (the chat message doesn't expose per-type breakdowns of the bundled roll; Laravel can split later if needed)

### `damage_type_breakdown` on combat damage events (v0.3.0+)

`POST /combat` with `event="damage"` may now carry an optional `damage_type_breakdown` array:

```json
"damage_type_breakdown": [
  { "type": "piercing", "amount": 17 },
  { "type": "psychic",  "amount": 9  }
]
```

Populated when the attribution came from a macro `dmSync.attackMessage` call with typed components. Amounts are proportionally scaled to the actual amount applied (handles Apply Half / resistances). Null for native attacks (we don't have per-type info from the chat message) and for un-attributed damage.

### `attack_id` and `attributed_by` on combat damage events (v0.3.0+)

When the GM clicks an Apply button (native tray OR our injected macro button), the `dnd5e.applyDamage` hook fires; the module captures the originating chat message and stamps the resulting `POST /combat` damage event with:

```json
"attack_id":     "atk_abc123",
"attributed_by": "click"
```

If no Apply was clicked (DM edited HP directly on the sheet), the module attempts a heuristic match against recent attacks:

- `attributed_by: "heuristic"` — matched by target_uuid in `target_uuids` of a recent attack (within 120s)
- `attributed_by: "none"` — no plausible source found; damage event records without attribution (legacy behavior)

### Full-sync payload (`POST /full-sync`)

Manual macro:
```js
globalThis.dmSync.fullSync()  // shows a confirm dialog
```

```json
{
  "actors":   [ /* one full actor payload per synced actor */ ],
  "journals": [ /* one full journal payload per entry */ ]
}
```

Only sends actors that pass `shouldSyncActor()` (PCs always, NPCs gated by setting). Does **not** include combat events or rolls — those are append-only and can't be reconciled retroactively from world state.

## What's NOT captured

Conscious omissions, useful when planning the next bundle:

| Category | Examples |
|---|---|
| Monster stat blocks | Only their UUIDs appear in combat events; full `actorPayload` is never sent for `monster` actors |
| Foundry doc types | Scenes (only the active scene name on combatStart), Tokens, Folders, Tables, Playlists, Macros, Cards, Drawings, Walls, Lights |
| Combat granularity | Round/turn advance events (we hear about kills/damage, not "next turn"); active effects / conditions (prone, poisoned, blessed); death saves; damage types |
| Player activity | Chat messages with no rolls; private whispers (we do log GM-whispered rolls — opt out via `dm_sync_ignore`) |
| World metadata | World/system version, module list, settings changes, who-clicked-what (user attribution) |
| Rest mechanics | Long/short rests, spell-slot resets, hit-dice spend |

## Version history

| Version | Highlights |
|---|---|
| 0.1.0 | Initial sync — actors + journals + basic combat start/end. |
| 0.1.2 | Journal page UUIDs included; promoted journals to first-class entity. |
| 0.2.0 | Damage / healing / kill detection on HP delta. Narrative-kill ("Mark Defeated") via `updateCombatant`. Combat participants snapshot. **Dice roll logging** via `createChatMessage`. **Monster bestiary fields** (`target_source_uuid`, `target_img`) on damage payloads + participants. |
| 0.3.0 | **Attack source attribution** (see `combat-tracking.md` in the Laravel repo). New `POST /attack` endpoint with components + total + targets. Auto-synthesizes attacks from native dnd5e damage/healing rolls via `flags.dnd5e.activity`. Adds `dmSync.attackMessage()` and `dmSync.attack()` helpers for player macros (one-line migration). Injects Apply Full/Half/None/Healing buttons onto macro chat cards. Subscribes to `dnd5e.applyDamage` hook to stamp `attack_id` + `attributed_by="click"` on damage events. Heuristic fallback for direct HP edits. Roll events enriched with `item_uuid`, `activity_uuid`, `originating_message_id`, `attack_id`. |
| 0.4.0 | **Telemetry expansion** (see `EVENTS-v0.4.md` for full payloads — fold into this doc on release). New `context` envelope (active combatant / acting user / targets / selected) on damage + attack events, logged separately from the attacker. New `/combat` events `turn` / `round` / `combatant` (structural stream, active-GM-emitter). New endpoints `/activity`, `/effect`, `/rest`. Native per-type `damage_type_breakdown` via `dnd5e.calculateDamage`. **Attribution fix:** heuristic now credits the matched attack's actor (not the active combatant), with a low-confidence `heuristic_loose` for the any-recent-attack fallback. Death-save rolls enriched with outcome + running 0–3 count. |
| 0.3.1 | **Fix: every attack and damage roll is now tracked.** v0.3.0 missed all activity-driven attacks and damage rolls because dnd5e v5.3.1+ MUTATES the existing usage-card message (via `updateChatMessage`) instead of posting a separate roll message — v0.3.0 only listened to `createChatMessage`. Now hooks both, with per-message dedup so re-fires don't double-POST. Roll classification falls back on the Roll class name (`D20Roll` / `DamageRoll`) when `flags.dnd5e.roll.type` is absent. **Per-die capture:** new `dice_results` array on every `/roll` payload — `[{faces, result, kept}, ...]` — captures every individual die face for per-die-type averages (avg d6 / d8 / d20 per player). Native attack synthesis now sums only the DamageRoll instances (was summing attack d20 + damage, double-counting). Damage type now read from each `DamageRoll.options.type` per component. |
