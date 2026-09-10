# achievements.sambonius.net

A private browser for Samuel's Steam and Xbox achievements. Pick a game from the
selector, see everything unlocked and everything still outstanding, with unlock
dates, gamerscore and rarity.

## How it is put together

A single Cloudflare Worker does everything:

- **serves the page** — `site/index.html`, inlined into the bundle by `build.mjs`
- **calls Steam and Xbox itself**, so the API keys never reach the browser
- **gates the whole thing behind a password**, because the achievement data is
  private (an HMAC-signed, http-only session cookie, good for 30 days)

Nothing is stored anywhere. Upstream responses are held in Cloudflare's edge
cache for 5–10 minutes and that is the extent of the persistence.

```
site/index.html    the page: game selector, per-game achievement list
worker/index.js    auth, routing, Steam + Xbox API layer, normalisers
build.mjs          inlines the HTML into worker/site.js (generated, gitignored)
wrangler.toml      Worker config + the achievements.sambonius.net custom domain
```

## Setup

### 1. GitHub secrets, so pushes deploy

```sh
gh secret set CLOUDFLARE_API_TOKEN   --repo SamuelArther/achievements
gh secret set CLOUDFLARE_ACCOUNT_ID  --repo SamuelArther/achievements
```

Create the token at **dash.cloudflare.com → My Profile → API Tokens → Create
Token → Edit Cloudflare Workers**. When it asks which zone, include
`sambonius.net` — the custom domain in `wrangler.toml` needs to write a DNS
record there. The account ID is on the right-hand side of the Workers overview
page.

### 2. Push

Any push to `main` builds, checks that the Worker parses, and deploys. The first
successful deploy also creates the `achievements.sambonius.net` DNS record.

### 3. Worker secrets

These are set **on the Worker**, not in GitHub, so the keys live in exactly one
place. After the first deploy: **Cloudflare dashboard → Workers & Pages →
achievements → Settings → Variables and Secrets → Add**, type *Secret*.

| Name | What it is |
| --- | --- |
| `SITE_PASSWORD` | The password for the site. Until this is set, the site refuses everyone — it fails closed. |
| `STEAM_API_KEY` | From <https://steamcommunity.com/dev/apikey> |
| `STEAM_ID` | Your 64-bit SteamID, the 17-digit number |
| `XBL_API_KEY` | From <https://xbl.io> — sign in with your Microsoft account and create a key |

Adding a secret redeploys the Worker on its own; no push needed.

#### Steam privacy

`GetOwnedGames` and `GetPlayerAchievements` return nothing unless **Steam →
Profile → Privacy Settings → Game details** is set to **Public**. This is a
separate setting from the profile itself, and it is the usual reason the library
comes back empty.

#### Finding your SteamID

Open <https://steamcommunity.com/my/> — if the URL shows `/profiles/7656119…`
that number is the SteamID. If it shows a vanity name instead, paste the profile
URL into <https://steamid.io>.

## Notes on the two APIs

**Steam** has no per-game progress in the library call, so the sidebar fills in
completion for a game once you open it. Rarity comes from
`GetGlobalAchievementPercentagesForApp`, which needs no key.

**Xbox** goes through [OpenXBL](https://xbl.io). It returns per-title progress up
front, so Xbox games show their completion immediately. Xbox Live hands back two
different achievement shapes — the modern one (`progressState: "Achieved"`,
gamerscore inside `rewards`) and the Xbox 360 one (`unlocked: true`, a flat
`gamerscore` field) — and `worker/index.js` normalises both.

If a title comes back looking wrong, `/api/raw?path=/api/v2/...` proxies straight
through to OpenXBL (signed in only) so you can see the untouched payload.
