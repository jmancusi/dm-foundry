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

  const attacker = activeCombatantActor();
  const isDamage = delta > 0;
  post("combat", {
    uuid:               combat.uuid,
    event:              isDamage ? "damage" : "healing",
    attacker_uuid:      attacker?.uuid ?? null,
    target_uuid:        a.uuid,
    target_name:        a.name,
    target_source_uuid: actorSourceUuid(a),
    target_img:         a.img ?? null,
    attacker_name:      attacker?.name ?? null,
    amount:             Math.abs(delta),
    hp_before:          oldHp,
    hp_after:           newHp,
    killed:             isDamage && oldHp > 0 && newHp <= 0,
    round:              combat.round,
    turn:               combat.turn,
    occurred_at:        Date.now(),
  });
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

// Classify a chat message's roll into a (type, subtype) pair. Works best on dnd5e;
// other systems gracefully degrade to {type: "other"}.
function classifyRoll(msg) {
  const flag = msg.flags?.dnd5e?.roll;
  if (!flag) return { type: "other", subtype: null };
  return {
    type:    flag.type ?? "other",
    subtype: flag.ability ?? flag.skillId ?? flag.tool ?? null,
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
  if (!msg.rolls?.length) return;

  const { type, subtype } = classifyRoll(msg);
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
        uuid:           msg.uuid ?? msg.id,
        roll_index:     idx,
        actor_uuid:     actor?.uuid ?? null,
        actor_name:     msg.speaker?.alias ?? actor?.name ?? "Unknown",
        type,
        subtype,
        formula:        roll.formula ?? "",
        total:          Number(roll.total ?? 0),
        d20:            d20?.d20 ?? null,
        d20_other:      d20?.d20_other ?? null,
        advantage_mode: d20?.advantage_mode ?? null,
        is_nat_20:      d20?.d20 === 20,
        is_nat_1:       d20?.d20 === 1,
        target_uuids:   targetUuids.length ? targetUuids : null,
        round,
        turn,
        occurred_at:    Date.now(),
      });
    } catch (err) {
      warn(`roll extract failed: ${err.message}`);
    }
  });
});

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
  globalThis.dmSync = { fullSync };
});
