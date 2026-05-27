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
// Hooks
// ---------------------------------------------------------------------------

Hooks.on("createActor", (a) => {
  if (!shouldSyncActor(a)) return;
  post("actor", actorPayload(a));
});
Hooks.on("updateActor", (a) => {
  if (!shouldSyncActor(a)) return;
  post("actor", actorPayload(a));
});
Hooks.on("deleteActor", (a) => {
  if (!shouldSyncActor(a)) return;
  post("actor", { uuid: a.uuid, type: a.type, deleted: true });
});

Hooks.on("createJournalEntry", (j) => post("journal", journalPayload(j)));
Hooks.on("updateJournalEntry", (j) => post("journal", journalPayload(j)));

Hooks.on("combatStart",  (c) => post("combat", { uuid: c.uuid, event: "start", scene: c.scene?.name }));
Hooks.on("deleteCombat", (c) => post("combat", { uuid: c.uuid, event: "end" }));

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
