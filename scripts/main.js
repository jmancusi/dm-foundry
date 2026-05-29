const MODULE_ID = "dm-sync";

const S = {
  endpoint:     "endpoint",
  campaignId:   "campaign_id",
  secret:       "shared_secret",
  enabled:      "enabled",
  syncNpcs:     "sync_npcs",
};

function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

function log(...args) {
  console.log(`[${MODULE_ID}]`, ...args);
}

function warn(msg) {
  ui.notifications?.warn(`[${MODULE_ID}] ${msg}`);
  console.warn(`[${MODULE_ID}]`, msg);
}

// ---------------------------------------------------------------------------
// HMAC + POST
// ---------------------------------------------------------------------------

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// IMPORTANT: callers MUST NOT await this. It's fire-and-forget. See CLAUDE.md §0.
async function post(event, body) {
  if (!setting(S.enabled)) return;

  const endpoint   = (setting(S.endpoint) || "").trim().replace(/\/+$/, "");
  const campaignId = setting(S.campaignId);
  const secret     = (setting(S.secret) || "").trim();

  if (!endpoint || !campaignId || !secret) {
    warn(game.i18n.localize("DM_SYNC.Errors.NotConfigured"));
    return;
  }

  const ts   = Math.floor(Date.now() / 1000);
  const json = JSON.stringify(body);
  const hmac = await hmacSha256Hex(secret, `${ts}.${json}`);

  try {
    const res = await fetch(`${endpoint}/${event}`, {
      method: "POST",
      headers: {
        "Content-Type":   "application/json",
        "X-DM-Signature": `t=${ts},v1=${hmac}`,
        "X-DM-Campaign":  String(campaignId),
      },
      body: json,
    });
    if (!res.ok) {
      warn(game.i18n.format("DM_SYNC.Errors.PostFailed", { status: res.status }));
    } else {
      log(`POST ${event} ok`);
    }
  } catch (err) {
    warn(`fetch failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function actorPayload(a) {
  return {
    uuid: a.uuid,
    type: a.type,
    name: a.name,
    img:  a.img,
    system: {
      abilities:  a.system?.abilities,
      attributes: a.system?.attributes,
      skills:     a.system?.skills,
      details:    a.system?.details,
      traits:     a.system?.traits,
      spells:     a.system?.spells,
      currency:   a.system?.currency,
    },
    items: (a.items?.contents ?? []).map(i => ({
      uuid:   i.uuid,
      name:   i.name,
      type:   i.type,
      img:    i.img,
      system: i.system,
    })),
  };
}

function journalPayload(j) {
  return {
    uuid:  j.uuid,
    name:  j.name,
    pages: (j.pages?.contents ?? []).map(p => ({
      uuid:  p.uuid,
      title: p.name,
      text:  { content: p.text?.content ?? "" },
      type:  p.type,
    })),
  };
}

function shouldSyncActor(a) {
  if (a.type === "character") return true;
  if (a.type === "npc")       return !!setting(S.syncNpcs);
  return false;
}

function roleOf(actor) {
  if (!actor) return "other";
  if (actor.type === "character") return "pc";
  if (actor.type === "npc")       return "npc";
  return "monster";
}

// ---------------------------------------------------------------------------
// Combat state helpers
// ---------------------------------------------------------------------------

// Per-actor cache of HP before the most recent update. Populated by preUpdateActor
// and read by updateActor. Best-effort: a miss just suppresses a damage event.
const hpCache = new Map();

// Per-actor pending attribution from a recent dnd5e.applyDamage hook fire.
// Keyed by actor.uuid → {attack_id, originatingMessage, fired_at}. updateActor
// reads this to attach attack_id + attributed_by="click" to the damage event.
// Entries older than 2s are stale and ignored (auto-cleaned on next read).
const pendingApply = new Map();

// Set of attack_ids we've already POSTed in this session, to avoid double-posting
// when the same usage card is read multiple times.
const postedAttacks = new Set();

function activeCombat() {
  return game.combats?.active ?? null;
}

function activeCombatantActor() {
  return activeCombat()?.combatant?.actor ?? null;
}

function actorSourceUuid(actor) {
  if (!actor) return null;
  return actor.getFlag?.("core", "sourceId")
      ?? actor._stats?.compendiumSource
      ?? null;
}

function combatParticipantsSnapshot(combat) {
  return (combat.combatants?.contents ?? []).map(c => ({
    foundry_actor_uuid: c.actor?.uuid ?? null,
    display_name:       c.name,
    role:               roleOf(c.actor),
    initiative:         c.initiative,
    max_hp:             c.actor?.system?.attributes?.hp?.max ?? null,
    source_uuid:        actorSourceUuid(c.actor),
    img:                c.actor?.img ?? null,
  })).filter(p => p.foundry_actor_uuid);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, S.endpoint, {
    name: "DM_SYNC.Settings.Endpoint.Name",
    hint: "DM_SYNC.Settings.Endpoint.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, S.campaignId, {
    name: "DM_SYNC.Settings.CampaignId.Name",
    hint: "DM_SYNC.Settings.CampaignId.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 0,
  });
  game.settings.register(MODULE_ID, S.secret, {
    name: "DM_SYNC.Settings.Secret.Name",
    hint: "DM_SYNC.Settings.Secret.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, S.enabled, {
    name: "DM_SYNC.Settings.Enabled.Name",
    hint: "DM_SYNC.Settings.Enabled.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.register(MODULE_ID, S.syncNpcs, {
    name: "DM_SYNC.Settings.SyncNpcs.Name",
    hint: "DM_SYNC.Settings.SyncNpcs.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
});

// ---------------------------------------------------------------------------
// Actor hooks
// ---------------------------------------------------------------------------

// preUpdateActor: stash old HP. Zero network, just a Map write. Synchronous.
Hooks.on("preUpdateActor", (actor) => {
  const hp = actor.system?.attributes?.hp?.value;
  if (typeof hp === "number") {
    hpCache.set(actor.uuid, hp);
  }
});

Hooks.on("createActor", (a) => {
  if (!shouldSyncActor(a)) return;
  post("actor", actorPayload(a));
});

Hooks.on("updateActor", (a, change) => {
  if (shouldSyncActor(a)) {
    post("actor", actorPayload(a));
  }

  // HP delta → combat damage / healing event when a combat is active.
  const newHp = change?.system?.attributes?.hp?.value;
  if (typeof newHp !== "number") return;
  const oldHp = hpCache.get(a.uuid);
  hpCache.delete(a.uuid); // consume the cached value either way
  if (typeof oldHp !== "number") return; // miss = suppress (best-effort rule)

  const delta = oldHp - newHp;
  if (delta === 0) return;

  const combat = activeCombat();
  if (!combat) return;

  // Check for a recent applyDamage hook fire that we should attribute to.
  const attribution = consumePendingApply(a.uuid);
  const isDamage = delta > 0;

  const payload = {
    uuid:               combat.uuid,
    event:              isDamage ? "damage" : "healing",
    attacker_uuid:      attribution?.actor_uuid ?? activeCombatantActor()?.uuid ?? null,
    target_uuid:        a.uuid,
    target_name:        a.name,
    target_source_uuid: actorSourceUuid(a),
    target_img:         a.img ?? null,
    attacker_name:      attribution?.actor_name ?? activeCombatantActor()?.name ?? null,
    amount:             Math.abs(delta),
    hp_before:          oldHp,
    hp_after:           newHp,
    killed:             isDamage && oldHp > 0 && newHp <= 0,
    round:              combat.round,
    turn:               combat.turn,
    occurred_at:        Date.now(),
  };

  if (attribution) {
    payload.attack_id     = attribution.attack_id;
    payload.attributed_by = "click";
    if (attribution.damage_type_breakdown) {
      payload.damage_type_breakdown = attribution.damage_type_breakdown;
    }
  } else {
    // No applyDamage hook fired — try heuristic match for direct HP edits.
    const heuristic = heuristicMatch(a.uuid);
    if (heuristic) {
      payload.attack_id     = heuristic.attack_id;
      payload.attributed_by = "heuristic";
    } else {
      payload.attributed_by = "none";
    }
  }

  post("combat", payload);
});

Hooks.on("deleteActor", (a) => {
  if (!shouldSyncActor(a)) return;
  post("actor", { uuid: a.uuid, type: a.type, deleted: true });
});

// ---------------------------------------------------------------------------
// Journal hooks
// ---------------------------------------------------------------------------

Hooks.on("createJournalEntry", (j) => post("journal", journalPayload(j)));
Hooks.on("updateJournalEntry", (j) => post("journal", journalPayload(j)));

// ---------------------------------------------------------------------------
// Combat hooks
// ---------------------------------------------------------------------------

Hooks.on("combatStart", (c) => {
  post("combat", {
    uuid:         c.uuid,
    event:        "start",
    scene:        c.scene?.name,
    participants: combatParticipantsSnapshot(c),
  });
});

Hooks.on("deleteCombat", (c) => {
  post("combat", { uuid: c.uuid, event: "end" });
});

// Narrative kill: DM marks combatant defeated without HP hitting 0.
// Synthesize a damage event for the remaining HP, credit the active combatant.
Hooks.on("updateCombatant", (combatant, change) => {
  if (change?.defeated !== true) return;
  const combat = combatant.parent;
  if (!combat?.started) return;

  const target = combatant.actor;
  const currentHp = target?.system?.attributes?.hp?.value ?? null;
  if (typeof currentHp !== "number" || currentHp <= 0) {
    return; // already 0 or unknown — normal flow handled it
  }

  const attacker = activeCombatantActor();
  post("combat", {
    uuid:               combat.uuid,
    event:              "damage",
    attacker_uuid:      attacker?.uuid ?? null,
    target_uuid:        target?.uuid ?? null,
    target_name:        combatant.name,
    target_source_uuid: actorSourceUuid(target),
    target_img:         target?.img ?? null,
    attacker_name:      attacker?.name ?? null,
    amount:             currentHp,
    hp_before:          currentHp,
    hp_after:           0,
    killed:             true,
    synthetic:          true,
    round:              combat.round,
    turn:               combat.turn,
    occurred_at:        Date.now(),
  });
});

// ---------------------------------------------------------------------------
// Dice roll hooks
// ---------------------------------------------------------------------------
//
// dnd5e v5.3.1+ uses ChatMessage5e with `type: "usage"` for activity cards.
// When a player rolls an attack or damage from a usage card, dnd5e MUTATES
// the existing message to add rolls (via msg.update) instead of posting a
// new chat message. So we MUST listen to both createChatMessage AND
// updateChatMessage to capture every roll.
//
// Per-message dedup: postedRollIndexes maps msg.id → Set<roll_index> so we
// don't re-POST a roll that's already been sent (e.g. when dnd5e mutates the
// usage card a second time to add damage after attack).

// Per-message ring of roll_indexes we've already POSTed. Bounded by chat
// message TTL; old entries don't get cleaned but Map size grows slowly.
const postedRollIndexes = new Map(); // msg.id → Set<roll_index>

function classifyRoll(msg, roll) {
  const dnd5e = msg.flags?.dnd5e ?? {};
  const dmSync = msg.flags?.[MODULE_ID]?.attack ?? null;

  // Prefer dnd5e's explicit roll type tag. Fall back to roll class name —
  // critical for usage-card messages where flags.dnd5e.roll is absent but
  // msg.rolls[i] is a typed D20Roll / DamageRoll instance.
  let type = dnd5e.roll?.type;
  if (!type && roll) {
    const cls = roll?.constructor?.name ?? "";
    if (cls === "D20Roll")        type = "attack";
    else if (cls === "DamageRoll") type = "damage";
  }
  if (!type) type = dmSync ? "damage" : "other";

  // For usage cards with embedded rolls, the message id IS the "originating"
  // identifier for the activity — no separate originatingMessage flag exists.
  const originating = dnd5e.originatingMessage ?? msg.id ?? null;
  const hasActivity = !!dnd5e.activity?.uuid;

  return {
    type,
    subtype: dnd5e.roll?.ability ?? dnd5e.roll?.skillId ?? dnd5e.roll?.tool ?? null,

    item_uuid:              dnd5e.item?.uuid ?? null,
    item_name:              dnd5e.item?.uuid ? (fromUuidSync?.(dnd5e.item.uuid)?.name ?? null) : null,
    activity_uuid:          dnd5e.activity?.uuid ?? null,
    originating_message_id: originating,
    attack_id:              dmSync?.attack_id
                          ?? (hasActivity ? `native:${originating}` : null),
  };
}

// Extract the chosen d20 face from a Roll, including advantage/disadvantage mode
// and the discarded face when present. Returns null when the roll has no d20 term.
function extractD20(roll) {
  const d20Term = (roll?.dice ?? []).find(d => d.faces === 20);
  if (!d20Term) return null;

  const results = d20Term.results ?? [];
  const active  = results.find(r => r.active) ?? results[0];

  const mods = d20Term.modifiers ?? [];
  const hasKh = mods.some(m => typeof m === "string" && m.includes("kh"));
  const hasKl = mods.some(m => typeof m === "string" && m.includes("kl"));
  const advantage_mode = hasKh ? "advantage" : hasKl ? "disadvantage" : "normal";

  let d20_other = null;
  if (results.length > 1) {
    const other = results.find(r => !r.active);
    d20_other = other?.result ?? null;
  }

  return {
    d20:    active?.result ?? null,
    d20_other,
    advantage_mode,
  };
}

// Walk every individual die in a Roll, capturing face count + result + kept
// flag. Enables per-die-type averages on the Laravel side ("Bren's avg d6").
function extractDiceResults(roll) {
  const out = [];
  for (const die of (roll?.dice ?? [])) {
    const faces = die.faces;
    for (const r of (die.results ?? [])) {
      out.push({
        faces,
        result: r.result,
        kept:   r.active !== false, // active=true is the default
      });
    }
  }
  return out;
}

// Shared processor invoked by both createChatMessage and updateChatMessage.
// Handles: native-attack synthesis (once per activity), per-roll POSTs with
// dedup so re-fires for the same message don't double-post.
function processRollMessage(msg) {
  if (msg.flags?.dm_sync_ignore === true) return;
  if (!msg.rolls?.length) return;

  // Synthesize a native attack event when we see damage roll(s) from an
  // activity. Use the first damage roll's classification (carries activity).
  const damageRolls = msg.rolls.filter(r => r?.constructor?.name === "DamageRoll");
  if (damageRolls.length) {
    const synthMeta = classifyRoll(msg, damageRolls[0]);
    if (synthMeta.activity_uuid
        && synthMeta.attack_id
        && !msg.flags?.[MODULE_ID]?.attack
        && !postedAttacks.has(synthMeta.attack_id)) {
      postedAttacks.add(synthMeta.attack_id);
      postNativeAttack(msg, synthMeta, damageRolls);
    }
  }

  const seen = postedRollIndexes.get(msg.id) ?? new Set();
  postedRollIndexes.set(msg.id, seen);

  const actor   = ChatMessage.getSpeakerActor?.(msg.speaker) ?? null;
  const combat  = activeCombat();
  const round   = combat?.round ?? null;
  const turn    = combat?.turn  ?? null;
  const targetUuids = Array.from(msg.flags?.dnd5e?.targets ?? [])
    .map(t => t?.uuid)
    .filter(Boolean);

  msg.rolls.forEach((roll, idx) => {
    if (seen.has(idx)) return;
    seen.add(idx);
    try {
      const d20  = extractD20(roll);
      const meta = classifyRoll(msg, roll);
      post("roll", {
        uuid:                   msg.uuid ?? msg.id,
        roll_index:             idx,
        actor_uuid:             actor?.uuid ?? null,
        actor_name:             msg.speaker?.alias ?? actor?.name ?? "Unknown",
        type:                   meta.type,
        subtype:                meta.subtype,
        item_uuid:              meta.item_uuid,
        item_name:              meta.item_name,
        activity_uuid:          meta.activity_uuid,
        originating_message_id: meta.originating_message_id,
        attack_id:              meta.attack_id,
        formula:                roll.formula ?? "",
        total:                  Number(roll.total ?? 0),
        dice_results:           extractDiceResults(roll),
        d20:                    d20?.d20 ?? null,
        d20_other:              d20?.d20_other ?? null,
        advantage_mode:         d20?.advantage_mode ?? null,
        is_nat_20:              d20?.d20 === 20,
        is_nat_1:               d20?.d20 === 1,
        target_uuids:           targetUuids.length ? targetUuids : null,
        round,
        turn,
        occurred_at:            Date.now(),
      });
    } catch (err) {
      warn(`roll extract failed: ${err.message}`);
    }
  });
}

Hooks.on("createChatMessage", processRollMessage);
Hooks.on("updateChatMessage", processRollMessage);

// ---------------------------------------------------------------------------
// Attack tracking: native + helper
// ---------------------------------------------------------------------------

// Recent attacks for heuristic fallback when DM edits HP directly without
// going through any Apply button. Per-actor ring of {attack_id, target_uuids,
// posted_at, speaker_user_id}. Entries older than 120s are dropped.
const recentAttacks = [];
const HEURISTIC_WINDOW_MS = 120_000;

function rememberAttack(attack) {
  recentAttacks.push({
    attack_id:     attack.attack_id,
    target_uuids:  attack.target_uuids ?? [],
    posted_at:     Date.now(),
    actor_uuid:    attack.actor_uuid,
  });
  // Trim oldest entries
  const cutoff = Date.now() - HEURISTIC_WINDOW_MS;
  while (recentAttacks.length && recentAttacks[0].posted_at < cutoff) {
    recentAttacks.shift();
  }
}

function heuristicMatch(targetActorUuid) {
  const cutoff = Date.now() - HEURISTIC_WINDOW_MS;
  // Most recent attack whose targets include this actor.
  for (let i = recentAttacks.length - 1; i >= 0; i--) {
    const a = recentAttacks[i];
    if (a.posted_at < cutoff) continue;
    if (a.target_uuids.includes(targetActorUuid)) return a;
  }
  // Loose fallback: any recent attack regardless of target (DM might've
  // targeted a different token than the player marked).
  const recent = recentAttacks[recentAttacks.length - 1];
  return (recent && recent.posted_at >= cutoff) ? recent : null;
}

function consumePendingApply(actorUuid) {
  const entry = pendingApply.get(actorUuid);
  if (!entry) return null;
  pendingApply.delete(actorUuid);
  // Stale entry — ignore (the hook fired for a different update cycle).
  if (Date.now() - entry.fired_at > 2000) return null;
  return entry;
}

// Build and POST an attack event synthesized from native dnd5e damage rolls
// in a message. Called once per (msg.id, activity.uuid) pair.
// damageRolls is the filtered subset of msg.rolls that are DamageRoll instances.
function postNativeAttack(msg, meta, damageRolls) {
  const actor   = ChatMessage.getSpeakerActor?.(msg.speaker) ?? null;
  const combat  = activeCombat();
  const targets = Array.from(msg.flags?.dnd5e?.targets ?? [])
    .map(t => t?.uuid)
    .filter(Boolean);

  // One component per damage roll. Each DamageRoll's options.type carries the
  // dnd5e damage type (slashing / fire / etc.). Healing rolls show up as
  // type "healing" via flags.dnd5e.roll.type or — fallback — via the roll
  // option string. Total is the SUM of the damage rolls only (NOT attack d20s).
  const components = damageRolls.map((r, i) => ({
    label:  meta.item_name ?? `Damage ${i + 1}`,
    type:   r?.options?.type ?? "none",
    amount: Number(r.total ?? 0),
  }));
  const total = components.reduce((s, c) => s + c.amount, 0);

  const isHealing = meta.type === "healing"
    || damageRolls.some(r => r?.options?.type === "healing"
                          || r?.options?.healing === true);

  const payload = {
    attack_id:              meta.attack_id,
    foundry_combat_uuid:    combat?.uuid ?? null,
    actor_uuid:             actor?.uuid ?? null,
    actor_name:             msg.speaker?.alias ?? actor?.name ?? "Unknown",
    source_label:           meta.item_name ?? "Native attack",
    source_kind:            "native",
    item_uuid:              meta.item_uuid,
    item_name:              meta.item_name,
    activity_uuid:          meta.activity_uuid,
    originating_message_id: meta.originating_message_id,
    components,
    total,
    kind:                   isHealing ? "healing" : "damage",
    target_uuids:           targets,
    crit:                   damageRolls.some(r => r?.options?.critical) || !!msg.flags?.dnd5e?.roll?.critical,
    round:                  combat?.round ?? null,
    turn:                   combat?.turn ?? null,
    occurred_at:            Date.now(),
  };

  rememberAttack(payload);
  post("attack", payload);
}

// dnd5e.applyDamage fires when actor.applyDamage runs (native tray AND our
// macro Apply buttons that call the same method). Stash attribution by target
// actor uuid; updateActor consumes within a 2s window.
Hooks.on("dnd5e.applyDamage", (actor, amount, options) => {
  const msgId = options?.originatingMessage;
  const msg   = msgId ? game.messages.get(msgId) : null;
  if (!msg) return;

  const dmSyncAttack = msg.flags?.[MODULE_ID]?.attack;
  const activityUuid = msg.flags?.dnd5e?.activity?.uuid;
  const originating  = msg.flags?.dnd5e?.originatingMessage ?? msg.id;

  const attack_id = dmSyncAttack?.attack_id
                 ?? (activityUuid ? `native:${originating}` : null);
  if (!attack_id) return;

  pendingApply.set(actor.uuid, {
    attack_id,
    actor_uuid:               dmSyncAttack?.actor_uuid ?? msg.speaker?.actor ?? null,
    actor_name:               dmSyncAttack?.actor_name ?? msg.speaker?.alias ?? null,
    damage_type_breakdown:    deriveBreakdown(dmSyncAttack, amount),
    fired_at:                 Date.now(),
  });
});

function deriveBreakdown(dmSyncAttack, amount) {
  if (!dmSyncAttack?.components) return null;
  // Sum components per damage type, then proportionally scale to the actual
  // amount applied (handles Half-damage / resistances).
  const byType = {};
  for (const c of dmSyncAttack.components) {
    byType[c.type] = (byType[c.type] || 0) + Number(c.amount ?? 0);
  }
  const total = Object.values(byType).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const scale = amount / total;
  return Object.entries(byType).map(([type, amt]) => ({
    type,
    amount: Math.round(amt * scale),
  }));
}

// ---------------------------------------------------------------------------
// Render hook: inject Apply buttons on macro chat cards
// ---------------------------------------------------------------------------

Hooks.on("renderChatMessage", (msg, html /* , data */) => {
  // Only GMs see Apply buttons (matches native behavior).
  if (!game.user.isGM) return;

  const attack = msg.flags?.[MODULE_ID]?.attack;
  if (!attack) return;

  // Avoid double-injection on re-renders.
  const root = html?.[0] ?? html;
  if (root.querySelector?.("[data-action='dmSyncApplyDamage']")) return;

  const kind = attack.kind === "healing" ? "healing" : "damage";
  const buttons = kind === "healing"
    ? [{ label: "Apply Healing", multiplier: -1 }]
    : [
        { label: "Apply Full",  multiplier: 1 },
        { label: "Apply Half",  multiplier: 0.5 },
        { label: "Apply None",  multiplier: 0 },
      ];

  const container = document.createElement("div");
  container.className = "dm-sync-apply-buttons";
  container.style.cssText = "display:flex; gap:6px; padding:6px 4px; border-top:1px solid #ddd; margin-top:6px;";

  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.action = "dmSyncApplyDamage";
    btn.dataset.multiplier = String(b.multiplier);
    btn.dataset.messageId = msg.id;
    btn.textContent = b.label;
    btn.style.cssText = "flex:1; padding:4px 6px; font-size:11px;";
    btn.addEventListener("click", () => handleApplyClick(msg, b.multiplier));
    container.appendChild(btn);
  }

  const cardContent = root.querySelector?.(".chat-card") ?? root.querySelector?.(".message-content") ?? root;
  cardContent.appendChild?.(container);
});

async function handleApplyClick(msg, multiplier) {
  const attack = msg.flags?.[MODULE_ID]?.attack;
  if (!attack) return;

  // Target resolution: prefer GM's currently selected/targeted tokens, fall
  // back to the targets stamped on the attack at fire time.
  let targets = Array.from(game.user.targets ?? []).map(t => t.actor).filter(Boolean);
  if (!targets.length) {
    targets = (attack.target_uuids ?? [])
      .map(uuid => fromUuidSync?.(uuid))
      .filter(a => a && a.system?.attributes?.hp);
  }
  if (!targets.length) {
    ui.notifications?.warn(`[${MODULE_ID}] No target selected to apply damage to.`);
    return;
  }

  const base = Number(attack.total ?? 0);
  const amount = Math.round(base * multiplier);
  if (amount === 0) return;

  const damageType = attack.components?.[0]?.type ?? "none";

  for (const actor of targets) {
    try {
      // Route through dnd5e's applyDamage so the dnd5e.applyDamage hook fires;
      // our hook subscriber stashes pendingApply, and updateActor attaches it.
      // The negative multiplier flag (-1 for healing) inverts via dnd5e.
      const damages = [{ value: Math.abs(amount), type: damageType }];
      await actor.applyDamage(damages, {
        multiplier:         multiplier < 0 ? -1 : 1,
        originatingMessage: msg.id,
      });
    } catch (err) {
      warn(`applyDamage failed for ${actor.name}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public helper API: dmSync.attackMessage, dmSync.attack
// ---------------------------------------------------------------------------

/**
 * Stamp dm-sync flags + POST an attack event + create the chat message.
 * Replaces ChatMessage.create() in player macros. Returns {attack_id, message}.
 *
 * Required: source (string), total (number), components ([{label,type,amount}]),
 *           message ({content, rolls, speaker, sound, ...} for ChatMessage.create).
 * Optional: kind ("damage"|"healing", default "damage"),
 *           targets (array of actor uuids; defaults to game.user.targets snapshot),
 *           crit (bool, default false),
 *           attack_id (string, default randomID()).
 */
async function attackMessage(opts) {
  const flagPayload = buildAttackFlag(opts);

  const messageData = {
    ...(opts.message ?? {}),
    flags: {
      ...(opts.message?.flags ?? {}),
      [MODULE_ID]: {
        ...(opts.message?.flags?.[MODULE_ID] ?? {}),
        attack: flagPayload,
      },
    },
  };

  const created = await ChatMessage.create(messageData);
  postHelperAttack(flagPayload, created?.id);

  return { attack_id: flagPayload.attack_id, message: created };
}

/**
 * Return the flags object for macros that need to keep their own
 * ChatMessage.create call. Also POSTs the attack event.
 */
function attack(opts) {
  const flagPayload = buildAttackFlag(opts);
  postHelperAttack(flagPayload, null);
  return {
    attack_id: flagPayload.attack_id,
    flags: { [MODULE_ID]: { attack: flagPayload } },
  };
}

function buildAttackFlag(opts) {
  const targets = opts.targets ?? Array.from(game.user.targets ?? [])
    .map(t => t.actor?.uuid)
    .filter(Boolean);

  const speakerActor = ChatMessage.getSpeakerActor?.(opts.message?.speaker ?? ChatMessage.getSpeaker());

  return {
    attack_id:    opts.attack_id ?? foundry.utils.randomID(),
    source:       String(opts.source ?? "Unknown"),
    total:        Number(opts.total ?? 0),
    components:   Array.isArray(opts.components) ? opts.components : [],
    kind:         opts.kind === "healing" ? "healing" : "damage",
    target_uuids: targets,
    crit:         !!opts.crit,
    actor_uuid:   speakerActor?.uuid ?? null,
    actor_name:   speakerActor?.name ?? null,
  };
}

function postHelperAttack(flagPayload, createdMessageId) {
  const combat = activeCombat();
  const payload = {
    attack_id:              flagPayload.attack_id,
    foundry_combat_uuid:    combat?.uuid ?? null,
    actor_uuid:             flagPayload.actor_uuid,
    actor_name:             flagPayload.actor_name ?? "Unknown",
    source_label:           flagPayload.source,
    source_kind:            "macro",
    item_uuid:              null,
    item_name:              null,
    activity_uuid:          null,
    originating_message_id: createdMessageId,
    components:             flagPayload.components,
    total:                  flagPayload.total,
    kind:                   flagPayload.kind,
    target_uuids:           flagPayload.target_uuids,
    crit:                   flagPayload.crit,
    round:                  combat?.round ?? null,
    turn:                   combat?.turn ?? null,
    occurred_at:            Date.now(),
  };

  rememberAttack(payload);
  post("attack", payload);
}

// ---------------------------------------------------------------------------
// Full Sync (exposed as a global; the GM wires it to a macro)
// ---------------------------------------------------------------------------

async function fullSync() {
  const ok = await Dialog.confirm({
    title:   game.i18n.localize("DM_SYNC.FullSync.Confirm.Title"),
    content: `<p>${game.i18n.localize("DM_SYNC.FullSync.Confirm.Body")}</p>`,
  });
  if (!ok) return;

  const actors   = game.actors.contents.filter(shouldSyncActor).map(actorPayload);
  const journals = game.journal.contents.map(journalPayload);

  await post("full-sync", { actors, journals });

  ui.notifications.info(
    game.i18n.format("DM_SYNC.FullSync.Done", {
      actors:   actors.length,
      journals: journals.length,
    })
  );
}

Hooks.once("ready", () => {
  log(`ready v${game.modules.get(MODULE_ID)?.version ?? "?"}`);
  globalThis.dmSync = {
    fullSync,
    attackMessage,
    attack,
  };
});
