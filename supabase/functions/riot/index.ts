// @ts-nocheck
// =====================================================================
//  Edge Function « riot » — suivi automatique du SoloQ Challenge
//
//  L'API Riot ne donne PAS les LP d'une partie. On les déduit :
//  on relève régulièrement le rang de chaque joueur (League-V4) et,
//  quand son total victoires + défaites augmente, l'écart de LP entre
//  deux relevés est le gain de la partie. Match-V5 dit laquelle, avec
//  qui, et si c'était un duo.
//
//  Actions (POST, corps JSON) :
//    { action: "sync" }                 relevé de tous les joueurs (étranglé)
//    { action: "register", riotId }     inscription, compte vérifié chez Riot
//
//  Gagner une partie en duo avec un coéquipier fait tomber un objet.
//
//  Secret requis : RIOT_API_KEY  (Edge Functions > Secrets)
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2";


// ==================== LOGIQUE PURE — DÉBUT ====================
// Aucun import, aucun appel réseau : ce bloc est testé tel quel.

const TIER_ORDER = ["IRON","BRONZE","SILVER","GOLD","PLATINUM","EMERALD","DIAMOND","MASTER","GRANDMASTER","CHALLENGER"];
const ROMAN_TO_DIV = { I:1, II:2, III:3, IV:4 };
const APEX_FROM = 7;          // MASTER et au-dessus : pas de division
const QUEUE_SOLO = 420;       // Classée Solo/Duo
// Un butin tombe à chaque victoire en duo avec un coéquipier.
const POIDS_RARETE = { commun: 60, rare: 30, legendaire: 10 };

// Même barème que le site : palier x 400 + division x 100 + LP.
function toScore(tier, division, lp){
  const i = TIER_ORDER.indexOf(tier);
  if(i < 0) return 0;
  if(i >= APEX_FROM) return 2800 + (lp || 0);
  return i * 400 + (4 - division) * 100 + (lp || 0);
}

function snapshotFromEntries(entries){
  const e = (entries || []).find(x => x.queueType === "RANKED_SOLO_5x5");
  if(!e) return { ranked:false, tier:null, division:null, lp:0, wins:0, losses:0, score:0 };
  const division = ROMAN_TO_DIV[e.rank] || 1;
  return {
    ranked: true, tier: e.tier, division, lp: e.leaguePoints,
    wins: e.wins, losses: e.losses,
    score: toScore(e.tier, division, e.leaguePoints)
  };
}

// Que s'est-il passé entre deux relevés ?
function compareSnapshots(prev, next){
  if(!prev) return { type:"baseline" };
  if(!next.ranked) return { type:"none" };
  if(!prev.ranked) return { type:"baseline" };        // fin des placements : on part d'ici
  const n = (next.wins + next.losses) - (prev.wins + prev.losses);
  const delta = next.score - prev.score;              // traverse promotions et rétrogradations
  if(n < 0) return { type:"baseline" };               // reset de saison
  if(n === 0) return delta === 0 ? { type:"none" } : { type:"adjust", delta };  // esquive, décroissance
  return { type:"games", n, wins: next.wins - prev.wins, delta };
}

// Lecture d'une partie du point de vue d'un joueur.
function readMatch(match, puuid, byPuuid, myTeam){
  const info = match && match.info;
  if(!info || info.queueId !== QUEUE_SOLO) return null;
  const me = (info.participants || []).find(p => p.puuid === puuid);
  if(!me) return null;

  const start = info.gameStartTimestamp || info.gameCreation;
  const end = info.gameEndTimestamp || (start + (info.gameDuration || 0) * 1000);

  // Un joueur du challenge dans la MÊME équipe LoL = duo.
  let partner = null;
  for(const p of info.participants){
    if(p.puuid === puuid || p.teamId !== me.teamId) continue;
    if(byPuuid[p.puuid]){ partner = byPuuid[p.puuid]; break; }
  }
  return {
    matchId: match.metadata.matchId,
    start, end,
    win: !!me.win,
    remake: !!me.gameEndedInEarlySurrender,
    champion: me.championName || null,
    partnerId: partner ? partner.id : null,
    duo: !partner ? "solo" : (partner.team === myTeam ? "team" : "enemy")
  };
}

// Retient les n parties qui expliquent l'évolution du relevé.
function attributeGames(readings, n, wins){
  const valid = readings.filter(r => r && !r.remake).sort((a, b) => a.end - b.end);
  if(valid.length < n) return { ok:false, reason:"partie pas encore publiée par Riot" };
  const chosen = valid.slice(-n);
  if(chosen.filter(r => r.win).length !== wins) return { ok:false, reason:"résultats incohérents" };
  return { ok:true, games: chosen };
}

// Répartit l'écart de LP. Une seule partie : exact. Plusieurs : estimé,
// avec une somme toujours juste et jamais une victoire négative.
function splitLp(delta, games){
  const n = games.length;
  if(n === 1) return { lps:[delta], approx:false };
  const w = games.filter(g => g.win).length, l = n - w;
  let m = (w !== l) ? Math.abs(delta) / Math.abs(w - l) : 20;
  m = Math.max(5, Math.min(40, Math.round(m)));
  const lps = games.map(g => g.win ? m : -m);
  let rest = delta - lps.reduce((a, b) => a + b, 0);
  for(let i = 0, garde = 0; rest !== 0 && garde < 5000; i++, garde++){
    const k = i % n, s = Math.sign(rest), v = lps[k] + s;
    if((games[k].win && v >= 1) || (!games[k].win && v <= -1)){ lps[k] = v; rest -= s; }
  }
  return { lps, approx:true };
}

// Tirage pondéré par la rareté. `alea` entre 0 et 1 : fourni par les tests,
// tiré au sort en vrai.
function tirerObjet(items, alea){
  const actifs = (items || []).filter(i => i && i.active !== false);
  if(!actifs.length) return null;
  const poids = i => POIDS_RARETE[i.rarity] || 1;
  const total = actifs.reduce((a, i) => a + poids(i), 0);
  let x = (alea === undefined ? Math.random() : alea) * total;
  for(const i of actifs){ x -= poids(i); if(x < 0) return i; }
  return actifs[actifs.length - 1];
}

function clampLp(v){ return Math.max(-200, Math.min(200, Math.round(v))); }

// Un Riot ID copié depuis Discord traîne souvent des caractères de contrôle
// bidirectionnels invisibles (U+2066–U+2069…) : Riot ne trouve alors plus le compte.
function cleanRiotText(v){
  return String(v || "").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "").trim();
}
function splitRiotId(v){
  const clean = cleanRiotText(v);
  const cut = clean.lastIndexOf("#");
  if(cut < 1 || cut === clean.length - 1) return null;
  const gameName = clean.slice(0, cut).trim(), tagLine = clean.slice(cut + 1).trim();
  return (gameName && tagLine) ? { gameName, tagLine } : null;
}

// Heure de Paris — le challenge est borné en jours français.
function parisParts(ms){
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone:"Europe/Paris", hourCycle:"h23",
    year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit" });
  return Object.fromEntries(dtf.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
}
function parisDate(ms){
  const p = parisParts(ms);
  return p.year + "-" + p.month + "-" + p.day;
}
function parisMidnight(dateStr){
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const p = parisParts(guess);
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - guess;
  return guess - offset;
}
// ==================== LOGIQUE PURE — FIN ====================


const RIOT_KEY = Deno.env.get("RIOT_API_KEY") ?? "";
const PLATFORM = "https://euw1.api.riotgames.com";
const REGION   = "https://europe.api.riotgames.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

class RiotError extends Error {
  constructor(status, message){ super(message); this.status = status; }
}

async function riot(url){
  for(let essai = 0; essai < 2; essai++){
    const r = await fetch(url, { headers: { "X-Riot-Token": RIOT_KEY } });
    if(r.status === 404) return null;
    if(r.status === 429){
      const attente = Number(r.headers.get("Retry-After") || "1");
      if(essai === 0 && attente <= 3){ await new Promise(ok => setTimeout(ok, attente * 1000)); continue; }
      throw new RiotError(429, "Limite de requêtes Riot atteinte, nouvel essai au prochain relevé.");
    }
    if(r.status === 401 || r.status === 403){
      // 403 = clé expirée ou révoquée (le cas d'une clé de développement,
      // qui ne vit que 24 h). 401 = en-tête absent ou clé mal formée.
      // Jamais le moindre morceau de la clé ici : cette réponse est publique.
      // On décrit seulement sa forme, ce qui suffit à repérer un copier-coller raté.
      const forme = "longueur " + RIOT_KEY.length
        + (RIOT_KEY.startsWith("RGAPI-") ? ", préfixe RGAPI- présent" : ", PRÉFIXE RGAPI- ABSENT")
        + (RIOT_KEY !== RIOT_KEY.trim() ? ", ESPACES EN BORD" : "")
        + (/["']/.test(RIOT_KEY) ? ", GUILLEMETS DANS LA VALEUR" : "");
      throw new RiotError(r.status, r.status === 403
        ? "Clé API Riot refusée (403) : expirée ou révoquée. Une clé de développement meurt toutes les 24 h — regénère-la sur developer.riotgames.com, puis remplace le secret RIOT_API_KEY. Forme de la clé lue : " + forme
        : "Clé API Riot refusée (401) : clé mal formée. Vérifie qu'il n'y a ni espace ni guillemet autour de la valeur du secret. Forme de la clé lue : " + forme);
    }
    if(!r.ok) throw new RiotError(r.status, "Riot a répondu " + r.status + ".");
    return r.json();
  }
}

async function whoIs(req){
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if(!token || token.startsWith("sb_")) return null;          // clé publique = visiteur anonyme
  const { data, error } = await db.auth.getUser(token);
  return error ? null : data.user;
}
async function isAdmin(uid){
  const { data } = await db.from("profiles").select("is_admin").eq("id", uid).maybeSingle();
  return !!(data && data.is_admin);
}
async function playerOf(user){
  if(!user) return null;
  const { data } = await db.from("players").select("*").eq("claimed_by", user.id).maybeSingle();
  return data;
}

const rowToSnap = r => ({
  ranked: r.ranked, tier: r.tier, division: r.division, lp: r.lp,
  wins: r.wins, losses: r.losses, score: r.score, checkedAt: new Date(r.checked_at).getTime()
});
async function saveSnap(playerId, s, now){
  const { error } = await db.from("rank_snapshots").upsert({
    player_id: playerId, ranked: s.ranked, tier: s.tier, division: s.division, lp: s.lp,
    wins: s.wins, losses: s.losses, score: s.score, checked_at: new Date(now).toISOString()
  });
  if(error) throw error;
}


/* ----------------------------- relevé ----------------------------- */
async function sync(force){
  const { data: go } = await db.rpc("riot_try_start_sync", { p_force: force });
  if(!go) return { skipped: true };

  const bilan = { players: 0, games: 0, adjusts: 0, loot: 0, waiting: [], errors: [] };
  try{
    const [ch, pl, sn, it] = await Promise.all([
      db.from("challenge").select("*").eq("id", 1).single(),
      db.from("players").select("id,name,tag,team,puuid,claimed_by"),
      db.from("rank_snapshots").select("*"),
      db.from("items").select("key,rarity,active").eq("active", true)
    ]);
    const catalogue = it.data || [];
    const winStart = parisMidnight(ch.data.start_date);
    const winEnd = winStart + ch.data.days * 86400000;
    const snapOf = Object.fromEntries((sn.data || []).map(s => [s.player_id, s]));
    const tous = pl.data || [];

    // Profils créés avant le suivi automatique : on retrouve leur compte Riot
    // à partir du pseudo et du tag déjà connus, et on pose un premier relevé.
    for(const p of tous.filter(x => !x.puuid)){
      const parts = splitRiotId(p.name + "#" + p.tag);
      if(!parts){ bilan.errors.push(p.name + " : pseudo ou tag vide, rattachement impossible"); continue; }
      try{
        const acc = await riot(`${REGION}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(parts.gameName)}/${encodeURIComponent(parts.tagLine)}`);
        if(!acc){ bilan.errors.push(p.name + "#" + cleanRiotText(p.tag) + " : compte Riot introuvable, corrige le pseudo dans la console"); continue; }
        const { data: doublon } = await db.from("players").select("id").eq("puuid", acc.puuid).maybeSingle();
        if(doublon){ bilan.errors.push(p.name + " : ce compte Riot est déjà rattaché à un autre profil"); continue; }
        const snap0 = snapshotFromEntries(await riot(`${PLATFORM}/lol/league/v4/entries/by-puuid/${acc.puuid}`));
        await db.from("players").update({ puuid: acc.puuid, name: acc.gameName, tag: acc.tagLine, seed_score: snap0.score }).eq("id", p.id);
        await saveSnap(p.id, snap0, Date.now());
        p.puuid = acc.puuid;
        snapOf[p.id] = { ranked: snap0.ranked, tier: snap0.tier, division: snap0.division, lp: snap0.lp,
                         wins: snap0.wins, losses: snap0.losses, score: snap0.score, checked_at: new Date().toISOString() };
        bilan.linked = (bilan.linked || 0) + 1;
        p.__justLinked = true;
      }catch(e){
        bilan.errors.push(p.name + " : " + (e.message || e));
        if(e instanceof RiotError && (e.status === 429 || e.status === 401 || e.status === 403)) throw e;
      }
    }

    const players = tous.filter(x => x.puuid && !x.__justLinked);
    const byPuuid = Object.fromEntries(tous.filter(x => x.puuid).map(p => [p.puuid, p]));

    for(const p of players){
      bilan.players++;
      try{
        const next = snapshotFromEntries(await riot(`${PLATFORM}/lol/league/v4/entries/by-puuid/${p.puuid}`));
        const prev = snapOf[p.id] ? rowToSnap(snapOf[p.id]) : null;
        const cmp = compareSnapshots(prev, next);
        const now = Date.now();

        if(cmp.type === "adjust"){
          if(now >= winStart && now <= winEnd){
            await db.from("games").insert({
              player_id: p.id, lp: clampLp(cmp.delta), win: false, duo: "solo", stake: 0,
              kind: "adjust", match_id: "adjust-" + now, played_on: parisDate(now),
              created_at: new Date(now).toISOString(), created_by: p.claimed_by
            });
            bilan.adjusts++;
          }
          await saveSnap(p.id, next, now);
          continue;
        }
        if(cmp.type !== "games"){ await saveSnap(p.id, next, now); continue; }

        // Quelles parties ? Match-V5, depuis une heure avant le dernier relevé.
        const since = Math.floor((prev.checkedAt - 3600e3) / 1000);
        const ids = await riot(`${REGION}/lol/match/v5/matches/by-puuid/${p.puuid}/ids?queue=${QUEUE_SOLO}&startTime=${since}&start=0&count=20`) || [];
        const known = ids.length
          ? (await db.from("games").select("match_id").eq("player_id", p.id).in("match_id", ids)).data || []
          : [];
        const deja = new Set(known.map(k => k.match_id));

        const readings = [];
        for(const id of ids.filter(i => !deja.has(i)).slice(0, 8)){
          const r = readMatch(await riot(`${REGION}/lol/match/v5/matches/${id}`), p.puuid, byPuuid, p.team);
          if(r && r.end > prev.checkedAt - 3 * 60e3) readings.push(r);
        }

        let att = attributeGames(readings, cmp.n, cmp.wins);
        if(!att.ok){
          // Match-V5 publie parfois la partie quelques minutes après la mise à jour du rang :
          // on garde l'ancien relevé et on réessaie. Au-delà de 45 min, on tranche.
          if(now - prev.checkedAt < 45 * 60e3){ bilan.waiting.push(p.name + " : " + att.reason); continue; }
          const dispo = readings.filter(r => !r.remake).sort((a, b) => a.end - b.end).slice(-cmp.n);
          if(!dispo.length){
            await saveSnap(p.id, next, now);
            bilan.errors.push(p.name + " : parties introuvables, relevé recalé");
            continue;
          }
          att = { ok: true, games: dispo, forced: true };
        }

        const split = splitLp(cmp.delta, att.games);
        for(let i = 0; i < att.games.length; i++){
          const g = att.games[i];
          if(g.start < winStart || g.start > winEnd) continue;     // hors challenge : ignoré

          const { error } = await db.from("games").insert({
            player_id: p.id, lp: clampLp(split.lps[i]), win: g.win, duo: g.duo, stake: 0,
            partner_id: g.partnerId, match_id: g.matchId, champion: g.champion,
            approx: split.approx || !!att.forced, kind: "game",
            played_on: parisDate(g.end), created_at: new Date(g.end).toISOString(),
            created_by: p.claimed_by
          });
          if(error && !/duplicate/i.test(error.message)) throw error;
          if(!error) bilan.games++;

          // Victoire en duo avec un coéquipier : un objet tombe.
          // L'index unique (player_id, source_match) empêche tout doublon
          // si un relevé repasse sur la même partie.
          if(!error && g.duo === "team" && g.win){
            const objet = tirerObjet(catalogue);
            if(objet){
              const { error: eLoot } = await db.from("player_items")
                .insert({ player_id: p.id, item_key: objet.key, source_match: g.matchId });
              if(!eLoot) bilan.loot++;
            }
          }
        }
        await saveSnap(p.id, next, now);

      }catch(e){
        bilan.errors.push(p.name + " : " + (e.message || e));
        if(e instanceof RiotError && (e.status === 429 || e.status === 401 || e.status === 403)) break;
      }
    }
  } finally {
    await db.rpc("riot_finish_sync", {
      p_error: bilan.errors.length ? bilan.errors.join(" | ").slice(0, 600) : null
    });
  }
  return bilan;
}


/* --------------------------- inscription --------------------------- */
async function register(user, body){
  if(!user) return json({ error: "Connecte-toi d'abord avec Discord." }, 401);
  if(await playerOf(user)) return json({ error: "Tu as déjà un profil joueur." }, 409);

  const riotId = cleanRiotText(body.riotId);
  const parts = splitRiotId(riotId);
  if(!parts) return json({ error: "Indique ton pseudo complet avec le #, par exemple Pseudo#EUW." }, 400);
  const { gameName, tagLine } = parts;

  const acc = await riot(`${REGION}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
  if(!acc) return json({ error: `Aucun compte Riot ne s'appelle « ${riotId} ». Vérifie l'orthographe et le tag.` }, 404);

  const { data: pris } = await db.from("players").select("name").eq("puuid", acc.puuid).maybeSingle();
  if(pris) return json({ error: "Ce compte Riot est déjà inscrit dans le challenge." }, 409);

  const snap = snapshotFromEntries(await riot(`${PLATFORM}/lol/league/v4/entries/by-puuid/${acc.puuid}`));

  const { data: player, error } = await db.rpc("riot_register_player", {
    p_user: user.id, p_name: acc.gameName, p_tag: acc.tagLine, p_puuid: acc.puuid, p_score: snap.score
  });
  if(error) return json({ error: "Inscription impossible : " + error.message }, 400);

  await saveSnap(player.id, snap, Date.now());
  return json({ player, rank: snap });
}


/* ------------------------------ entrée ----------------------------- */
Deno.serve(async (req) => {
  if(req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if(req.method !== "POST") return json({ error: "Méthode POST attendue." }, 405);
  if(!RIOT_KEY) return json({ error: "Secret RIOT_API_KEY absent de la fonction." }, 500);

  let body = {};
  try{ body = await req.json(); }catch(_){}

  try{
    const user = await whoIs(req);
    switch(body.action){
      case "sync":       return json(await sync(!!(body.force && user && await isAdmin(user.id))));
      case "register":   return await register(user, body);
      default:           return json({ error: "Action inconnue." }, 400);
    }
  }catch(e){
    const status = e instanceof RiotError ? (e.status === 429 ? 429 : 502) : 500;
    return json({ error: e.message || String(e) }, status);
  }
});
