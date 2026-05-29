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

// Classify a chat message's roll. Reads dnd5e flags for type/subtype/item/activity
// context. Also picks up dm-sync helper flags when present (macro path).
function classifyRoll(msg) {
  const dnd5e = msg.flags?.dnd5e ?? {};
  const dmSync = msg.flags?.[MODULE_ID]?.attack ?? null;

  return {
    type:    dnd5e.roll?.type ?? (dmSync ? "damage" : "other"),
    subtype: dnd5e.roll?.ability ?? dnd5e.roll?.skillId ?? dnd5e.roll?.tool ?? null,

    item_uuid:              dnd5e.item?.uuid ?? null,
    item_name:              null, // populated from item document lookup if needed
    activity_uuid:          dnd5e.activity?.uuid ?? null,
    originating_message_id: dnd5e.originatingMessage ?? msg.id ?? null,
    attack_id:              dmSync?.attack_id
      ?? (dnd5e.originatingMessage ? `native:${dnd5e.originatingMessage}` : null),
  };
}

// Extract the chosen d20 face from a Roll, including advantage/disadvantage mode
// and the discarded face when present. Returns null when the roll has no d20 term.
function extractD20(roll) {
  const d20Term = (roll?.dice ?? []).find(d => d.faces === 20);
  if (!d20Term) return null;

  const results = d20Term.results ?? [];
  const active  = results.find(r => r.active) ?? results[0];
  const all     = results.map(r => r.result);

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

Hooks.on("createChatMessage", (msg) => {
  if (msg.flags?.dm_sync_ignore === true) return;

  const meta = classifyRoll(msg);

  // For native damage/healing messages with an activity, synthesize an attack
  // event ONCE per originating message so Laravel has the parent record by the
  // time the apply click sends a damage event.
  if ((meta.type === "damage" || meta.type === "healing")
      && meta.activity_uuid
      && meta.attack_id
      && !msg.flags?.[MODULE_ID]?.attack
      && !postedAttacks.has(meta.attack_id)) {
    postedAttacks.add(meta.attack_id);
    postNativeAttack(msg, meta);
  }

  if (!msg.rolls?.length) return;

  const actor   = ChatMessage.getSpeakerActor?.(msg.speaker) ?? null;
  const combat  = activeCombat();
  const round   = combat?.round ?? null;
  const turn    = combat?.turn  ?? null;
  const targetUuids = Array.from(msg.flags?.dnd5e?.targets ?? [])
    .map(t => t?.uuid)
    .filter(Boolean);

  msg.rolls.forEach((roll, idx) => {
    try {
      const d20 = extractD20(roll);
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
});

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

// Build and POST an attack event synthesized from a native dnd5e damage roll
// message. Called once per (originatingMessage, activity.uuid) pair.
function postNativeAttack(msg, meta) {
  const actor   = ChatMessage.getSpeakerActor?.(msg.speaker) ?? null;
  const combat  = activeCombat();
  const targets = Array.from(msg.flags?.dnd5e?.targets ?? [])
    .map(t => t?.uuid)
    .filter(Boolean);

  // Aggregate roll totals into a single component (we don't know the per-type
  // breakdown from a chat message alone — dnd5e bundles types into Roll terms).
  const total = (msg.rolls ?? []).reduce((sum, r) => sum + Number(r.total ?? 0), 0);

  const itemName = msg.flags?.dnd5e?.item?.uuid
    ? fromUuidSync?.(msg.flags.dnd5e.item.uuid)?.name ?? null
    : null;

  const payload = {
    attack_id:              meta.attack_id,
    foundry_combat_uuid:    combat?.uuid ?? null,
    actor_uuid:             actor?.uuid ?? null,
    actor_name:             msg.speaker?.alias ?? actor?.name ?? "Unknown",
    source_label:           itemName ?? "Native attack",
    source_kind:            "native",
    item_uuid:              meta.item_uuid,
    item_name:              itemName,
    activity_uuid:          meta.activity_uuid,
    originating_message_id: meta.originating_message_id,
    components: [{
      label: itemName ?? "Damage",
      type:  inferDamageType(msg) ?? "none",
      amount: total,
    }],
    total,
    kind:                   meta.type === "healing" ? "healing" : "damage",
    target_uuids:           targets,
    crit:                   !!msg.flags?.dnd5e?.roll?.critical,
    round:                  combat?.round ?? null,
    turn:                   combat?.turn ?? null,
    occurred_at:            Date.now(),
  };

  rememberAttack(payload);
  post("attack", payload);
}

// Best-effort damage type from the first roll's options.type (dnd5e v5+).
function inferDamageType(msg) {
  const first = msg.rolls?.[0];
  return first?.options?.type ?? null;
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
