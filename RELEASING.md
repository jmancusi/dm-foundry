# Releasing `dm-sync`

How to ship a new version of the Foundry module to your live world.

## The short version

```bash
# 1. (Only if shipping a new version) bump module.json, commit, push:
git add module.json && git commit -m "Bump to vX.Y.Z" && git push

# 2. Tag, build the zip, publish the GitHub release:
./deploy/release.sh

# 3. ssh to the Linode and pull both repos:
sudo /var/www/dm/deploy/deploy-all.sh

# 4. In Foundry: Game Settings → Manage Modules → Check for Updates → Update.
```

That's it. The rest of this file is what `release.sh` actually does and why, for when something goes wrong.

## Mental model

The module ships through two URLs that have to stay in sync:

| Thing | Where it lives | Who reads it |
|---|---|---|
| **Manifest** (`module.json`) | Apache-served from `https://dm-foundry.thirdwheelgames.com/module.json`, which is the file at `/var/www/dm-foundry/module.json` on the Linode | Foundry, when you click "Check for Updates" |
| **Download** (`dm-sync.zip`) | GitHub release attachment at `https://github.com/jmancusi/dm-foundry/releases/latest/download/dm-sync.zip` | Foundry, after the manifest says a new version exists |

So a deploy means: bump the version in `module.json`, push the change, build a zip with the matching code, attach it to a GitHub release, and pull the manifest file onto the Linode.

If the manifest says `0.3.0` but no release zip exists, Foundry's update will 404. If the release zip exists but the manifest still says `0.2.0`, Foundry will never offer the update. Both have to move together — and `release.sh` does both in one go.

## What `release.sh` does

Run from anywhere inside the repo:

```bash
./deploy/release.sh
```

The script:

1. **Preflights:** verifies `gh` is installed + authenticated, working tree is clean, you're on `main`, and `origin/main` matches `HEAD` (so the release tag will match what's published on GitHub).
2. **Reads the version** out of `module.json`. Bails if a tag or GitHub release with that version already exists — version bumps must be deliberate.
3. **Builds `/tmp/dm-sync.zip`** with `git archive` from `HEAD`, including only `module.json`, `scripts/`, and `lang/`. Using `git archive` (instead of plain `zip`) guarantees the zip contents exactly match the committed tree — uncommitted edits can't sneak in.
4. **Creates the annotated tag `v<version>` and pushes it.**
5. **Publishes a GitHub release** for that tag with the zip attached, auto-generating notes from commits since the last release (`gh release create --generate-notes`).
6. **Prints the manual follow-ups** (Linode + Foundry).

If anything fails, the script exits and prints what to do. The most common recovery is "delete the tag and re-run" — the failure message tells you the exact commands.

## Manual fallback (if the script breaks)

### Release checklist

### 1. Bump the version (only when shipping a new release)

Edit `module.json` — change `"version": "X.Y.Z"`. Semver is loose; current convention is to bump the minor for new capabilities (combat stats was 0.2.0, dice rolls bundled in stayed 0.2.0) and the patch for fixes.

Commit and push the bump along with whatever code changes the release contains.

> Skip this step if you're shipping additional commits under the same version that hasn't been released yet — e.g. bundling more features into an unreleased 0.2.0. The version only needs to advance once per published release.

### 2. Tag the release commit

```bash
cd /path/to/dm-foundry
git tag v0.2.0          # match module.json version, prefix with "v"
git push origin v0.2.0
```

GitHub uses the tag to anchor the release and to power the `/releases/latest/` URL.

### 3. Build the zip

From a clean checkout of the tagged commit:

```bash
cd /path/to/dm-foundry
rm -f /tmp/dm-sync.zip
zip -r /tmp/dm-sync.zip module.json scripts lang
```

Only those three things go in the zip — everything else (`CLAUDE.md`, `EVENTS.md`, `RELEASING.md`, `deploy/`, `.git/`) is dev/docs and would just bloat the download.

Sanity check:

```bash
unzip -l /tmp/dm-sync.zip
# should show:
#   module.json
#   scripts/main.js
#   lang/en.json
```

### 4. Publish the GitHub release

```bash
gh release create v0.2.0 /tmp/dm-sync.zip \
  --title "v0.2.0" \
  --notes "Damage / healing / kill tracking + dice roll logging + monster bestiary fields. See EVENTS.md."
```

Or via the web UI: <https://github.com/jmancusi/dm-foundry/releases/new> → pick the tag → drag the zip → publish.

**Important:** the file MUST be named exactly `dm-sync.zip` (it's hard-coded in `module.json`'s `download` URL). GitHub will fail the Foundry download if you upload it as `dm-sync-0.2.0.zip` or similar.

### 5. Pull the new manifest onto the Linode

SSH to the Linode, then:

```bash
sudo /var/www/dm/deploy/deploy-all.sh
```

This pulls both the dm Laravel app and the dm-foundry module repo, runs Laravel migrations if dm changed, and prints the module version so you can confirm the manifest moved.

### 6. Update inside Foundry

In the running world:

1. Game Settings (gear icon, bottom left)
2. **Manage Modules**
3. **Check for Updates** at the top
4. Find `DM Campaign Prep Sync` in the list — it should show "Update available" with the new version
5. Click **Update**
6. **Save Module Settings** at the bottom — Foundry will offer to reload the world. Reload.

The module's settings (endpoint, campaign id, secret) persist across updates — you don't need to re-enter them.

## Verifying the release

After the world reloads:

1. Open the browser DevTools console (F12) and look for the boot log:

   ```
   [dm-sync] ready v0.2.0
   ```

   If you see the old version, the world didn't actually reload, OR the zip you uploaded was stale.

2. Do one round-trip per feature you released. For v0.2.0 that's:
   - Edit a PC's HP → confirm the Laravel side shows the change.
   - Start a combat → confirm an Encounter row appears.
   - Apply damage during a combat turn → confirm the Encounter has DamageEvent rows.
   - Roll a d20 in chat → confirm a DiceRoll row exists.
   - Kill a monster → confirm a MonsterKill row + the Monster bestiary entry.

3. If something is wrong, check `storage/logs/laravel.log` on the Linode (or `Filament → FoundrySyncEvents` if you wired that up) — every webhook is logged there with its payload and status.

## Troubleshooting

### "Check for Updates" doesn't find the new version
- Hard-refresh the manifest URL: `curl https://dm-foundry.thirdwheelgames.com/module.json | grep version` — it should show the new version. If not, the Linode pull didn't happen.
- Apache caches: usually not an issue for plain static files, but `sudo systemctl reload apache2` doesn't hurt.

### "Update available" but clicking Update fails
- Almost always means the GitHub release zip is missing, mis-named, or attached to the wrong tag.
- Test the download manually:
  ```bash
  curl -fLI https://github.com/jmancusi/dm-foundry/releases/latest/download/dm-sync.zip
  ```
  Should return `200 OK` with a `Content-Disposition: attachment; filename=dm-sync.zip`.

### Module update succeeds but the world acts unchanged
- The browser cached the old `main.js`. Hard-refresh (Ctrl/Cmd+Shift+R) inside Foundry.
- Confirm the version line in the console matches the new release.

### Settings disappeared after update
- They shouldn't — the module ID (`dm-sync`) is stable, so world settings persist. If they're actually gone, you probably changed the module ID in `module.json`. Don't.

## Why we bundle releases

Each release is at least a 10-minute manual dance (zip, tag, release, Linode, Foundry update). When you have multiple features in flight, batch them into one version before publishing — see `MEMORY.md` for the "bundle module releases" feedback. It's cheap to add one more module-side capability before cutting the release; it's expensive to do a second release a day later.
