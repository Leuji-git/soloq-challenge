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

  // Les joueurs du challenge dans la MÊME équipe LoL que moi = duo.
  // On les regarde TOUS : s'il y a un adversaire parmi eux, c'est lui
  // qui compte, même si un allié vient avant dans la liste de Riot.
  let allie = null, adverse = null;
  for(const p of info.participants){
    if(p.puuid === puuid || p.teamId !== me.teamId) continue;
    const j = byPuuid[p.puuid];
    if(!j) continue;
    if(j.team === myTeam){ if(!allie) allie = j; }
    else if(!adverse) adverse = j;
  }
  const partner = adverse || allie;
  return {
    matchId: match.metadata.matchId,
    start, end,
    win: !!me.win,
    remake: !!me.gameEndedInEarlySurrender,
    champion: me.championName || null,
    partnerId: partner ? partner.id : null,
    duo: !partner ? "solo" : (adverse ? "enemy" : "team"),
    // Lus pour les objets. Absents des vieilles parties : les effets qui
    // s'en servent ne se déclenchent alors pas, ils ne punissent jamais
    // sur une donnée manquante.
    deaths: me.deaths,
    vision: me.visionScore,
    // Les statistiques qui nourrissent l'économie. teamPosition plutôt
    // qu'individualPosition : Riot le recommande, parce qu'il impose un
    // joueur par poste et ne peut donc pas en désigner deux au même.
    role: me.teamPosition || me.individualPosition || null,
    kills: me.kills,
    assists: me.assists,
    dragons: me.dragonKills,
    barons: me.baronKills,
    tourelles: me.turretKills,
    voles: me.objectivesStolen,
    cs: (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0),
    /* Durée EXACTE, en minutes décimales. Surtout pas arrondie : une
       partie de 24 min 40 devenait « 25 min » et perdait le bonus de
       rapidité au moment précis où il était mérité. Le cas s'est
       produit le 4 octobre sur Runailen. */
    dureeMin: (end - start) / 60000
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

/* ---------------------- effets des objets ------------------------
   Un objet se verrouille AVANT une partie, sur soi (bonus) ou sur un
   adversaire (malus), et se consomme sur cette partie-là — que sa
   condition soit remplie ou non. C'est ce qui rend le choix du moment
   intéressant : verrouiller « Pierre de Garde » quand on se sent mal.

   `c.lp` est le LP net rendu par Riot. Chaque effet renvoie ce qu'il
   faut AJOUTER à côté, jamais un LP net modifié : le classement
   général reste sur le net pur, les objets ne touchent que l'affichage
   de la partie.

   Une donnée manquante (vieille partie sans `deaths`) ne doit jamais
   déclencher un malus : toutes les comparaisons échouent vers 0.     */
// « 24 min 40 s » à partir de minutes décimales.
function dureeMatch(min){
  const t = Math.max(0, Math.round((Number(min) || 0) * 60));
  return Math.floor(t / 60) + " min " + String(t % 60).padStart(2, "0") + " s";
}

/* ---------------------- l'or d'une partie ------------------------
   Chaque poste est payé sur ce qu'on lui demande vraiment : le carry
   sur ses duels, le jungler sur les objectifs, le support sur ce qu'il
   crée pour les autres et sur sa vision.

   Les coefficients sont calibrés pour qu'une partie MÉDIANE rapporte
   environ 100 dans chaque rôle — sinon un poste deviendrait la voie
   rapide vers la boutique et tout le monde s'y précipiterait.

   Repères utilisés (partie classée moyenne, ~28 min) :
     carry    6 kills, 6 morts, 7 assists        -> 95
     jungle   5/6/9, 2 drakes, 0,4 nashor        -> 95
     support  2/7/14, 45 de vision               -> 102

   Ce sont des valeurs de DÉPART. Une fois les statistiques accumulées,
   elles se recalibrent sur les vraies parties du challenge : c'est la
   seule façon honnête de les régler.                                */
const OR_ROLES = {
  TOP:     { kill: 20, mort: 10, assist: 5 },
  MIDDLE:  { kill: 20, mort: 10, assist: 5 },
  BOTTOM:  { kill: 20, mort: 10, assist: 5 },
  JUNGLE:  { kill: 12, mort: 10, assist: 4, drake: 20, nashor: 40, vol: 30 },
  UTILITY: { kill: 10, mort: 10, assist: 7, vision: 1.2 }
};
const OR_VICTOIRE = 50;

// Un poste que Riot n'a pas su nommer : barème carry, le plus neutre.
const bareme = role => OR_ROLES[role] || OR_ROLES.MIDDLE;

function orDeLaPartie(s){
  if(!s) return 0;
  const b = bareme(s.role);
  let or = b.kill * (s.kills || 0)
         - b.mort * (s.deaths || 0)
         + b.assist * (s.assists || 0);
  if(b.drake)  or += b.drake  * (s.dragons || 0);
  if(b.nashor) or += b.nashor * (s.barons || 0);
  if(b.vol)    or += b.vol    * (s.voles || 0);
  if(b.vision) or += b.vision * (s.vision || 0);
  if(s.win)    or += OR_VICTOIRE;
  // Une partie catastrophique ne rapporte rien, elle ne coûte pas.
  return Math.max(0, Math.round(or));
}

/* Une clé Riot : RGAPI- suivi d'un UUID. Quarante-deux caractères en
   tout. Sert au diagnostic, jamais à autoriser quoi que ce soit. */
const FORME_CLE = /^RGAPI-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const EFFETS = {
  // ---- bonus, posés sur soi ----
  pierre_garde: c => c.win
    ? { lp: 0, note: "partie gagnée, rien à amortir" }
    : { lp: -c.lp, note: "défaite amortie" },

  bottes_celerite: c => (c.win && c.dureeMin < 25)
    ? { lp: 20, note: "victoire en " + dureeMatch(c.dureeMin) }
    : { lp: 0, note: c.win ? "victoire trop longue (" + dureeMatch(c.dureeMin) + ")" : "partie perdue" },

  larme_deesse: c => ({ lp: 5, note: "quoi qu'il arrive" }),

  elixir_rage: c => c.win
    ? { lp: c.lp, note: "gain doublé" }
    : { lp: 0, note: "partie perdue" },

  ange_gardien: c => c.win
    ? { lp: 0, note: "partie gagnée" }
    : { lp: Math.round(-c.lp / 2), note: "perte réduite de moitié" },

  baron_nashor: c => c.win
    ? { lp: 25, note: "victoire" }
    : { lp: 0, note: "partie perdue" },

  // ---- malus, posés sur un adversaire ----
  marque_chasseur: c => (c.deaths >= 5)
    ? { lp: -20, note: c.deaths + " morts" }
    : { lp: 0, note: c.deaths === undefined ? "morts inconnues" : c.deaths + " morts, sous le seuil" },

  isolement: c => (c.duo !== "solo")
    ? { lp: -15, note: "partie jouée en duo" }
    : { lp: 0, note: "partie jouée en solo" },

  brouillard: c => (c.vision < 15)
    ? { lp: -15, note: "vision " + c.vision }
    : { lp: 0, note: c.vision === undefined ? "vision inconnue" : "vision " + c.vision },

  poids_monde: c => c.win
    ? { lp: -Math.round(c.lp / 2), note: "victoire amputée de moitié" }
    : { lp: 0, note: "partie perdue" },

  peage: c => c.win
    ? { lp: -Math.min(20, Math.max(0, c.lp)), note: "péage prélevé" }
    : { lp: 0, note: "partie perdue" },

  malediction_nexus: c => c.win
    ? { lp: 0, note: "partie gagnée" }
    : { lp: c.lp, note: "perte doublée" },

  amnesie: c => (c.championsJoues || []).indexOf(c.champion) >= 0
    ? { lp: -25, note: (c.champion || "champion") + " déjà joué" }
    : { lp: 0, note: (c.champion || "champion") + " inédit" },

  pile_ou_face: c => c.win
    ? { lp: 30, note: "pile" }
    : { lp: -30, note: "face" },

  // Ces deux-là ne rendent pas de LP : leur travail est ailleurs.
  bourse_coupee: c => c.win
    ? { lp: 0, note: "partie gagnée, la bourse est sauve" }
    : { lp: 0, note: "bourse coupée : " + OR_VOLE + " or" },

  egide_contre: c => c.win
    ? { lp: 0, note: "malus repoussés" }
    : { lp: 0, note: "partie perdue, l'égide n'a rien repoussé" }
};

/* Deux objets sortent du barème en LP.

   « Bourse Coupée » déplace de l'or : sur une défaite de la cible, son
   propriétaire lui en prend. C'est le seul objet qui touche à
   l'économie, et il ne peut pas rendre un solde négatif — credit_gold
   plancher à zéro.

   « Égide du Contre » annule les malus de la partie quand on la gagne.
   Elle ne vaut donc rien si on perd : la poser, c'est parier sur soi. */
const OR_VOLE = 150;
const VOLEURS   = { bourse_coupee: c => !c.win ? OR_VOLE : 0 };
const BOUCLIERS = { egide_contre:  c => !!c.win };

/* Résout les objets verrouillés sur une partie.
   Au plus UN bonus et TROIS malus : le premier verrouillé est le
   premier servi, les autres restent en réserve sans être consommés.
   `armes` : [{ id, itemKey, cible: "soi"|"adversaire", lockedAt }]. */
function resoudreObjets(armes, ctx){
  const tri = (armes || []).slice().sort((a, b) => (a.lockedAt || 0) - (b.lockedAt || 0));
  const gardes = []
    .concat(tri.filter(o => o.cible === "soi").slice(0, 1))
    .concat(tri.filter(o => o.cible === "adversaire").slice(0, 3));

  const appliques = tri.filter(o => gardes.indexOf(o) >= 0).map(o => {
    const f = EFFETS[o.itemKey];
    const r = f ? f(ctx) : { lp: 0, note: "effet inconnu" };
    return { id: o.id, itemKey: o.itemKey, owner: o.owner, cible: o.cible,
             lp: Math.round(r.lp) || 0, note: r.note };
  });

  // Une égide qui tient annule TOUS les malus de la partie, elle-même
  // comprise dans le compte des trois. Elle ne touche pas aux bonus :
  // on se protège des autres, on ne se prive pas de soi.
  const egide = appliques.find(o => BOUCLIERS[o.itemKey] && BOUCLIERS[o.itemKey](ctx));
  if(egide){
    let repousses = 0;
    appliques.forEach(o => {
      if(o.cible === "adversaire" && o !== egide && o.lp !== 0){
        o.lp = 0; o.note = "annulé par l'Égide du Contre"; repousses++;
      }
    });
    egide.note = repousses
      ? repousses + (repousses > 1 ? " malus repoussés" : " malus repoussé")
      : "aucun malus à repousser";
  }

  // Les vols d'or : qui prend, à qui, combien.
  const vols = [];
  appliques.forEach(o => {
    const f = VOLEURS[o.itemKey];
    const montant = f ? f(ctx) : 0;
    if(montant > 0) vols.push({ de: ctx.cibleId, vers: o.owner, or: montant });
  });

  return {
    appliques, vols,
    reportes: tri.filter(o => gardes.indexOf(o) < 0).map(o => o.id),
    total: appliques.reduce((a, o) => a + o.lp, 0)
  };
}

/* Qui a droit à un butin ? Toute victoire, quelle que soit la
   compagnie : solo, duo allié, duo adverse.

   La restriction sur le duo adverse a été levée à la demande des
   joueurs. Elle fermait une entente possible — deux joueurs d'équipes
   opposées qui se donnent rendez-vous en file pour s'alimenter en
   objets — mais elle rendait surtout le duo adverse ingrat. Si l'abus
   apparaît, c'est cette fonction qu'il faut resserrer, et elle seule. */
function peutLooter(duo, win){
  return !!win;
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

/* Secret facultatif. Sans lui, tout marche comme avant : il n'y a
   simplement personne pour prévenir que la clé est morte.
   Discord > réglages du salon > Intégrations > Webhooks. */
const WEBHOOK = Deno.env.get("DISCORD_WEBHOOK") ?? "";
const PORTAIL = "https://developer.riotgames.com/";
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
      /* Diagnostic de la clé. Jamais son contenu : cette réponse est
         publique. On décrit sa forme, et surtout on ne l'accuse d'être
         mal formée que si elle l'est réellement — un message qui dit
         « mal formée » sur une clé impeccable envoie chercher pendant
         une heure du côté des espaces et des guillemets. */
      const defauts = [];
      if(!RIOT_KEY.startsWith("RGAPI-"))        defauts.push("le préfixe RGAPI- manque");
      if(RIOT_KEY !== RIOT_KEY.trim())          defauts.push("il y a un espace ou un retour à la ligne en bord");
      if(/["']/.test(RIOT_KEY))                 defauts.push("la valeur contient des guillemets");
      if(/\s/.test(RIOT_KEY))                   defauts.push("la valeur contient une espace ou un saut de ligne");
      if(/[^\x20-\x7E]/.test(RIOT_KEY))         defauts.push("la valeur contient un caractère invisible ou non latin");
      if(!FORME_CLE.test(RIOT_KEY.trim()) && RIOT_KEY.startsWith("RGAPI-"))
        defauts.push("le corps ne ressemble pas à un identifiant hexadécimal (caractère remplacé au copier-coller ?)");

      const forme = "longueur " + RIOT_KEY.length
        + (defauts.length ? " — " + defauts.join(" ; ") : " — forme conforme");

      throw new RiotError(r.status,
        defauts.length
          ? "Clé API Riot refusée (" + r.status + ") : la valeur du secret est abîmée. Recolle-la sans rien autour. Diagnostic : " + forme + "."
          : "Clé API Riot refusée (" + r.status + ") alors que sa forme est irréprochable (" + forme + "). "
            + "Ce n'est donc pas un problème de copier-coller : la clé est expirée, révoquée, ou vient d'un autre compte. "
            + "Sur developer.riotgames.com, regénère la clé de développement et recolle CELLE QUI EST AFFICHÉE À CET INSTANT — "
            + "en regénérer une nouvelle invalide la précédente sur-le-champ.");
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
/* Consomme les objets verrouillés sur une partie et renvoie les LP
   qu'ils ajoutent. Le LP net de la partie n'est jamais touché : il
   porte le classement général, les objets vivent à côté.

   N'est appelée qu'après l'insertion réussie de la partie : si un
   relevé repasse dessus, l'index unique (player_id, match_id) refuse
   l'insertion et les objets ne sont pas consommés deux fois.          */
async function appliquerObjets(joueur, g, lpNet, parCle){
  // Seuls les objets verrouillés AVANT le début de la partie comptent :
  // sinon on armerait en connaissant déjà le résultat.
  const { data: armes } = await db.from("player_items")
    .select("id,item_key,player_id,locked_at")
    .eq("target_id", joueur.id)
    .is("used_at", null)
    .not("locked_at", "is", null)
    .lt("locked_at", new Date(g.start).toISOString());
  if(!armes || !armes.length) return { lp: 0, detail: [] };

  // Les champions déjà joués pendant le challenge, pour « Amnésie ».
  const { data: passees } = await db.from("games")
    .select("champion").eq("player_id", joueur.id).neq("match_id", g.matchId);

  const r = resoudreObjets(
    armes.map(a => ({
      id: a.id,
      itemKey: a.item_key,
      owner: a.player_id,                 // qui a posé l'objet
      lockedAt: new Date(a.locked_at).getTime(),
      cible: (parCle[a.item_key] || {}).target
    })),
    {
      win: g.win, lp: lpNet, duo: g.duo, champion: g.champion,
      deaths: g.deaths, vision: g.vision, dureeMin: g.dureeMin,
      cibleId: joueur.id,
      championsJoues: (passees || []).map(x => x.champion).filter(Boolean)
    });

  for(const a of r.appliques){
    await db.from("player_items").update({
      used_at: new Date(g.end).toISOString(),
      applied_match: g.matchId, lp_effect: a.lp, note: a.note
    }).eq("id", a.id);
  }

  // Les vols d'or. Deux écritures par vol, chacune tracée dans le
  // journal : on doit pouvoir expliquer à la victime où est passé son or.
  for(const v of (r.vols || [])){
    await db.rpc("credit_gold", { p_player: v.de,   p_amount: -v.or,
      p_raison: "bourse coupée", p_match: g.matchId + "-vol" });
    await db.rpc("credit_gold", { p_player: v.vers, p_amount: v.or,
      p_raison: "bourse coupée sur " + v.de, p_match: g.matchId + "-gain" });
  }

  return { lp: clampLp(r.total), detail: r.appliques, vols: r.vols || [] };
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


/* --------------------------- en direct ----------------------------
   Qui est en train de jouer, d'après Spectator-V5.

   Ce passage coûte un appel Riot PAR JOUEUR : il a donc son propre
   étranglement, à deux minutes, indépendant de celui du relevé. Sans
   ça, un bouton « Actualiser » cliqué en boucle doublerait la facture
   et finirait par faire jeter tout le suivi en 429.

   Une partie dure vingt à quarante minutes : deux minutes de retard à
   l'affichage ne se voient pas. Le compteur, lui, est calculé par le
   site à partir de l'heure de début, donc toujours juste.             */
async function releverEnDirect(joueurs){
  const { data: go } = await db.rpc("riot_try_live");
  if(!go) return 0;

  const enJeu = [];
  for(const p of joueurs){
    if(!p.puuid) continue;
    try{
      // 404 = pas en partie, et riot() le rend comme null.
      const g = await riot(`${PLATFORM}/lol/spectator/v5/active-games/by-summoner/${p.puuid}`);
      if(!g) continue;

      // gameStartTime vaut 0 pendant la sélection des champions : on
      // retombe alors sur maintenant moins la durée annoncée.
      const debut = g.gameStartTime && g.gameStartTime > 0
        ? g.gameStartTime
        : Date.now() - (g.gameLength || 0) * 1000;

      const moi = (g.participants || []).find(x => x.puuid === p.puuid);
      enJeu.push({
        player_id: p.id,
        match_id: g.gameId ? String(g.gameId) : null,
        started_at: new Date(debut).toISOString(),
        champion: moi && moi.championId ? String(moi.championId) : null,
        queue: g.gameQueueConfigId || null,
        seen_at: new Date().toISOString()
      });
    }catch(e){
      // Une clé refusée doit remonter ; le reste ne doit pas priver le
      // relevé des rangs, qui compte bien plus que cet affichage.
      if(e instanceof RiotError && (e.status === 401 || e.status === 403)) throw e;
    }
  }

  const dedans = enJeu.map(x => x.player_id);
  if(enJeu.length) await db.from("live_games").upsert(enJeu, { onConflict: "player_id" });
  // Ceux qui ont fini : on retire leur ligne.
  if(dedans.length) await db.from("live_games").delete().not("player_id", "in", "(" + dedans.map(x => '"' + x + '"').join(",") + ")");
  else await db.from("live_games").delete().neq("player_id", "");

  return enJeu.length;
}


/* --------------------------- alerte clé ---------------------------
   La fonction est le seul endroit qui apprenne la mort de la clé au
   moment où elle arrive : le cron l'appelle toutes les 5 minutes, même
   quand personne n'a le site ouvert. Elle le dit donc au salon.

   Jamais le moindre morceau de la clé dans ce message : il est lu par
   tout le Discord. On ne dit que l'état, pas la valeur.               */
async function alerteCle(enPanne){
  if(!WEBHOOK) return;
  // Rien ici ne doit pouvoir faire échouer un relevé : ni un alerte-cle.sql
  // pas encore lancé, ni un webhook supprimé côté Discord.
  try{
    const { data: quoi } = await db.rpc("riot_claim_key_alert", { p_down: enPanne });
    if(!quoi) return;                  // déjà annoncé, ou fonction SQL absente

    const texte = quoi === "panne"
      ? "⚠️ **Le suivi des LP est à l'arrêt.** La clé de l'API Riot a expiré"
        + " (une clé de développement ne vit que 24 h).\n"
        + "Les parties jouées pendant la panne ne sont pas perdues : elles remonteront"
        + " au premier relevé qui refonctionne, avec un total de LP exact"
        + " (la répartition partie par partie sera marquée « ≈ »).\n"
        + "Pour relancer le suivi : nouvelle clé sur <" + PORTAIL + "> puis remplacement"
        + " du secret `RIOT_API_KEY` dans Supabase."
      : "✅ **Le suivi des LP a repris.** Les parties en attente remontent au prochain relevé.";

    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: texte, allowed_mentions: { parse: [] } })
    });
  }catch(_){}
}


/* ----------------------------- relevé ----------------------------- */
async function sync(force){
  const { data: go } = await db.rpc("riot_try_start_sync", { p_force: force });
  if(!go) return { skipped: true };

  const bilan = { players: 0, games: 0, adjusts: 0, loot: 0, objets: 0, gold: 0, live: 0, waiting: [], errors: [] };
  let cleRefusee = false, lus = 0;
  try{
    const [ch, pl, sn, it, tb] = await Promise.all([
      db.from("challenge").select("*").eq("id", 1).single(),
      db.from("players").select("id,name,tag,team,puuid,claimed_by"),
      db.from("rank_snapshots").select("*"),
      db.from("items").select("key,rarity,target,active"),
      db.from("team_boosts").select("team,until")
    ]);
    // Deux usages distincts : le tirage ne propose que les objets actifs,
    // mais un objet désactivé déjà en main doit encore pouvoir agir.
    const tous_objets = it.data || [];
    const catalogue = tous_objets.filter(i => i.active);
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

    const parCle = Object.fromEntries(tous_objets.map(i => [i.key, i]));
    // Le bonus « double LP » appartient à l'équipe, pas au joueur.
    const boosts = Object.fromEntries(((tb && tb.data) || [])
      .map(b => [b.team, new Date(b.until).getTime()]));
    const players = tous.filter(x => x.puuid && !x.__justLinked);

    // Avant les rangs : si la clé est morte, autant le savoir tout de
    // suite, et cet appel est le moins coûteux des deux.
    try{ bilan.live = await releverEnDirect(players); }
    catch(e){
      bilan.errors.push("en direct : " + (e.message || e));
      if(e instanceof RiotError && (e.status === 401 || e.status === 403)) cleRefusee = true;
    }
    const byPuuid = Object.fromEntries(tous.filter(x => x.puuid).map(p => [p.puuid, p]));

    for(const p of players){
      bilan.players++;
      try{
        const next = snapshotFromEntries(await riot(`${PLATFORM}/lol/league/v4/entries/by-puuid/${p.puuid}`));
        lus++;                                 // Riot a répondu : la clé vit
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
          /* La partie compte si elle se TERMINE pendant le challenge,
             pas si elle est lancée pendant. Les LP sont déduits de
             l'écart entre deux relevés de rang, et le rang bouge à la
             fin de la partie : une partie lancée à 23h58 et finie à
             00h02 a bien fait bouger les LP pendant le challenge.

             Le revers, assumé : une partie lancée avant la fin du
             challenge mais terminée après ne compte pas. La même règle
             des deux côtés, personne ne peut la jouer. */
          if(g.end < winStart || g.end > winEnd) continue;

          // L'or de la partie, calculé avant l'insertion pour être
          // enregistré avec elle : on doit pouvoir relire plus tard
          // pourquoi un joueur a touché ce montant.
          const or = orDeLaPartie({
            role: g.role, win: g.win, kills: g.kills, deaths: g.deaths,
            assists: g.assists, vision: g.vision, dragons: g.dragons,
            barons: g.barons, voles: g.voles
          });

          const { error } = await db.from("games").insert({
            player_id: p.id, lp: clampLp(split.lps[i]), win: g.win, duo: g.duo, stake: 0,
            partner_id: g.partnerId, match_id: g.matchId, champion: g.champion,
            approx: split.approx || !!att.forced, kind: "game",
            role: g.role, kills: g.kills, deaths: g.deaths, assists: g.assists,
            vision: g.vision, dragons: g.dragons, barons: g.barons, cs: g.cs,
            gold_gagne: or,
            played_on: parisDate(g.end), created_at: new Date(g.end).toISOString(),
            created_by: p.claimed_by
          });
          if(error && !/duplicate/i.test(error.message)) throw error;
          if(!error){
            bilan.games++;

            /* Le bonus « double LP » acheté en boutique. Il vaut pour
               TOUTE L'ÉQUIPE de l'acheteur, pas pour lui seul.

               Il ne double que les GAINS, et seulement si la partie
               s'est TERMINÉE dans la fenêtre de deux heures — pas si
               elle a juste commencé dedans, sinon on lancerait une
               partie à 1 h 59 pour la finir sous bonus.

               Le doublement vit dans le total global, jamais dans le
               net : le classement individuel reste ce que Riot a donné. */
            const net = clampLp(split.lps[i]);
            const finBoost = boosts[p.team] || 0;
            let lpBoost = 0;
            if(net > 0 && finBoost && g.end <= finBoost) lpBoost = net;
            // L'index unique (player_id, match_id) du journal d'or rend
            // ce crédit idempotent : un relevé qui repasse ne paie pas
            // deux fois.
            if(or > 0){
              const { error: eOr } = await db.rpc("credit_gold", {
                p_player: p.id, p_amount: or,
                p_raison: "partie " + (g.role || "poste inconnu"), p_match: g.matchId
              });
              if(!eOr) bilan.gold += or;
            }
            const obj = await appliquerObjets(p, g, net, parCle);
            if(obj.detail.length || lpBoost){
              await db.from("games").update({ lp_items: clampLp(obj.lp + lpBoost) })
                .eq("player_id", p.id).eq("match_id", g.matchId);
              bilan.objets += obj.detail.length;
              if(lpBoost) bilan.boost = (bilan.boost || 0) + lpBoost;
            }
          }

          // Victoire en solo ou en duo allié : un objet tombe.
          // L'index unique (player_id, source_match) empêche tout doublon
          // si un relevé repasse sur la même partie.
          if(!error && peutLooter(g.duo, g.win)){
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
        if(e instanceof RiotError && (e.status === 401 || e.status === 403)) cleRefusee = true;
        if(e instanceof RiotError && (e.status === 429 || e.status === 401 || e.status === 403)) break;
      }
    }
  } finally {
    await db.rpc("riot_finish_sync", {
      p_error: bilan.errors.length ? bilan.errors.join(" | ").slice(0, 600) : null
    });
    // Après le verrou : l'alerte ne doit pas retenir le relevé.
    // On n'annonce le retour que si ce relevé a vraiment lu des joueurs,
    // sinon un relevé vide passerait pour une réparation.
    if(cleRefusee)   await alerteCle(true);
    else if(lus)     await alerteCle(false);
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


/* --------------------------- bac à sable --------------------------
   Simule une partie complète : même moteur d'effets que le relèvement
   réel, pour que ce qu'on essaie ici soit exactement ce qui se passera
   en vrai. Tout est marqué « sim- » et s'efface d'un bouton.          */
async function simuler(user, body){
  if(!user || !await isAdmin(user.id)) return json({ error: "Réservé à un administrateur." }, 403);

  const { data: joueur } = await db.from("players")
    .select("id,name,team,claimed_by").eq("id", body.player).maybeSingle();
  if(!joueur) return json({ error: "Joueur inconnu." }, 400);

  const duo = ["solo", "team", "enemy"].indexOf(body.duo) >= 0 ? body.duo : "solo";
  const lp  = clampLp(Number(body.lp) || 0);
  const win = !!body.win;
  const now = Date.now();

  // Le partenaire du duo. En vrai, le relèvement le reconnaît tout seul
  // dans la partie Riot ; ici c'est l'admin qui le désigne.
  let compagnon = null;
  if(duo !== "solo"){
    if(!body.partner) return json({ error: "Choisis le joueur avec qui la partie se joue." }, 400);
    const { data: c } = await db.from("players")
      .select("id,name,team,claimed_by").eq("id", body.partner).maybeSingle();
    if(!c) return json({ error: "Partenaire inconnu." }, 400);
    if(c.id === joueur.id) return json({ error: "Un duo se joue à deux joueurs différents." }, 400);
    if(duo === "team" && c.team !== joueur.team)
      return json({ error: "Un duo allié se joue avec quelqu'un de la même équipe." }, 400);
    if(duo === "enemy" && c.team === joueur.team)
      return json({ error: "Un duo adverse se joue contre quelqu'un de l'autre équipe." }, 400);
    compagnon = c;
  }

  // Une partie plausible : on fait commencer la simulation dans le passé
  // pour que les objets verrouillés à l'instant soient bien pris.
  const dureeMin = Number(body.dureeMin) > 0 ? Number(body.dureeMin) : 28;
  const g = {
    matchId: "sim-" + crypto.randomUUID(),
    start: now - dureeMin * 60000,
    end: now,
    win, duo, dureeMin,
    champion: body.champion || "Simulé",
    deaths: body.deaths === undefined || body.deaths === null ? undefined : Number(body.deaths),
    vision: body.vision === undefined || body.vision === null ? undefined : Number(body.vision),
    partnerId: compagnon ? compagnon.id : null
  };

  const { data: cat } = await db.from("items").select("key,rarity,target,active");
  const tous_objets = cat || [];
  const parCle = Object.fromEntries(tous_objets.map(i => [i.key, i]));

  const { error } = await db.from("games").insert({
    player_id: joueur.id, lp, win, duo, stake: 0,
    partner_id: compagnon ? compagnon.id : null,
    match_id: g.matchId, champion: g.champion, kind: "game",
    played_on: parisDate(g.end), created_at: new Date(g.end).toISOString(),
    created_by: joueur.claimed_by
  });
  if(error) return json({ error: "Insertion refusée : " + error.message }, 400);

  const obj = await appliquerObjets(joueur, g, lp, parCle);
  if(obj.detail.length){
    await db.from("games").update({ lp_items: obj.lp })
      .eq("player_id", joueur.id).eq("match_id", g.matchId);
  }

  // Le butin obéit à la même règle qu'en vrai (peutLooter).
  let butin = null;
  if(peutLooter(duo, win)){
    const tire = tirerObjet(tous_objets.filter(i => i.active));
    if(tire){
      const { error: eL } = await db.from("player_items")
        .insert({ player_id: joueur.id, item_key: tire.key, source_match: g.matchId });
      if(!eL) butin = tire.key;
    }
  }

  /* L'autre côté du duo. Une vraie partie en duo produit DEUX lignes,
     une par joueur, qui se désignent mutuellement : sans ça le
     coéquipier n'a aucune partie et le butin ne tombe que d'un côté.
     Un allié partage le résultat, un adversaire subit l'inverse —
     c'est la même partie Riot vue d'en face. */
  let cote = null;
  if(compagnon){
    const winC = duo === "team" ? win : !win;
    // Par défaut l'allié recopie le résultat et l'adversaire l'inverse,
    // mais deux joueurs d'un même duo gagnent rarement le même nombre de
    // LP : on accepte une valeur explicite pour corriger une vraie partie.
    const lpC = body.lpPartner === undefined || body.lpPartner === null || body.lpPartner === ""
      ? clampLp(duo === "team" ? lp : -lp)
      : clampLp(Number(body.lpPartner) || 0);
    const gC = Object.assign({}, g, { win: winC, partnerId: joueur.id });

    const { error: eC } = await db.from("games").insert({
      player_id: compagnon.id, lp: lpC, win: winC, duo, stake: 0,
      partner_id: joueur.id,
      match_id: g.matchId, champion: g.champion, kind: "game",
      played_on: parisDate(g.end), created_at: new Date(g.end).toISOString(),
      created_by: compagnon.claimed_by
    });

    if(eC){
      cote = { erreur: eC.message };
    }else{
      const objC = await appliquerObjets(compagnon, gC, lpC, parCle);
      if(objC.detail.length){
        await db.from("games").update({ lp_items: objC.lp })
          .eq("player_id", compagnon.id).eq("match_id", g.matchId);
      }
      let butinC = null;
      if(peutLooter(duo, winC)){
        const tire = tirerObjet(tous_objets.filter(i => i.active));
        if(tire){
          const { error: eL2 } = await db.from("player_items")
            .insert({ player_id: compagnon.id, item_key: tire.key, source_match: g.matchId });
          if(!eL2) butinC = tire.key;
        }
      }
      cote = { player: compagnon.id, name: compagnon.name, lp: lpC, win: winC,
               lp_items: objC.lp, objets: objC.detail, butin: butinC };
    }
  }

  return json({
    match_id: g.matchId, lp, lp_items: obj.lp, total: lp + obj.lp,
    objets: obj.detail, butin, partenaire: cote
  });
}


/* --------------------------- recalcul ------------------------------
   Relit une partie chez Riot et réapplique les effets des objets qui
   s'y sont déjà joués.

   Sert quand le calcul était faux au moment du relevé — c'est arrivé :
   la durée était arrondie, et une victoire de 24 min 40 comptait comme
   25 minutes, privant « Bottes de Célérité » de son bonus.

   On ne touche QUE les objets déjà appliqués à cette partie, et on les
   recalcule avec la source de vérité : la réponse de Riot. Rien n'est
   inventé, rien n'est saisi à la main.                                 */
async function recalculer(user, body){
  if(!user || !await isAdmin(user.id)) return json({ error: "Réservé à un administrateur." }, 403);
  if(!body.match_id || !body.player) return json({ error: "Joueur et partie attendus." }, 400);

  const { data: joueur } = await db.from("players")
    .select("id,name,team,puuid").eq("id", body.player).maybeSingle();
  if(!joueur || !joueur.puuid) return json({ error: "Joueur inconnu ou non rattaché à Riot." }, 400);

  const { data: jeu } = await db.from("games").select("*")
    .eq("player_id", joueur.id).eq("match_id", body.match_id).maybeSingle();
  if(!jeu) return json({ error: "Partie introuvable." }, 400);
  if(String(jeu.match_id).startsWith("sim-"))
    return json({ error: "Une partie simulée n'existe pas chez Riot." }, 400);

  const brut = await riot(`${REGION}/lol/match/v5/matches/${jeu.match_id}`);
  if(!brut) return json({ error: "Riot ne connaît pas cette partie." }, 400);

  const { data: tous } = await db.from("players").select("id,team,puuid");
  const byPuuid = Object.fromEntries((tous || []).filter(x => x.puuid).map(p => [p.puuid, p]));
  const g = readMatch(brut, joueur.puuid, byPuuid, joueur.team);
  if(!g) return json({ error: "Partie illisible (file de jeu ou joueur absent)." }, 400);

  const { data: cat } = await db.from("items").select("key,rarity,target,active");
  const parCle = Object.fromEntries((cat || []).map(i => [i.key, i]));

  const { data: poses } = await db.from("player_items")
    .select("id,item_key,lp_effect,note")
    .eq("applied_match", jeu.match_id).eq("target_id", joueur.id);
  if(!poses || !poses.length){
    return json({ error: "Aucun objet ne s'est joué sur cette partie.", duree: g.dureeMin }, 400);
  }

  const { data: passees } = await db.from("games")
    .select("champion").eq("player_id", joueur.id).neq("match_id", jeu.match_id);

  const ctx = {
    win: g.win, lp: jeu.lp, duo: g.duo, champion: g.champion,
    deaths: g.deaths, vision: g.vision, dureeMin: g.dureeMin,
    championsJoues: (passees || []).map(x => x.champion).filter(Boolean)
  };

  let total = 0;
  const detail = [];
  for(const it of poses){
    const f = EFFETS[it.item_key];
    const r = f ? f(ctx) : { lp: 0, note: "effet inconnu" };
    const lp = Math.round(r.lp) || 0;
    total += lp;
    if(lp !== it.lp_effect || r.note !== it.note){
      await db.from("player_items").update({ lp_effect: lp, note: r.note }).eq("id", it.id);
    }
    detail.push({ item: it.item_key, avant: it.lp_effect, apres: lp, note: r.note,
                  change: lp !== it.lp_effect });
  }

  const lpItems = clampLp(total);
  if(lpItems !== jeu.lp_items){
    await db.from("games").update({ lp_items: lpItems })
      .eq("player_id", joueur.id).eq("match_id", jeu.match_id);
  }

  return json({
    joueur: joueur.name, match_id: jeu.match_id,
    duree_minutes: Math.round(g.dureeMin * 100) / 100,
    duree: dureeMatch(g.dureeMin),
    lp_net: jeu.lp,
    lp_items_avant: jeu.lp_items, lp_items_apres: lpItems,
    objets: detail
  });
}


/* ------------------------------ entrée ----------------------------- */
Deno.serve(async (req) => {
  if(req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if(req.method !== "POST") return json({ error: "Méthode POST attendue." }, 405);
  if(!RIOT_KEY){
    await alerteCle(true);
    return json({ error: "Secret RIOT_API_KEY absent de la fonction." }, 500);
  }

  let body = {};
  try{ body = await req.json(); }catch(_){}

  try{
    const user = await whoIs(req);
    switch(body.action){
      case "sync":       return json(await sync(!!(body.force && user && await isAdmin(user.id))));
      case "register":   return await register(user, body);
      case "sim":        return await simuler(user, body);
      case "recompute":  return await recalculer(user, body);
      default:           return json({ error: "Action inconnue." }, 400);
    }
  }catch(e){
    const status = e instanceof RiotError ? (e.status === 429 ? 429 : 502) : 500;
    return json({ error: e.message || String(e) }, status);
  }
});
