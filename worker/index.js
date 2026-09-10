/**
 * achievements.sambonius.net
 *
 * A private achievement browser. The page is served by this Worker, and every
 * call to Steam or Xbox Live happens here so the API keys never reach the
 * browser. Nothing is stored: responses are cached in Cloudflare's edge cache
 * for a few minutes and that is the whole persistence story.
 */

import { SITE_HTML } from './site.js';

const COOKIE = 'ach_session';
const SESSION_DAYS = 30;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const enc = new TextEncoder();

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** Constant-time-ish string compare, so a bad token cannot be probed byte by byte. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

/** The signing secret is derived from the password, so there is one less secret to set. */
const signingSecret = (env) => 'ach:v1:' + (env.SITE_PASSWORD || '');

async function isAuthed(request, env) {
  if (!env.SITE_PASSWORD) return false; // fail closed when unconfigured
  const token = readCookie(request, COOKIE);
  if (!token) return false;
  const [expires, sig] = token.split('.');
  if (!expires || !sig) return false;
  if (Number(expires) < Date.now()) return false;
  return safeEqual(sig, await hmac(signingSecret(env), expires));
}

async function issueSession(env) {
  const expires = String(Date.now() + SESSION_DAYS * 864e5);
  const sig = await hmac(signingSecret(env), expires);
  return COOKIE + '=' + expires + '.' + sig +
    '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + SESSION_DAYS * 86400;
}

/* ------------------------------------------------------------------ *
 * Cached fetching
 *
 * The cache key has to live on this Worker's own hostname, so upstream URLs
 * are hashed into a path under /__cache/ rather than used directly.
 * ------------------------------------------------------------------ */

async function cachedJSON(origin, label, ttl, fetcher) {
  const digest = bytesToHex(await crypto.subtle.digest('SHA-256', enc.encode(label))).slice(0, 32);
  const key = new Request(origin + '/__cache/' + digest, { method: 'GET' });
  const cache = caches.default;

  const hit = await cache.match(key);
  if (hit) return hit.json();

  const data = await fetcher();
  const store = new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json', 'cache-control': 'max-age=' + ttl },
  });
  await cache.put(key, store.clone());
  return data;
}

/** fetch + parse JSON, returning null instead of throwing on any non-200 or bad body. */
async function getJSON(url, init) {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Steam
 * ------------------------------------------------------------------ */

const STEAM = 'https://api.steampowered.com';
const steamHeader = (appid) =>
  'https://cdn.cloudflare.steamstatic.com/steam/apps/' + appid + '/header.jpg';

async function steamLibrary(env, origin) {
  if (!env.STEAM_API_KEY || !env.STEAM_ID) return { games: [], warning: null };

  const data = await cachedJSON(origin, 'steam:lib:' + env.STEAM_ID, 600, () =>
    getJSON(STEAM + '/IPlayerService/GetOwnedGames/v1/?key=' + env.STEAM_API_KEY +
      '&steamid=' + env.STEAM_ID +
      '&include_appinfo=true&include_played_free_games=true&format=json'));

  const games = data && data.response && data.response.games;
  if (!Array.isArray(games)) {
    return {
      games: [],
      warning: 'Steam returned no games. Check the API key, and set Game details to Public ' +
        'in Steam privacy settings — that setting governs this API, not just the profile page.',
    };
  }

  return {
    games: games
      // has_community_visible_stats is Steam's flag for "this game reports stats/achievements"
      .filter((g) => g.has_community_visible_stats || g.playtime_forever > 0)
      .map((g) => ({
        platform: 'steam',
        id: String(g.appid),
        name: g.name || 'App ' + g.appid,
        art: steamHeader(g.appid),
        minutesPlayed: g.playtime_forever || 0,
        lastPlayed: g.rtime_last_played ? g.rtime_last_played * 1000 : null,
        mayHaveAchievements: !!g.has_community_visible_stats,
        summary: null,
      })),
    warning: null,
  };
}

async function steamAchievements(env, origin, appid) {
  if (!env.STEAM_API_KEY || !env.STEAM_ID) throw new Error('Steam is not configured.');

  return cachedJSON(origin, 'steam:ach:' + env.STEAM_ID + ':' + appid, 300, async () => {
    const [player, schema, global] = await Promise.all([
      getJSON(STEAM + '/ISteamUserStats/GetPlayerAchievements/v1/?key=' + env.STEAM_API_KEY +
        '&steamid=' + env.STEAM_ID + '&appid=' + appid + '&l=english'),
      getJSON(STEAM + '/ISteamUserStats/GetSchemaForGame/v2/?key=' + env.STEAM_API_KEY +
        '&appid=' + appid + '&l=english'),
      // No key needed, and it is the only source of "how rare is this".
      getJSON(STEAM + '/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=' + appid),
    ]);

    const list = player && player.playerstats && player.playerstats.achievements;
    if (!Array.isArray(list) || !list.length) {
      const err = player && player.playerstats && player.playerstats.error;
      return { achievements: [], note: err || 'This game reports no achievements.' };
    }

    const meta = {};
    const schemaList = schema && schema.game && schema.game.availableGameStats &&
      schema.game.availableGameStats.achievements;
    for (const a of schemaList || []) meta[a.name] = a;

    // Steam sends percent as a string ("49.8"), so coerce rather than trust the type.
    const rarity = {};
    const globalList = global && global.achievementpercentages &&
      global.achievementpercentages.achievements;
    for (const a of globalList || []) {
      const p = Number(a.percent);
      if (Number.isFinite(p)) rarity[a.name] = p;
    }

    return {
      achievements: list.map((a) => {
        const m = meta[a.apiname] || {};
        const earned = a.achieved === 1;
        return {
          id: a.apiname,
          name: a.name || m.displayName || a.apiname,
          description: a.description || m.description || '',
          icon: (earned ? m.icon : m.icongray || m.icon) || null,
          earned,
          unlockedAt: earned && a.unlocktime ? a.unlocktime * 1000 : null,
          points: null, // Steam has no gamerscore equivalent
          rarity: a.apiname in rarity ? rarity[a.apiname] : null,
          secret: m.hidden === 1,
        };
      }),
      note: null,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Xbox, via OpenXBL
 *
 * OpenXBL passes Xbox Live's payloads through mostly untouched, and those
 * differ between modern titles and Xbox 360 ones. Everything below reads
 * defensively and normalises to one shape.
 * ------------------------------------------------------------------ */

const XBL = 'https://xbl.io/api/v2';
const xblHeaders = (env) => ({ 'x-authorization': env.XBL_API_KEY, accept: 'application/json' });

function xblImage(entry) {
  if (!entry) return null;
  if (Array.isArray(entry.displayImage)) return entry.displayImage[0] || null;
  if (typeof entry.displayImage === 'string') return entry.displayImage;
  const assets = entry.mediaAssets || entry.images || [];
  if (!Array.isArray(assets)) return null;
  const art = assets.find((m) => m && /box|poster|tile|icon/i.test(m.type || '')) || assets[0];
  return (art && art.url) || null;
}

async function xboxLibrary(env, origin) {
  if (!env.XBL_API_KEY) return { games: [], warning: null };

  const data = await cachedJSON(origin, 'xbl:lib', 600, async () =>
    // The achievements endpoint carries per-title progress; titleHistory is the
    // fallback when the account returns nothing there.
    (await getJSON(XBL + '/achievements/', { headers: xblHeaders(env) })) ||
    (await getJSON(XBL + '/player/titleHistory', { headers: xblHeaders(env) })));

  const titles = (data && (data.titles || data.achievements)) || [];
  if (!Array.isArray(titles) || !titles.length) {
    return { games: [], warning: 'Xbox returned no titles. Check the OpenXBL key at xbl.io.' };
  }

  return {
    games: titles.map((t) => {
      const prog = t.achievement || {};
      const history = t.titleHistory || {};
      return {
        platform: 'xbox',
        id: String(t.titleId || t.id),
        name: t.name || t.titleName || 'Unknown title',
        art: xblImage(t),
        minutesPlayed: null,
        lastPlayed: history.lastTimePlayed ? Date.parse(history.lastTimePlayed) || null : null,
        mayHaveAchievements: true,
        // Xbox hands us the summary up front, so the list can show progress
        // without opening every game.
        summary: {
          earned: prog.currentAchievements != null ? prog.currentAchievements : null,
          total: prog.totalAchievements != null ? prog.totalAchievements : null,
          points: prog.currentGamerscore != null ? prog.currentGamerscore : null,
          totalPoints: prog.totalGamerscore != null ? prog.totalGamerscore : null,
        },
      };
    }),
    warning: null,
  };
}

/** True for both the modern "Achieved" string and the Xbox 360 boolean. */
const xblEarned = (a) =>
  a.progressState === 'Achieved' || a.progressState === 'Earned' || a.unlocked === true;

function xblPoints(a) {
  if (typeof a.gamerscore === 'number') return a.gamerscore; // Xbox 360 shape
  const rewards = Array.isArray(a.rewards) ? a.rewards : [];
  const reward = rewards.find((r) => r && /gamerscore/i.test(r.type || ''));
  return reward ? Number(reward.value) || 0 : null;
}

function xblIcon(a) {
  const assets = Array.isArray(a.mediaAssets) ? a.mediaAssets : [];
  const asset = assets.find((m) => m && /icon/i.test(m.type || '')) || assets[0];
  return (asset && asset.url) || null;
}

async function xboxAchievements(env, origin, titleId) {
  if (!env.XBL_API_KEY) throw new Error('Xbox is not configured.');

  return cachedJSON(origin, 'xbl:ach:' + titleId, 300, async () => {
    let collected = [];
    let token = null;

    // Titles with a lot of achievements come back paged.
    for (let page = 0; page < 10; page++) {
      const url = token
        ? XBL + '/achievements/title/' + titleId + '/' + encodeURIComponent(token)
        : XBL + '/achievements/title/' + titleId;
      const body = await getJSON(url, { headers: xblHeaders(env) });
      const batch = (body && (body.achievements || body.titles)) || [];
      if (!Array.isArray(batch) || !batch.length) break;
      collected = collected.concat(batch);
      token = (body.pagingInfo && body.pagingInfo.continuationToken) || null;
      if (!token) break;
    }

    if (!collected.length) {
      return {
        achievements: [],
        note: 'No achievements came back for this title. Xbox 360 era titles often need the ' +
          'console-specific endpoint, which requires your XUID.',
      };
    }

    return {
      achievements: collected.map((a) => {
        const earned = xblEarned(a);
        const unlocked = (a.progression && a.progression.timeUnlocked) || a.timeUnlocked;
        // Xbox Live sends this as a string too, same as Steam.
        const rare = a.rarity ? Number(a.rarity.currentPercentage) : NaN;
        return {
          id: String(a.id != null ? a.id : a.name),
          name: a.name || 'Unknown achievement',
          description: (earned ? a.description : a.lockedDescription || a.description) || '',
          icon: xblIcon(a),
          earned,
          unlockedAt: earned && unlocked ? Date.parse(unlocked) || null : null,
          points: xblPoints(a),
          rarity: Number.isFinite(rare) ? rare : null,
          secret: a.isSecret === true,
        };
      }),
      note: null,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

async function handleAPI(request, env, url) {
  const origin = url.origin;

  if (url.pathname === '/api/library') {
    const [steam, xbox] = await Promise.all([
      steamLibrary(env, origin).catch((e) => ({ games: [], warning: String(e.message || e) })),
      xboxLibrary(env, origin).catch((e) => ({ games: [], warning: String(e.message || e) })),
    ]);

    const warnings = [steam.warning, xbox.warning].filter(Boolean);
    if (!env.STEAM_API_KEY || !env.STEAM_ID) {
      warnings.push('Steam is not configured yet (STEAM_API_KEY / STEAM_ID).');
    }
    if (!env.XBL_API_KEY) warnings.push('Xbox is not configured yet (XBL_API_KEY).');

    return json({ games: steam.games.concat(xbox.games), warnings });
  }

  if (url.pathname === '/api/game') {
    const platform = url.searchParams.get('platform');
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'Missing id.' }, 400);
    try {
      if (platform === 'steam') return json(await steamAchievements(env, origin, id));
      if (platform === 'xbox') return json(await xboxAchievements(env, origin, id));
      return json({ error: 'Unknown platform.' }, 400);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  }

  // Raw upstream passthrough. Useful when a title comes back in a shape the
  // normalisers above have not seen yet.
  if (url.pathname === '/api/raw') {
    const path = url.searchParams.get('path') || '';
    if (!path.startsWith('/api/v2/')) return json({ error: 'Only OpenXBL /api/v2/ paths.' }, 400);
    if (!env.XBL_API_KEY) return json({ error: 'Xbox is not configured.' }, 400);
    const res = await fetch('https://xbl.io' + path, { headers: xblHeaders(env) });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  return json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/login' && request.method === 'POST') {
      if (!env.SITE_PASSWORD) return json({ error: 'No password is set on the Worker yet.' }, 503);
      const body = await request.json().catch(() => ({}));
      if (!safeEqual(String(body.password || ''), env.SITE_PASSWORD)) {
        return json({ error: 'Wrong password.' }, 401);
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json', 'set-cookie': await issueSession(env) },
      });
    }

    if (url.pathname === '/api/logout') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          'content-type': 'application/json',
          'set-cookie': COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
        },
      });
    }

    // Cached upstream payloads are stored under this prefix on our own hostname.
    // Requests reach the Worker before the edge cache is consulted, so these are
    // not actually reachable — but refuse them outright rather than rely on that.
    if (url.pathname.startsWith('/__cache/')) return json({ error: 'Not found.' }, 404);

    const authed = await isAuthed(request, env);

    if (url.pathname.startsWith('/api/')) {
      if (!authed) return json({ error: 'Not signed in.' }, 401);
      return handleAPI(request, env, url);
    }

    // Everything else is the single page. It renders its own sign-in screen
    // when the session flag says we are locked out.
    const page = SITE_HTML
      .replace('__AUTHED__', authed ? 'true' : 'false')
      .replace('__CONFIGURED__', env.SITE_PASSWORD ? 'true' : 'false');

    return new Response(page, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  },
};
