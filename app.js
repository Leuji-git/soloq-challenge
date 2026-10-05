// Version flottante v2 volontaire : les nouvelles clés API Supabase
// (sb_publishable_…) exigent une version récente du client.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

/* ===================================================================
   Constantes de rang
   Barème : palier x 400 + division x 100 + LP
=================================================================== */
const TIERS = [
  { k:"IRON",        fr:"Fer",          ab:"F",  c:"#7A7A7A" },
  { k:"BRONZE",      fr:"Bronze",       ab:"B",  c:"#A9743F" },
  { k:"SILVER",      fr:"Argent",       ab:"A",  c:"#9CA8B4" },
  { k:"GOLD",        fr:"Or",           ab:"O",  c:"#D4AF37" },
  { k:"PLATINUM",    fr:"Platine",      ab:"P",  c:"#4FC0AC" },
  { k:"EMERALD",     fr:"Émeraude",     ab:"E",  c:"#3EAE6C" },
  { k:"DIAMOND",     fr:"Diamant",      ab:"D",  c:"#77A9F5" },
  { k:"MASTER",      fr:"Maître",       ab:"M",  c:"#B072DA" },
  { k:"GRANDMASTER", fr:"Grand Maître", ab:"GM", c:"#DB5F5F" },
  { k:"CHALLENGER",  fr:"Challenger",   ab:"C",  c:"#E3C874" }
];
const TIDX = {}; TIERS.forEach((t,i)=>TIDX[t.k]=i);
const ROMAN = { 1:"I", 2:"II", 3:"III", 4:"IV" };
const APEX = 7;
const TEAM_COLOR = { a:"var(--team-a)", b:"var(--team-b)" };

/* La pièce d'or, dans le parti pris du logo du Discord : trait épais,
   formes franches, et une lueur dorée posée en CSS plutôt que dans le
   dessin — un filtre SVG ne suivrait pas la couleur du contexte.

   Un seul disque plutôt qu'une pile : à seize pixels, deux formes qui
   se chevauchent deviennent une tache. L'anneau intérieur et
   l'étincelle suffisent à dire « monnaie ». */
const PIECE_OR =
  '<svg class="coin" viewBox="0 0 24 24" aria-hidden="true" focusable="false"'
  + ' fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">'
  + '<circle cx="10.6" cy="13.6" r="7.9" stroke-width="2.2"/>'
  + '<circle cx="10.6" cy="13.6" r="3.7" stroke-width="1.6" opacity=".72"/>'
  // Un eclat plutot qu'une croix : a cote d'un montant, un « + » se
  // lirait comme un signe et non comme un reflet.
  + '<path d="M19.4 2.2c.2 1.5 1 2.3 2.5 2.5c-1.5.2-2.3 1-2.5 2.5'
  +   'c-.2-1.5-1-2.3-2.5-2.5c1.5-.2 2.3-1 2.5-2.5z"'
  +   ' fill="currentColor" stroke="none"/>'
  + '</svg>';

const toScore = (t,d,lp) => {
  const i = TIDX[t];
  if(i === undefined) return 0;
  return i >= APEX ? 2800 + lp : i*400 + (4-d)*100 + lp;
};
function fromScore(s){
  s = Math.max(0, Math.round(s));
  if(s >= 2800) return { t:"MASTER", d:1, lp:s-2800 };
  const i = Math.floor(s/400), rest = s - i*400;
  return { t:TIERS[i].k, d:4 - Math.floor(rest/100), lp:rest%100 };
}
const rankLabel = r => r.unranked ? "Non classé" : TIDX[r.t] >= APEX
  ? TIERS[TIDX[r.t]].fr + " " + r.lp + " LP"
  : TIERS[TIDX[r.t]].fr + " " + ROMAN[r.d] + " · " + r.lp + " LP";
const shortRank = r => TIDX[r.t] >= APEX ? TIERS[TIDX[r.t]].fr : TIERS[TIDX[r.t]].fr + " " + ROMAN[r.d];

// Écussons de rang officiels servis par Community Dragon.
// Ce jeu-ci est en 500x500 cadré sur l'écusson et couvre les 10 paliers,
// Émeraude compris — contrairement à `ranked-emblem` (visuel 2560x1440,
// illisible en petit) et à `ranked-mini-crests` (Émeraude manquant).
const emblem = t => "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-shared-components/global/default/" + t.toLowerCase() + ".png";
// Un pseudo copié depuis Discord traîne souvent des caractères de contrôle
// bidirectionnels invisibles (U+2066–U+2069…) : encodés dans l'URL, ils
// cassaient le lien dpm.lol (ex. « LEUJI-OIOIO%E2%81%A9 »).
const cleanRiot = v => String(v ?? "").replace(/[​-‏‪-‮⁠-⁩﻿]/g, "").trim();
const dpmUrl = p => "https://dpm.lol/" + encodeURIComponent(cleanRiot(p.name)) + "-" + encodeURIComponent(cleanRiot(p.tag));

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const signed = n => (n>0 ? "+" : n<0 ? "−" : "±") + Math.abs(n);
const deltaHtml = n => '<span class="delta '+(n>0?"up":n<0?"down":"flat")+'">'+signed(n)+'</span>';
const iso = d => d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");

/* ===================================================================
   État
=================================================================== */
const S = {
  ledger: [],       // journal des mouvements d'or
  live: {},         // id joueur -> partie en cours chez Riot
  boosts: {},       // équipe -> bonus « double LP » en cours
  boxes: [],        // coffres lootés, ouverts ou non
  challenge: null,
  players: [],
  games: [],
  snaps: {},        // id joueur -> dernier rang relevé chez Riot
  sync: null,       // état du relevé automatique
  profiles: {},     // id du compte -> { display_name, avatar_url, is_admin }
  items: [],        // catalogue des objets
  inventory: [],    // exemplaires possédés, tous joueurs confondus
  session: null,
  profile: null,
  ready: false
};
let claimDismissed = false;
let period = "all";
let chartMode = "players";
/* « net » : les LP rendus par Riot, ceux du classement.
   « total » : les mêmes, objets compris — ce que le joueur a ressenti. */
let chartLp = "net";
const lpDe = g => chartLp === "total" ? g.lp + (g.lp_items || 0) : g.lp;
// Tracer les places au classement plutôt que les LP. N'a de sens qu'en
// mode joueurs : une équipe n'a pas de rang parmi dix.
let chartRank = false;
// Le bloc « Suivi » montre soit les parties, soit la réserve d'objets.
let suiviVue = "hist";
let hidden = new Set();

const myPlayer = () => S.session ? S.players.find(p => p.claimed_by === S.session.user.id) || null : null;
const isAdmin  = () => !!(S.profile && S.profile.is_admin);

/* ===================================================================
   Supabase
=================================================================== */
let sb = null;
function fatal(html){
  $("#errTxt").innerHTML = html;
  $("#errBox").hidden = false;
}
if(!SUPABASE_URL || SUPABASE_URL.includes("xxxxxxxx") || SUPABASE_ANON_KEY.includes("colle-ici")){
  fatal("<b>Configuration incomplète</b><br>Ouvre <code>config.js</code> et colle l'URL de ton projet Supabase ainsi que la clé <code>anon public</code> (Supabase &gt; Settings &gt; API).");
  $("#whoBox").innerHTML = '<span class="lbl">Hors ligne — la base n\'est pas encore branchée</span>';
} else {
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/* ===================================================================
   Chargement des données
=================================================================== */
async function loadAll(){
  if(!sb) return;
  const [ch, pl, gm, sn, pr, bt, st, pi, gl, lv, tb, bx] = await Promise.all([
    sb.from("challenge").select("*").eq("id",1).maybeSingle(),
    sb.from("players").select("*").order("sort"),
    sb.from("games").select("*").order("created_at"),
    sb.from("rank_snapshots").select("*"),
    sb.from("profiles").select("id, display_name, avatar_url, is_admin"),
    sb.from("items").select("*").eq("active", true).order("sort"),
    sb.from("sync_state").select("*").eq("id",1).maybeSingle(),
    sb.from("player_items").select("*").order("obtained_at"),
    sb.from("gold_ledger").select("*").order("at", { ascending:false }).limit(60),
    sb.from("live_games").select("*"),
    sb.from("team_boosts").select("*"),
    sb.from("player_boxes").select("*")
  ]);
  const err = ch.error || pl.error || gm.error || sn.error || pr.error || bt.error || st.error || pi.error;
  if(err){
    fatal("<b>Base injoignable</b><br>" + esc(err.message) + "<br>Vérifie que <code>supabase/riot-api.sql</code> a bien été exécuté dans le SQL Editor.");
    return;
  }
  S.challenge = ch.data || { name:"SoloQ Challenge", start_date:iso(new Date()), days:21, team_a_name:"Équipe A", team_b_name:"Équipe B" };
  // Nettoyés dès le chargement : liens, affichage et infobulles en profitent tous.
  S.players = (pl.data || []).map(p => Object.assign({}, p, { name: cleanRiot(p.name), tag: cleanRiot(p.tag) }));
  S.games   = gm.data || [];
  S.snaps    = Object.fromEntries((sn.data||[]).map(r => [r.player_id, r]));
  S.sync     = st.data || null;
  S.profiles = Object.fromEntries((pr.data||[]).map(r => [r.id, r]));
  S.profile  = S.session ? (S.profiles[S.session.user.id] || null) : null;
  S.items     = bt.data || [];
  S.inventory = pi.data || [];
  // economie.sql n'est peut-être pas encore lancé : son absence ne doit
  // pas empêcher le reste du site de s'afficher.
  S.ledger    = gl.error ? [] : (gl.data || []);
  // en-direct.sql n'est peut-être pas encore lancé : le site doit
  // simplement ne rien afficher dans ce cas.
  S.live      = lv.error ? {} : Object.fromEntries((lv.data || []).map(r => [r.player_id, r]));
  S.boosts    = tb.error ? {} : Object.fromEntries((tb.data || []).map(r => [r.team, r]));
  S.boxes     = bx.error ? [] : (bx.data || []);
  S.ready = true;
  $("#errBox").hidden = true;
  render();
}

function subscribeRealtime(){
  if(!sb) return;
  sb.channel("board")
    .on("postgres_changes", { event:"*", schema:"public", table:"games" },      loadAll)
    .on("postgres_changes", { event:"*", schema:"public", table:"players" },    loadAll)
    .on("postgres_changes", { event:"*", schema:"public", table:"rank_snapshots" }, loadAll)
    .on("postgres_changes", { event:"*", schema:"public", table:"sync_state" },  loadAll)
    .on("postgres_changes", { event:"*", schema:"public", table:"challenge" },  loadAll)
    .on("postgres_changes", { event:"*", schema:"public", table:"player_items" }, loadAll)
    .subscribe(status => { $("#livePill").hidden = status !== "SUBSCRIBED"; });
}

/* ===================================================================
   Calculs
=================================================================== */
function startDate(){ return new Date(S.challenge.start_date + "T00:00:00"); }
function dayOf(dateStr){
  const d = new Date(dateStr + "T00:00:00");
  return Math.max(0, Math.round((d - startDate()) / 86400000));
}
function currentDay(){ return Math.floor((new Date() - startDate()) / 86400000); }
function windowStart(){
  return period === "week" ? Math.max(0, Math.min(currentDay(), S.challenge.days) - 6) : 0;
}

function gamesOf(id){ return S.games.filter(g => g.player_id === id); }

function stateFor(p){
  const all = gamesOf(p.id);
  const from = windowStart();
  const games = all.filter(g => dayOf(g.played_on) >= from);
  // Le net compte tout, esquives comprises ; victoires et défaites ne
  // comptent que les vraies parties.
  const net = games.reduce((a,g) => a + g.lp, 0);
  // Le même total, objets compris : celui qui nourrit le score d'équipe.
  // Le classement individuel, lui, reste sur `net`.
  const global = games.reduce((a,g) => a + lpGlobal(g), 0);
  const played = games.filter(g => g.kind !== "adjust");
  const w = played.filter(g => g.win).length;
  const byDay = {};
  games.forEach(g => { const d = dayOf(g.played_on); byDay[d] = (byDay[d]||0) + g.lp; });
  let best = null;
  Object.keys(byDay).forEach(k => { if(!best || byDay[k] > best.lp) best = { day:+k, lp:byDay[k] }; });
  return { player:p, all, games: played, net, global, w, l: played.length - w, best };
}
const allStates = () => S.players.map(stateFor);

/* Winrate global d'un joueur, et winrate du visiteur EN DUO avec lui.
   On ne compte que mes propres déclarations : un duo produit deux
   lignes (une par joueur), il ne faut pas compter la partie deux fois. */
function winrate(games){
  if(!games.length) return null;
  const w = games.filter(g => g.win).length;
  return { n: games.length, w, pct: Math.round(w / games.length * 100) };
}
function duoWinrate(meId, otherId){
  if(!meId || meId === otherId) return null;
  return winrate(S.games.filter(g => g.player_id === meId && g.partner_id === otherId));
}

// Le challenge est-il ouvert ? (jour 0 inclus)
const started = () => new Date() >= startDate();

/* ------------------------------------------------------------------
   Score d'équipe : la somme des LP nets de ses membres.
------------------------------------------------------------------ */
/* ------------------------------------------------------------------
   Les deux lectures du score — ne jamais les mélanger

   * Le classement INDIVIDUEL se fait au LP net : ce que Riot a vraiment
     donné. Un joueur ne monte ni ne descend à cause d'un objet, et
     personne ne peut faire chuter quelqu'un d'autre au tableau.
   * Le duel d'ÉQUIPES se fait au LP global, objets compris. C'est là
     que les objets pèsent : on sabote l'autre camp, pas une personne.

   D'où cette fonction, et le fait que `stateFor` continue d'employer
   `g.lp` tout seul.
------------------------------------------------------------------- */
const lpGlobal = g => g.lp + (g.lp_items || 0);

/* ------------------------------------------------------------------
   L'objectif journalier
   Chaque jour, une équipe qui engrange OBJECTIF_JOUR LP décroche
   PRIME_OBJECTIF LP de plus. Seuls les gains comptent : une défaite ne
   recule pas le compteur du jour. C'est voulu — l'objectif récompense
   ce qu'on va chercher, pas ce qu'on évite de perdre. Le classement
   général, lui, reste au LP net : la prime s'ajoute au total d'équipe,
   jamais au compte d'un joueur.
------------------------------------------------------------------- */
const OBJECTIF_JOUR = 150;
const PRIME_OBJECTIF = 80;

// LP gagnés par une équipe un jour donné (défaites ignorées).
// En LP globaux, comme le score d'équipe : une victoire annulée par un
// malus ne doit pas faire avancer l'objectif.
function lpGagnesJour(team, jour){
  let n = 0;
  S.games.forEach(g => {
    const v = lpGlobal(g);
    if(v <= 0) return;
    if(dayOf(g.played_on) !== jour) return;
    const p = S.players.find(x => x.id === g.player_id);
    if(p && p.team === team) n += v;
  });
  return n;
}

// Les journées déjà gagnées, dans la fenêtre affichée.
function primeObjectif(team){
  const from = windowStart();
  const jusqua = Math.min(currentDay(), S.challenge.days - 1);
  let jours = 0;
  for(let j = Math.max(from, 0); j <= jusqua; j++){
    if(lpGagnesJour(team, j) >= OBJECTIF_JOUR) jours++;
  }
  return { jours, lp: jours * PRIME_OBJECTIF };
}

function teamScores(){
  const from = windowStart();
  const out = { a:0, b:0 };
  S.games.forEach(g => {
    if(dayOf(g.played_on) < from) return;
    const p = S.players.find(x => x.id === g.player_id);
    if(!p) return;
    out[p.team] += lpGlobal(g);
  });
  out.a += primeObjectif("a").lp;
  out.b += primeObjectif("b").lp;
  return out;
}

// Le rang affiché est le vrai rang, relevé chez Riot.
function estRank(p){
  const s = S.snaps[p.id];
  if(s && s.ranked && s.tier) return { t: s.tier, d: s.division || 1, lp: s.lp };
  if(s && !s.ranked) return { t: "IRON", d: 4, lp: 0, unranked: true };
  return fromScore(Math.max(0, p.seed_score || 0));
}

/* ===================================================================
   Rendu
=================================================================== */
function crest(r, opts){
  opts = opts || {};
  return '<span class="crest'+(opts.sm ? " sm" : "")+'" title="'+rankLabel(r)+'">'
    + '<img src="'+emblem(r.t)+'" alt="'+esc(TIERS[TIDX[r.t]].fr)+'" loading="lazy" decoding="async">'
    + (opts.label ? '<span class="rk">'+esc(opts.label)+'</span>' : '')
    + '</span>';
}

// Avatar Discord du compte qui a réclamé ce profil joueur.
function avatarOf(p){
  const prof = p.claimed_by ? S.profiles[p.claimed_by] : null;
  return prof && prof.avatar_url ? prof.avatar_url : null;
}
function avatarHtml(p){
  const url = avatarOf(p);
  const prof = p.claimed_by ? S.profiles[p.claimed_by] : null;
  const who = prof && prof.display_name ? prof.display_name : "";
  return url
    ? '<img class="av" src="'+esc(url)+'" alt="" loading="lazy" decoding="async"'
      + (who ? ' title="Connecté : '+esc(who)+'"' : '') + '>'
    : '<span class="av ph" title="Profil non réclamé" aria-hidden="true"></span>';
}

// Pseudo et tag sur une seule ligne, cliquables vers le profil dpm.lol.
function nameLink(p){
  return '<a class="pn" href="'+dpmUrl(p)+'" target="_blank" rel="noopener noreferrer"'
    + ' title="Ouvrir le profil de '+esc(p.name)+'#'+esc(p.tag)+' sur dpm.lol">'
    + esc(p.name) + '<span class="tg">#'+esc(p.tag)+'</span></a>';
}

function renderHeader(){
  const c = S.challenge;
  const parts = c.name.split(/\s+(?:contre|vs|VS)\s+/);
  $("#hTitle").innerHTML = parts.length === 2
    ? esc(parts[0]) + ' <span class="vs">CONTRE</span> ' + esc(parts[1])
    : esc(c.name);
  document.title = c.name + " — SoloQ Challenge";
  $("#hDays").textContent = c.days;

  const s = startDate(), e = new Date(s.getTime() + c.days*86400000);
  const f = d => d.toLocaleDateString("fr-FR", { day:"numeric", month:"long" });
  $("#daterange").textContent = "Du " + f(s) + " au " + f(e) + " " + e.getFullYear();

  const di = currentDay();
  const lbl = $("#clocklbl"), big = $("#clockbig"), bar = $("#clockbar");
  const setBig = txt => { big.firstChild.nodeValue = txt; };
  if(di < 0){ lbl.textContent = "Début dans"; setBig((-di) + " j"); bar.style.width = "0%"; }
  else if(di >= c.days){ lbl.textContent = "Terminé"; setBig("J+" + (di - c.days)); bar.style.width = "100%"; }
  else { lbl.textContent = "Jour"; setBig(di + " / " + c.days); bar.style.width = Math.round(di/c.days*100) + "%"; }

  $("#tnA").textContent = c.team_a_name;
  $("#tnB").textContent = c.team_b_name;
}

function renderCountdown(){ tickCountdown(); }

/* « 2 j 04:17:09 » : les jours en clair, le reste en horloge. On ne
   montre les jours que s'il y en a, et les heures que si la journée
   compte — sinon on lit « 0 j 00:00:42 » pour quarante secondes. */
function dureeTexte(ms){
  if(ms < 0) ms = 0;
  const t = Math.floor(ms / 1000);
  const j = Math.floor(t / 86400), h = Math.floor(t / 3600) % 24;
  const m = Math.floor(t / 60) % 60, sec = t % 60;
  const d2 = n => String(n).padStart(2, "0");
  if(j) return j + " j " + d2(h) + ":" + d2(m) + ":" + d2(sec);
  if(h) return d2(h) + ":" + d2(m) + ":" + d2(sec);
  return d2(m) + ":" + d2(sec);
}

/* Avant le jour J, le compte à rebours jusqu'au départ ; pendant le
   challenge, celui qui reste à courir. Dans les deux cas à la seconde,
   parce que c'est ce qu'on regarde quand on attend. */
function tickCountdown(){
  if(!S.challenge) return;
  const small = $("#clocksmall"), big = $("#clockbig");
  const debut = startDate().getTime();
  const fin = debut + S.challenge.days * 86400000;
  const now = Date.now();

  if(now < debut){
    big.firstChild.nodeValue = Math.floor((debut - now) / 86400000) + " j";
    small.textContent = dureeTexte(debut - now).replace(/^\d+ j /, "");
    return;
  }
  if(now >= fin){ small.textContent = ""; return; }
  // Pendant le challenge, le gros chiffre reste « Jour 3 / 21 » : c'est
  // renderHeader qui le pose. Ici on n'ajoute que le temps restant.
  small.textContent = dureeTexte(fin - now);
}

function renderBalance(states){
  const ts = teamScores();
  const a = ts.a, b = ts.b;
  $("#scoreA").innerHTML = signed(a) + '<span class="u"> LP</span>';
  $("#scoreB").innerHTML = signed(b) + '<span class="u"> LP</span>';
  const diff = a - b, scale = Math.max(400, Math.abs(diff)*1.25);
  const pct = 50 + (diff/scale)*45;
  $("#pivot").style.left = pct + "%";
  $("#fillA").style.left = "0%";  $("#fillA").style.width = pct + "%";
  $("#fillB").style.left = pct+"%"; $("#fillB").style.width = (100-pct) + "%";
  const lead = diff === 0
    ? "Égalité parfaite"
    : "<b>" + esc(diff>0 ? S.challenge.team_a_name : S.challenge.team_b_name) + "</b> mène de <b>" + Math.abs(diff) + " LP</b>";
  $("#leadTxt").innerHTML = lead;

  renderObjectif("a"); renderObjectif("b");
  renderBoost("a");     renderBoost("b");
}

/* Le bonus de doublement, annoncé sous le nom de l'équipe. Les deux
   camps le voient : savoir que l'autre double est une information de
   jeu, pas un secret. */
function renderBoost(team){
  const box = $("#boost" + team.toUpperCase());
  if(!box) return;
  const fin = boostEquipe(team);
  box.hidden = !fin;
  if(fin) box.innerHTML = '\u26A1 Double LP \u00b7 encore <b>' + resteBoost(fin) + '</b>';
}

/* La jauge du jour, sous le nom de l'équipe. */
function renderObjectif(team){
  const box = $("#obj" + team.toUpperCase());
  if(!box) return;
  const jour = Math.min(Math.max(currentDay(), 0), S.challenge.days - 1);
  const fait = lpGagnesJour(team, jour);
  const atteint = fait >= OBJECTIF_JOUR;
  const pct = Math.min(100, Math.round(fait / OBJECTIF_JOUR * 100));
  const prime = primeObjectif(team);

  box.innerHTML =
      '<div class="objbar"><i class="' + team + (atteint ? " done" : "")
        + '" style="width:' + pct + '%"></i></div>'
    + '<div class="objtxt' + (atteint ? " done" : "") + '">'
      + (atteint
          ? "Objectif du jour atteint · +" + PRIME_OBJECTIF + " LP"
          : fait + " / " + OBJECTIF_JOUR + " LP aujourd'hui")
      + (prime.jours
          ? '<span class="objsum">' + prime.jours + (prime.jours > 1 ? " jours" : " jour")
            + " · +" + prime.lp + " LP</span>"
          : "")
    + '</div>';
  box.title = "Seuls les LP gagnés comptent : une défaite ne fait pas reculer le compteur du jour.";
}

function renderRosters(states){
  const mine = myPlayer();
  $("#rosters").innerHTML = ["a","b"].map(tk => {
    const tname = tk === "a" ? S.challenge.team_a_name : S.challenge.team_b_name;
    // Ces listes servent le duel d'équipes : elles se lisent donc en LP
    // globaux, objets compris, et se trient dessus. Le tableau du
    // classement plus bas reste au LP net — ce sont deux lectures
    // différentes, et c'est voulu.
    const ms = states.filter(s => s.player.team === tk)
      .sort((x,y) => y.global - x.global || y.net - x.net);
    const total = teamScores()[tk];
    const played = ms.reduce((acc,s) => acc + s.games.length, 0);
    return '<div class="roster '+tk+'">'
      + '<header><span class="tname '+tk+'">'+esc(tname)+'</span>'
        + '<span class="lbl" title="Score d\'équipe : LP globaux, objets et primes compris. Les lignes ci-dessous sont en LP nets, ceux du classement individuel.">'
        + played+' parties · '+signed(total)+' LP globaux</span></header>'
      + '<ul>' + (ms.length ? ms.map(s => {
          const r = estRank(s.player);
          const or = s.player.gold || 0;
          return '<li'+(mine && mine.id === s.player.id ? ' class="me"' : '')+'>'
            + avatarRing(s.player, { sm:true }) + crest(r)
            + '<div style="min-width:0">' + nameLink(s.player)
            + '<div class="psub">'+esc(rankLabel(r))+(s.player.claimed_by ? "" : " · profil libre")+'</div></div>'
            + '<div class="pright">'
              + '<span class="pmain">' + deltaHtml(s.global) + '<span class="u">LP</span>'
                + '<span class="sep">·</span>'
                + '<span class="purseline" title="Or gagné en jouant">' + PIECE_OR
                + '<b>' + orFr(or) + '</b></span></span>'
              + '<span class="plp"><b title="LP nets : ceux du classement individuel">'
              + signed(s.net) + ' net</b> LP · ' + s.w + 'V ' + s.l + 'D</span>'
            + '</div>'
            + pastilleLive(s.player.id) + '</li>';
        }).join("") : '<li><span class="empty">Aucun joueur dans cette équipe.</span></li>')
      + '</ul></div>';
  }).join("");
}

function sparkGames(games){
  const last = games.slice(-10);
  if(!last.length) return '<span class="wr">—</span>';
  const max = Math.max(20, ...last.map(g => Math.abs(g.lp)));
  const bw = 8, gap = 3, h = 26, mid = h/2, w = last.length*(bw+gap);
  const bars = last.map((g,i) => {
    const hh = Math.max(2, Math.abs(g.lp)/max*(mid-2));
    return '<rect x="'+(i*(bw+gap))+'" y="'+(g.lp>=0 ? mid-hh : mid).toFixed(1)+'" width="'+bw+'" height="'+hh.toFixed(1)
      + '" fill="'+(g.lp>=0 ? "var(--up)" : "var(--down)")+'"><title>'+signed(g.lp)+' LP · '+g.played_on+'</title></rect>';
  }).join("");
  return '<svg viewBox="0 0 '+w+' '+h+'" width="'+w+'" height="'+h+'">'
    + '<line x1="0" y1="'+mid+'" x2="'+w+'" y2="'+mid+'" stroke="var(--line)" stroke-width="1"/>' + bars + '</svg>';
}

/* Winrate global du joueur, et juste à côté, en plus petit,
   celui que le visiteur affiche en duo avec lui. */
function wrCell(st, mine){
  const n = st.games.length;
  const global = n ? Math.round(st.w / n * 100) + "%" : "—";
  const d = (mine && mine.id !== st.player.id) ? duoWinrate(mine.id, st.player.id) : null;

  const sub = [];
  if(n) sub.push(st.w + "V " + st.l + "D");
  if(d) sub.push(d.n + " ensemble");

  // La photo du visiteur à côté de « % avec toi » : on voit tout de
  // suite de qui on parle, sans relire la phrase.
  return '<span class="wl num bigwr">' + global + '</span>'
       + (d ? '<span class="duowr">' + avatarRing(mine, { sm:true })
              + d.pct + '% avec toi</span>' : '')
       + '<div class="wr">' + (sub.join(" · ") || "aucune partie") + '</div>';
}

function renderLadder(states){
  const mine = myPlayer();
  const sorted = states.slice().sort((a,b) => b.net - a.net || b.games.length - a.games.length);
  if(!sorted.length){ $("#ladder").innerHTML = '<tr><td colspan="9" class="empty">Aucun joueur enregistré.</td></tr>'; return; }
  $("#ladder").innerHTML = sorted.map((s,i) => {
    const n = s.games.length;
    const avg = n ? Math.round(s.net/n*10)/10 : null;
    const r = estRank(s.player);
    const cls = [i===0 ? "lead1" : "", mine && mine.id === s.player.id ? "me" : ""].filter(Boolean).join(" ");
    const tname = s.player.team === "a" ? S.challenge.team_a_name : S.challenge.team_b_name;
    return '<tr data-team="'+s.player.team+'"'+(cls ? ' class="'+cls+'"' : '')+'>'
      + '<td class="pos num">'+(i+1)+'</td>'
      + '<td class="avc">'+avatarHtml(s.player)+'</td>'
      + '<td><div class="who2">'+nameLink(s.player)+'<span class="psub">'+esc(tname)+'</span></div></td>'
      + '<td class="r">'+deltaHtml(s.net)+'</td>'
      + '<td class="r">'+wrCell(s, mine)+'</td>'
      + '<td class="r"><span class="wl num">'+(avg===null ? "—" : signed(avg))+'</span></td>'
      + '<td class="r"><span class="wl num">'+(s.best ? signed(s.best.lp) : "—")+'</span><div class="wr">'+(s.best ? "J"+s.best.day : "")+'</div></td>'
      + '<td>'+sparkGames(s.games)+'</td>'
      + '<td>'+crest(r, { sm:true, label:shortRank(r)+" · "+r.lp+" LP" })+'</td></tr>';
  }).join("");
}

/* ===================================================================
   Progression — axe temporel continu, zoomable jusqu'à 5 minutes.
   Chaque partie est un palier daté : on ne moyenne rien, on montre
   le vrai instant où les LP ont bougé.
=================================================================== */
const MIN_SPAN = 5 * 60000;          // on ne zoome pas plus fin que 5 min
const PAS = [5*60e3, 15*60e3, 30*60e3, 3600e3, 3*3600e3, 6*3600e3, 12*3600e3, 864e5, 2*864e5, 7*864e5];
let view = null;                     // { t0, t1 } en millisecondes

const tsOf = g => new Date(g.created_at).getTime();

/* Bornes maximales de l'axe.
   On englobe le départ du challenge ET les parties réellement
   déclarées : sinon, tant que le challenge n'a pas commencé (ou si un
   admin corrige une partie hors fenêtre), la vue s'ouvrirait sur une
   plage vide. */
function fullSpan(){
  const ts = S.games.map(tsOf).filter(Number.isFinite);
  const debut = startDate().getTime();
  const t0 = ts.length ? Math.min(debut, Math.min.apply(null, ts)) : debut;
  const t1 = Math.max(
    Date.now(),
    ts.length ? Math.max.apply(null, ts) : 0,
    t0 + 3600e3
  );
  return { t0, t1 };
}
function clampView(v){
  const f = fullSpan();
  let span = Math.max(MIN_SPAN, Math.min(v.t1 - v.t0, f.t1 - f.t0));
  let t0 = Math.max(f.t0, Math.min(v.t0, f.t1 - span));
  return { t0, t1: t0 + span };
}

// Paliers cumulés d'un joueur : [{t, y}]
function playerPoints(id){
  const gs = gamesOf(id).slice().sort((a,b) => tsOf(a) - tsOf(b));
  let run = 0;
  return gs.map(g => ({ t: tsOf(g), y: (run += lpDe(g)) }));
}
/* Le rang LoL dans le temps : Fer, Bronze, … Challenger.

   On ne peut pas le lire directement — Riot ne donne que le rang
   d'aujourd'hui. On part donc du rang actuel et on remonte le fil des
   LP relevés : score au départ = score actuel moins tout ce qui a été
   gagné depuis. Puis on redescend le fil en avant.

   La reconstitution vaut ce que vaut le relevé : si une partie classée
   a échappé au suivi, la courbe est décalée d'autant avant elle. Les
   esquives et la décroissance sont enregistrées en « ajustement », donc
   comptées elles aussi.

   Le score est absolu : 400 points par palier, 100 par division. C'est
   la même échelle que le classement du tableau, d'où la lecture directe
   des frontières de palier sur l'axe. */
function scorePoints(id){
  const p = S.players.find(x => x.id === id);
  if(!p) return [];
  const r = estRank(p);
  const actuel = toScore(r.t, r.d, r.lp);

  const gs = gamesOf(id).slice().sort((a, b) => tsOf(a) - tsOf(b));
  const total = gs.reduce((a, g) => a + g.lp, 0);
  let run = Math.max(0, actuel - total);

  // Un palier au départ du challenge, sinon la courbe commencerait à
  // la première partie et on ne verrait pas d'où le joueur vient.
  const pts = [{ t: startDate().getTime(), y: run }];
  gs.forEach(g => { run = Math.max(0, run + g.lp); pts.push({ t: tsOf(g), y: run }); });
  return pts;
}

/* Paliers cumulés d'une équipe, primes journalières comprises.

   La prime de +80 LP ne tombe pas à minuit : elle tombe à l'instant
   précis où l'équipe franchit les 150 LP du jour. On l'ajoute donc sur
   la partie qui fait passer le seuil — la courbe montre un saut net,
   au bon moment, et son point d'arrivée correspond au score affiché
   dans la balance.

   Uniquement en LP globaux : l'objectif se compte en globaux, et la
   lecture « LP nets » doit rester du pur LP Riot, sans rien d'ajouté. */
function teamPoints(tk){
  const primeAuPassage = chartLp === "total";
  const evts = [];
  S.games.forEach(g => {
    const p = S.players.find(x => x.id === g.player_id);
    const d = lpDe(g);
    if(!p || p.team !== tk || !d) return;
    evts.push({ t: tsOf(g), d, jour: dayOf(g.played_on), gain: Math.max(0, lpGlobal(g)) });
  });
  evts.sort((a,b) => a.t - b.t);

  let run = 0;
  const duJour = {}, acquise = {};
  return evts.map(e => {
    run += e.d;
    if(primeAuPassage && !acquise[e.jour]){
      duJour[e.jour] = (duJour[e.jour] || 0) + e.gain;
      if(duJour[e.jour] >= OBJECTIF_JOUR){
        acquise[e.jour] = true;
        run += PRIME_OBJECTIF;
      }
    }
    return { t: e.t, y: run };
  });
}

// Valeur au temps t0, puis tracé en escalier jusqu'à t1.
function valueAt(pts, t){
  let y = 0;
  for(const p of pts){ if(p.t > t) break; y = p.y; }
  return y;
}
/* Courbe arrondie, en cubiques monotones (Fritsch–Carlson).
   Pourquoi monotone et pas une spline ordinaire : une spline libre
   dépasse les points qu'elle relie, et on verrait la courbe grimper
   au-dessus d'un sommet de LP qui n'a jamais existé. Ici, entre deux
   paliers, elle ne sort jamais de leur intervalle. */
function coursePath(pts, X, Y, t0, t1){
  // Les points visibles, encadrés par la valeur aux deux bornes.
  const dedans = pts.filter(p => p.t > t0 && p.t < t1);
  const P = [{ t: t0, y: valueAt(pts, t0) }]
    .concat(dedans)
    .concat([{ t: t1, y: valueAt(pts, t1) }]);
  const n = P.length;
  if(n < 2) return "";

  const xs = P.map(p => X(p.t)), ys = P.map(p => Y(p.y));

  // Pentes des segments, puis tangentes bridées pour rester monotone.
  const dx = [], dy = [], m = [];
  for(let i = 0; i < n - 1; i++){
    dx.push(xs[i+1] - xs[i]);
    dy.push(ys[i+1] - ys[i]);
    m.push(dx[i] === 0 ? 0 : dy[i] / dx[i]);
  }
  const tg = new Array(n);
  tg[0] = m[0]; tg[n-1] = m[n-2];
  for(let i = 1; i < n - 1; i++){
    tg[i] = (m[i-1] * m[i] <= 0) ? 0 : (m[i-1] + m[i]) / 2;
  }
  for(let i = 0; i < n - 1; i++){
    if(m[i] === 0){ tg[i] = 0; tg[i+1] = 0; continue; }
    const a = tg[i] / m[i], b = tg[i+1] / m[i];
    const h = Math.hypot(a, b);
    if(h > 3){ tg[i] = 3 * a / h * m[i]; tg[i+1] = 3 * b / h * m[i]; }
  }

  let d = "M " + xs[0].toFixed(1) + " " + ys[0].toFixed(1);
  for(let i = 0; i < n - 1; i++){
    const h = dx[i] / 3;
    d += " C " + (xs[i] + h).toFixed(1) + " " + (ys[i] + tg[i] * h).toFixed(1)
       + " "   + (xs[i+1] - h).toFixed(1) + " " + (ys[i+1] - tg[i+1] * h).toFixed(1)
       + " "   + xs[i+1].toFixed(1) + " " + ys[i+1].toFixed(1);
  }
  return d;
}

function stepPath(pts, X, Y, t0, t1){
  let y = valueAt(pts, t0);
  let d = "M " + X(t0).toFixed(1) + " " + Y(y).toFixed(1);
  pts.filter(p => p.t > t0 && p.t <= t1).forEach(p => {
    d += " L " + X(p.t).toFixed(1) + " " + Y(y).toFixed(1);
    y = p.y;
    d += " L " + X(p.t).toFixed(1) + " " + Y(y).toFixed(1);
  });
  d += " L " + X(t1).toFixed(1) + " " + Y(y).toFixed(1);
  return d;
}

function pickStep(span){ const cible = span / 7; return PAS.find(v => v >= cible) || PAS[PAS.length-1]; }
function axisTicks(t0, t1, pas){
  const out = [];
  const base = new Date(t0); base.setHours(0,0,0,0);
  let t = base.getTime();
  while(t < t0) t += pas;
  for(; t <= t1; t += pas) out.push(t);
  return out;
}
function tickLabel(t, pas){
  const d = new Date(t);
  if(pas >= 864e5) return d.toLocaleDateString("fr-FR", { day:"numeric", month:"short" });
  if(pas >= 3600e3) return d.getHours() + "h";
  return d.toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit" });
}
function spanLabel(span){
  const h = span / 3600e3;
  if(h < 1)  return Math.round(span/60e3) + " min";
  if(h < 48) return Math.round(h) + " h";
  return Math.round(h/24) + " jours";
}

function renderChart(){
  const W = 920, H = 360, PL = 58, PR = 20, PT = 20, PB = 40;
  if(!view) view = fullSpan();
  view = clampView(view);
  const { t0, t1 } = view;

  // Le mode rang ne vaut qu'en joueurs : la case est masquée ailleurs,
  // mais on ne s'y fie pas, on revérifie ici.
  // Le rang ne se trace qu'en joueurs ET en LP nets : un rang calculé
  // sur des LP d'objets ne correspondrait à rien chez Riot.
  const rang = chartRank && chartMode === "players" && chartLp === "net";

  const series = chartMode === "players"
    ? S.players.map(p => ({ key:p.id, label:p.name, color:TEAM_COLOR[p.team],
                            pts: rang ? scorePoints(p.id) : playerPoints(p.id) }))
    : ["a","b"].map(tk => ({
        key: tk,
        label: tk === "a" ? S.challenge.team_a_name : S.challenge.team_b_name,
        color: TEAM_COLOR[tk],
        pts: teamPoints(tk)
      }));

  const vis = series.filter(s => !hidden.has(s.key));

  // L'axe vertical se recalcule sur ce qui est visible : c'est ce qui
  // donne du relief quand on zoome sur une soirée.
  let lo, hi, Y;
  const X = t => PL + ((t - t0) / (t1 - t0)) * (W - PL - PR);

  if(rang){
    // Bornes calées sur les divisions : l'axe tombe toujours juste.
    const ys = [];
    vis.forEach(sr => {
      ys.push(valueAt(sr.pts, t0));
      sr.pts.filter(p => p.t > t0 && p.t <= t1).forEach(p => ys.push(p.y));
    });
    if(!ys.length) ys.push(0, 400);
    lo = Math.floor((Math.min(...ys) - 60) / 100) * 100;
    hi = Math.ceil((Math.max(...ys) + 60) / 100) * 100;
    lo = Math.max(0, lo);
    if(hi - lo < 300) hi = lo + 300;
    Y = v => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
  }else{
    const ys = [0];
    vis.forEach(s => {
      ys.push(valueAt(s.pts, t0));
      s.pts.filter(p => p.t > t0 && p.t <= t1).forEach(p => ys.push(p.y));
    });
    lo = Math.min(...ys); hi = Math.max(...ys);
    const amp = hi - lo;
    const pad = Math.max(20, amp * 0.18);
    const grain = amp > 400 ? 50 : amp > 120 ? 20 : 10;
    lo = Math.floor((lo - pad) / grain) * grain;
    hi = Math.ceil((hi + pad) / grain) * grain;
    if(hi === lo) hi = lo + grain * 4;
    Y = v => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
  }

  let out = "";
  if(rang){
    // Un trait par division, franc aux frontières de palier. Les noms
    // ne sont écrits qu'aux paliers quand la plage est large, sinon ils
    // se chevaucheraient.
    const serre = (hi - lo) <= 900;
    for(let v = lo; v <= hi; v += 100){
      const y = Y(v);
      const frontiere = v % 400 === 0;
      const r = fromScore(v);
      const couleur = frontiere ? TIERS[TIDX[r.t]].c : "var(--line-soft)";
      out += '<line x1="'+PL+'" y1="'+y.toFixed(1)+'" x2="'+(W-PR)+'" y2="'+y.toFixed(1)
          +  '" stroke="'+couleur+'" stroke-width="1" opacity="'+(frontiere ? ".42" : ".2")+'"/>';
      if(frontiere || serre){
        out += '<text x="'+(PL-10)+'" y="'+(y+4).toFixed(1)+'" text-anchor="end" fill="'
            +  (frontiere ? TIERS[TIDX[r.t]].c : "var(--muted)")
            +  '" font-family="Barlow Semi Condensed" font-size="'+(frontiere ? 12 : 11)+'">'
            +  esc(frontiere ? TIERS[TIDX[r.t]].fr : shortRank(r)) + '</text>';
      }
    }
  }else{
    const grain = (hi - lo) > 400 ? 50 : (hi - lo) > 120 ? 20 : 10;
    const vStep = Math.max(grain, Math.ceil((hi - lo) / 6 / grain) * grain);
    for(let v = Math.ceil(lo / vStep) * vStep; v <= hi; v += vStep){
      const y = Y(v);
      out += '<line x1="'+PL+'" y1="'+y.toFixed(1)+'" x2="'+(W-PR)+'" y2="'+y.toFixed(1)+'" stroke="var(--line-soft)" stroke-width="1" opacity=".6"/>'
          +  '<text x="'+(PL-10)+'" y="'+(y+4).toFixed(1)+'" text-anchor="end" fill="var(--muted)" font-family="Barlow Semi Condensed" font-size="12">'+(v>0?"+":"")+v+'</text>';
    }
    out += '<line x1="'+PL+'" y1="'+Y(0).toFixed(1)+'" x2="'+(W-PR)+'" y2="'+Y(0).toFixed(1)+'" stroke="var(--line)" stroke-width="1.5"/>';
  }

  const pas = pickStep(t1 - t0);
  axisTicks(t0, t1, pas).forEach(t => {
    const x = X(t);
    out += '<line x1="'+x.toFixed(1)+'" y1="'+PT+'" x2="'+x.toFixed(1)+'" y2="'+(H-PB)+'" stroke="var(--line-soft)" stroke-width="1" opacity=".5"/>'
        +  '<text x="'+x.toFixed(1)+'" y="'+(H-20)+'" text-anchor="middle" fill="var(--muted)" font-family="Barlow Semi Condensed" font-size="12">'+esc(tickLabel(t, pas))+'</text>';
  });

  const jour = new Date(t0).toLocaleDateString("fr-FR", { day:"numeric", month:"long" });
  out += '<text x="'+PL+'" y="'+(H-4)+'" text-anchor="start" fill="var(--muted)" font-family="Barlow Semi Condensed" font-size="11" letter-spacing="1.2">'
       + (rang ? 'RANG CHEZ RIOT · '
               : chartLp === "total"
                   ? (chartMode === "teams" ? 'LP CUMULÉS, OBJETS ET PRIMES COMPRIS · '
                                            : 'LP CUMULÉS, OBJETS COMPRIS · ')
                   : 'LP NETS CUMULÉS · ')
       + esc(jour.toUpperCase()) + '</text>';

  /* Pas d'aire sous les courbes.

     Elle avait l'air d'une bonne idée, mais ici les séries traversent
     le zéro : l'aire d'une équipe en négatif se referme SUR la ligne du
     zéro et forme une dalle opaque qui recouvre l'autre courbe. Aucun
     réglage d'opacité n'y change rien — c'est la forme même du
     remplissage qui ne convient pas à des valeurs signées.

     Des lignes nettes, un zéro bien marqué et la valeur en bout de
     course se lisent mieux. */
  vis.forEach((s, i) => {
    const d = coursePath(s.pts, X, Y, t0, t1);
    out += '<path id="serie'+i+'" d="'+d+'" fill="none" stroke="'+s.color
        +  '" stroke-width="'+(chartMode === "players" ? 1.9 : 2.6)+'"'
        +  ' stroke-linejoin="round" stroke-linecap="round"'
        +  ' opacity="'+(chartMode==="players" ? 0.92 : 1)+'"/>';

    // Un point par partie, tant qu'ils ne se marchent pas dessus.
    const dedans = s.pts.filter(p => p.t >= t0 && p.t <= t1);
    if(dedans.length <= 40){
      dedans.forEach(p => {
        out += '<circle cx="'+X(p.t).toFixed(1)+'" cy="'+Y(p.y).toFixed(1)
            +  '" r="2.6" fill="var(--surface)" stroke="'+s.color+'" stroke-width="1.6"/>';
      });
    }

    // Le dernier état, en bout de ligne : la valeur qu'on vient chercher.
    // Le tracé se termine exactement sur ce point, les deux coïncident.
    const xFin = X(t1), yFin = Y(valueAt(s.pts, t1));
    out += '<circle cx="'+xFin.toFixed(1)+'" cy="'+yFin.toFixed(1)+'" r="8" fill="'+s.color+'" opacity=".16"/>'
        +  '<circle cx="'+xFin.toFixed(1)+'" cy="'+yFin.toFixed(1)+'" r="4.2" fill="'+s.color+'"/>';
  });

  // Le repere de survol vit dans le SVG : il doit donc etre reecrit a
  // chaque rendu, sinon innerHTML l'emporterait.
  out += '<line id="chartGuide" stroke="var(--muted)" stroke-width="1"'
      +  ' stroke-dasharray="3 3" opacity=".7" style="display:none"/>'
      +  '<g id="chartDots"></g>';
  $("#chart").innerHTML = out;
  $("#zoomLabel").textContent = spanLabel(t1 - t0);

  // De quoi répondre au survol sans tout recalculer à chaque pixel.
  chartSurvol = { X, Y, t0, t1, vis, PL, PR, W, H, PT, PB, rang };

  $("#legend").innerHTML = series.map(s =>
    '<button type="button" data-key="'+esc(s.key)+'" aria-pressed="'+(hidden.has(s.key)?"false":"true")+'"><i style="background:'+s.color+'"></i>'+esc(s.label)+'</button>'
  ).join("");
  $("#legend").querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.key;
    hidden.has(k) ? hidden.delete(k) : hidden.add(k);
    renderChart();
  }));
}

/* ---------- zoom et déplacement ---------- */
/* État du dernier tracé, relu au survol. */
let chartSurvol = null;

/* Ordonnée du tracé à une abscisse donnée, lue sur le chemin lui-même.

   Pourquoi ne pas réutiliser valueAt : il rend la valeur en escalier,
   celle qui a vraiment cours à cet instant. La courbe, elle, est lissée
   et passe ailleurs entre deux parties. Poser la pastille sur valueAt
   la décollait donc du trait. Le nombre affiché reste valueAt — c'est
   le vrai total de LP ; seule la pastille suit ce qui est dessiné. */
function ySurTrace(path, x){
  if(!path || !path.getTotalLength) return null;
  const L = path.getTotalLength();
  if(!L) return null;
  let a = 0, b = L;
  // Le tracé va de gauche à droite : une dichotomie suffit.
  for(let k = 0; k < 24; k++){
    const m = (a + b) / 2;
    if(path.getPointAtLength(m).x < x) a = m; else b = m;
  }
  return path.getPointAtLength((a + b) / 2).y;
}

/* Au survol : un repère vertical, un point par courbe, et les valeurs
   sous le curseur. On lit les mêmes séries que celles dessinées, donc
   l'infobulle ne peut pas annoncer autre chose que la courbe. */
function majSurvol(clientX, clientY){
  const c = chartSurvol, bulle = $("#chartTip"), guide = $("#chartGuide");
  if(!c || !bulle) return;
  const box = $("#chart").getBoundingClientRect();
  const t = chartTimeAt(clientX);

  const x = c.X(t);
  guide.setAttribute("x1", x.toFixed(1)); guide.setAttribute("x2", x.toFixed(1));
  guide.setAttribute("y1", c.PT); guide.setAttribute("y2", c.H - c.PB);
  guide.style.display = "";

  // L'ordonnée du curseur dans le repère du SVG, pour savoir quelle
  // courbe on vise.
  const yCurseur = ((clientY - box.top) / box.height) * c.H;

  const lignes = c.vis.map((s, i) => {
    const y = valueAt(s.pts, t);
    // La pastille se pose sur le trait ; si le chemin n'est pas encore
    // mesurable, on retombe sur l'escalier plutôt que de ne rien montrer.
    const yTrace = ySurTrace($("#serie" + i), x);
    const cy = yTrace === null ? c.Y(y) : yTrace;
    return { label: s.label, color: s.color, y, cy, ecart: Math.abs(cy - yCurseur) };
  });

  // La courbe la plus proche du curseur. Avec dix joueurs, lister tout
  // le monde donne une infobulle de trois cents pixels qu'on ne lit
  // pas : on répond à la question posée, celle du trait qu'on vise.
  const plusProche = lignes.reduce((m, l) => (!m || l.ecart < m.ecart) ? l : m, null);
  const toutMontrer = lignes.length <= 3;
  const retenues = toutMontrer ? lignes.slice().sort((a, b) => b.y - a.y) : [plusProche];

  // La pastille visée est plus grosse, les autres s'effacent.
  $("#chartDots").innerHTML = lignes.map(l => {
    const vise = l === plusProche;
    return '<circle cx="' + x.toFixed(1) + '" cy="' + l.cy.toFixed(1)
      + '" r="' + (vise ? 5 : 3) + '" fill="' + l.color + '"'
      + ' stroke="var(--surface)" stroke-width="2"'
      + (vise || toutMontrer ? '' : ' opacity=".45"') + '/>';
  }).join("");

  bulle.innerHTML = '<div class="tiptime">'
      + new Date(t).toLocaleString("fr-FR", { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" })
      + '</div>'
    + retenues.map(l => {
        if(!c.rang){
          return '<div class="tipline"><i style="background:' + l.color + '"></i>'
            + '<span>' + esc(l.label) + '</span><b>' + signed(l.y) + '</b></div>';
        }
        // En rang : l'écusson du palier, puis « Or III » et les LP.
        // Les dimensions sont aussi posées sur la balise : sans elles,
        // une feuille de style en cache afficherait l'image en taille
        // réelle, c'est-à-dire énorme.
        const r = fromScore(l.y);
        return '<div class="tipline rank"><img src="' + esc(emblem(r.t))
          + '" alt="" width="22" height="22" decoding="async">'
          + '<span>' + esc(l.label) + '</span>'
          + '<b>' + esc(shortRank(r)) + '<em>' + r.lp + ' LP</em></b></div>';
      }).join("");

  // L'infobulle suit la souris, et bascule à gauche près du bord droit.
  const dx = clientX - box.left, dy = clientY - box.top;
  const aGauche = dx > box.width - 190;
  bulle.style.left = (aGauche ? dx - 14 : dx + 14) + "px";
  bulle.style.top  = Math.max(4, dy - 12) + "px";
  bulle.style.transform = aGauche ? "translateX(-100%)" : "";
  bulle.hidden = false;
}

function cacherSurvol(){
  const bulle = $("#chartTip"), guide = $("#chartGuide");
  if(bulle) bulle.hidden = true;
  if(guide) guide.style.display = "none";
  const dots = $("#chartDots");
  if(dots) dots.innerHTML = "";
}

function chartTimeAt(clientX){
  const box = $("#chart").getBoundingClientRect();
  const PL = 58, PR = 20, W = 920;
  const x = ((clientX - box.left) / box.width) * W;
  const r = Math.max(0, Math.min(1, (x - PL) / (W - PL - PR)));
  return view.t0 + r * (view.t1 - view.t0);
}
function initChartZoom(){
  const svg = $("#chart");

  svg.addEventListener("mousemove", e => majSurvol(e.clientX, e.clientY));
  svg.addEventListener("mouseleave", cacherSurvol);
  // Au doigt, on suit aussi : c'est le seul moyen de lire une valeur
  // précise sur téléphone.
  svg.addEventListener("touchmove", e => {
    if(e.touches[0]) majSurvol(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  svg.addEventListener("touchend", cacherSurvol);

  svg.addEventListener("wheel", e => {
    if(!view) return;
    e.preventDefault();
    const anchor = chartTimeAt(e.clientX);
    const facteur = e.deltaY > 0 ? 1.3 : 1/1.3;
    const span = (view.t1 - view.t0) * facteur;
    const r = (anchor - view.t0) / (view.t1 - view.t0);
    view = clampView({ t0: anchor - r * span, t1: anchor + (1-r) * span });
    renderChart();
  }, { passive:false });

  let drag = null;
  svg.addEventListener("pointerdown", e => {
    if(!view) return;
    drag = { x:e.clientX, t0:view.t0, t1:view.t1 };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add("grabbing");
  });
  svg.addEventListener("pointermove", e => {
    if(!drag) return;
    const box = svg.getBoundingClientRect();
    const dt = ((e.clientX - drag.x) / box.width) * (drag.t1 - drag.t0) * (920 / (920 - 78));
    view = clampView({ t0: drag.t0 - dt, t1: drag.t1 - dt });
    renderChart();
  });
  const stop = () => { drag = null; svg.classList.remove("grabbing"); };
  svg.addEventListener("pointerup", stop);
  svg.addEventListener("pointercancel", stop);
  svg.addEventListener("dblclick", () => { view = fullSpan(); renderChart(); });
  $("#zoomReset").addEventListener("click", () => { view = fullSpan(); renderChart(); });
}

/* ------------------- compte, réclamation, saisie ------------------- */
function renderAccount(){
  const box = $("#whoBox");
  if(!S.session){
    box.innerHTML = '<span class="lbl">Consultation libre — connecte-toi pour rejoindre le challenge</span>';
    $("#btnLogin").hidden = false;
    $("#btnLogout").hidden = true;
    $("#lnkAdmin").hidden = true;
    return;
  }
  $("#btnLogin").hidden = true;
  $("#btnLogout").hidden = false;
  const mine = myPlayer();
  const name = (S.profile && S.profile.display_name) || S.session.user.email || "Connecté";
  const av = S.profile && S.profile.avatar_url ? '<img class="av" src="'+esc(S.profile.avatar_url)+'" alt="">' : "";
  let pills = "";
  if(mine){
    const tname = mine.team === "a" ? S.challenge.team_a_name : S.challenge.team_b_name;
    pills += '<span class="pill '+mine.team+'">'+esc(mine.name)+' · '+esc(tname)+'</span>';
  }
  if(isAdmin()) pills += '<span class="pill admin">Admin</span>';
  box.innerHTML = av + '<span class="name">'+esc(name)+'</span>' + pills;
  $("#lnkAdmin").hidden = !isAdmin();
}

function renderClaim(){
  const dlg = $("#claimDialog");
  const needed = !!S.session && !myPlayer();
  $("#btnClaim").hidden = !needed;
  // On ne ferme jamais la fenêtre pendant que la roulette tourne.
  if(!needed){ if(dlg.open && $("#wheelStep").hidden) dlg.close(); return; }
  if(!dlg.open && !claimDismissed) dlg.showModal();
}

/* Appel de la fonction serveur « riot ». Les erreurs métier arrivent
   dans le corps de la réponse : on les remonte telles quelles. */
async function callRiot(action, payload){
  const { data, error } = await sb.functions.invoke("riot", { body: Object.assign({ action }, payload || {}) });
  if(error){
    let msg = error.message;
    try{ const b = await error.context.json(); if(b && b.error) msg = b.error; }catch(_){}
    throw new Error(msg);
  }
  if(data && data.error) throw new Error(data.error);
  return data;
}

/* ---------- inscription : le compte est vérifié chez Riot ---------- */
async function register(){
  const riotId = $("#regId").value.trim();
  const cut = riotId.lastIndexOf("#");
  if(cut < 1 || cut === riotId.length - 1){
    return say("#claimLog", "Indique ton pseudo complet avec le #, par exemple Pseudo#EUW.", true);
  }
  $("#regGo").disabled = true;
  say("#claimLog", "Vérification de ton compte chez Riot…");
  try{
    const res = await callRiot("register", { riotId });
    say("#claimLog", "");
    spinWheel(res.player.team, res.rank);   // avant le rechargement : la fenêtre reste ouverte
    await loadAll();
  }catch(e){
    say("#claimLog", e.message, true);
  }finally{
    $("#regGo").disabled = false;
  }
}

/* ---------- roulette : elle révèle, elle ne décide pas ---------- */
function spinWheel(team, rank){
  $("#regStep").hidden = true;
  $("#wheelStep").hidden = false;

  const strip = $("#wheelStrip");
  const CELLS = 44;
  const names = { a: S.challenge.team_a_name, b: S.challenge.team_b_name };
  let html = "";
  for(let i = 0; i < CELLS; i++){
    const k = (i % 2 === 0) ? "a" : "b";
    html += '<div class="wcell ' + k + '">' + esc(names[k]) + '</div>';
  }
  strip.innerHTML = html;
  strip.style.transition = "none";
  strip.style.transform = "translateX(0px)";

  let target = CELLS - 6;
  while(((target % 2 === 0) ? "a" : "b") !== team) target--;

  requestAnimationFrame(() => {
    const cell = strip.querySelector(".wcell");
    const cw = cell.getBoundingClientRect().width;
    const gap = parseFloat(getComputedStyle(strip).gap) || 0;
    const mask = strip.parentElement.getBoundingClientRect().width;
    const jitter = (Math.random() - 0.5) * cw * 0.5;
    const x = target * (cw + gap) - (mask / 2 - cw / 2) + jitter;
    strip.style.transition = "transform 4.2s cubic-bezier(.12,.72,.12,1)";
    strip.style.transform = "translateX(" + (-x) + "px)";
  });

  const rangTxt = rank && rank.ranked
    ? rankLabel({ t: rank.tier, d: rank.division, lp: rank.lp })
    : "pas encore classé en Solo/Duo";
  setTimeout(() => {
    const res = $("#wheelResult");
    res.hidden = false;
    res.className = "wheelresult " + team;
    res.innerHTML = "Tu rejoins <b>" + esc(names[team]) + "</b>"
      + '<span class="wheelrank">Rang relevé chez Riot : ' + esc(rangTxt) + '</span>';
    $("#wheelTitle").textContent = "Ton équipe";
    $("#wheelDone").hidden = false;
  }, 4400);
}

function targetPlayer(){
  // Ouvert à tout le monde : voir la progression des autres fait partie
  // du jeu, et toutes ces données sont déjà publiques.
  const choisi = $("#fPlayer") && $("#fPlayer").value;
  if(choisi) return S.players.find(p => p.id === choisi) || myPlayer();
  return myPlayer();
}

/* ---------- état du relevé automatique ---------- */
function renderSyncStatus(){
  const st = S.sync, pill = $("#syncPill");
  if(!st || !st.last_ok){
    pill.className = "syncpill wait";
    pill.textContent = st && st.last_error ? "Relevé en échec" : "Relevé pas encore lancé";
    pill.title = st && st.last_error ? st.last_error : "";
    return;
  }
  const min = Math.floor((Date.now() - new Date(st.last_ok).getTime()) / 60000);
  const etat = st.last_error ? "err" : (min > 12 ? "wait" : "ok");
  pill.className = "syncpill " + etat;
  pill.textContent = st.last_error ? "Relevé perturbé"
    : (min < 1 ? "Relevé à l'instant" : "Relevé il y a " + min + " min");
  pill.title = st.last_error || "Les parties apparaissent quelques minutes après leur fin.";
}

/* ------------------------------------------------------------------
   Les objets. Tant qu'on n'en a jamais obtenu un, on ne lit que sa
   description mystérieuse. Une fois découvert, l'effet reste visible.
------------------------------------------------------------------ */
const RARETES = { commun:"Commun", rare:"Rare", legendaire:"Légendaire" };

/* Mêmes poids que le tirage de la fonction « riot » (POIDS_RARETE).
   Si tu les changes là-bas, change-les ici : le site ne fait qu'afficher
   la probabilité, c'est le serveur qui tire. */
const POIDS_RARETE = { commun:60, rare:30, legendaire:10 };

// Chance qu'un butin donné tombe sur cet objet précis.
function tauxDrop(it, items){
  const poids = x => POIDS_RARETE[x.rarity] || 1;
  const total = items.reduce((a, x) => a + poids(x), 0);
  return total ? poids(it) / total * 100 : 0;
}
const formatTaux = p => (p < 10 ? p.toFixed(1).replace(".", ",") : String(Math.round(p))) + " %";

function renderItems(){
  const grille = $("#itemGrid");
  const mine = myPlayer();
  if(!S.items.length){
    $("#itemsCount").textContent = "—";
    $("#itemsHint").textContent = "Le catalogue n'est pas encore en place.";
    grille.innerHTML = '<div class="empty">Aucun objet configuré.</div>';
    return;
  }

  // Découvert = obtenu au moins une fois, même déjà utilisé.
  const aMoi = mine ? S.inventory.filter(r => r.player_id === mine.id) : [];
  const decouverts = new Set(aMoi.map(r => r.item_key));
  const enStock = {};
  aMoi.filter(r => !r.used_at).forEach(r => { enStock[r.item_key] = (enStock[r.item_key] || 0) + 1; });

  // En admin, tout est révélé : c'est la vue de travail pour relire
  // les visuels et les effets.
  const admin = isAdmin();
  const total = aMoi.filter(r => !r.used_at).length;
  $("#itemsCount").textContent = mine
    ? decouverts.size + " / " + S.items.length + " découverts"
    : S.items.length + " objets";
  $("#itemsHint").textContent = admin
    ? "Vue administrateur : tous les objets sont révélés, les joueurs ne voient que ceux qu'ils ont obtenus. Le pourcentage est la chance de tomber sur cet objet à chaque butin."
    : mine
      ? "Un objet tombe à chaque victoire, quelle que soit la compagnie. Tant que tu n'en as jamais obtenu un, tu n'en connais que la rumeur."
        + (total ? " Tu en as " + total + " en réserve." : "")
      : "Connecte-toi pour voir ceux que tu as découverts. Un objet tombe à chaque victoire.";

  // Les exemplaires en main, par objet : libres d'un côté, armés de l'autre.
  const libres = {}, armes = {};
  aMoi.filter(r => !r.used_at).forEach(r => {
    const d = r.locked_at ? armes : libres;
    (d[r.item_key] = d[r.item_key] || []).push(r);
  });

  // Combien de bonus et de malus sont armés en ce moment. Les mêmes
  // plafonds qu'en base (lock_item) : le site ne fait que les montrer.
  const genreDe = cle => (S.items.find(i => i.key === cle) || {}).target;
  const armesDu = genre => aMoi.filter(r => !r.used_at && r.locked_at && genreDe(r.item_key) === genre).length;
  const poses = { soi: armesDu("soi"), adversaire: armesDu("adversaire") };
  const reste = g => PLAFOND_ARME[g] - poses[g];

  grille.innerHTML = S.items.map(it => {
    const connu = decouverts.has(it.key) || admin;
    const n = enStock[it.key] || 0;
    const taux = formatTaux(tauxDrop(it, S.items));
    const libre = (libres[it.key] || [])[0];
    const arme  = (armes[it.key]  || [])[0];
    return '<article class="item' + (connu ? "" : " locked") + ' ' + esc(it.rarity) + '">'
      + '<div class="itemhead">'
        + '<span class="itemicon" data-tip="' + esc(infobulleObjet(it, connu, null)) + '">'
          + (connu ? esc(it.icon) : "🔒") + '</span>'
        + '<div class="itemid">'
          + '<div class="itemname">' + esc(connu ? it.name : "Objet inconnu") + '</div>'
          + '<div class="itemtags">'
            + '<span class="rarity ' + esc(it.rarity) + '">' + esc(RARETES[it.rarity] || it.rarity) + '</span>'
            + '<span class="itemtarget">' + (it.target === "soi" ? "pour toi" : "sur un adversaire") + '</span>'
            + '<span class="droprate" title="Chance de tomber sur cet objet a chaque butin">' + taux + '</span>'
          + '</div>'
        + '</div>'
        + (n > 1 ? '<span class="itemcount">×' + n + '</span>' : n === 1 ? '<span class="itemcount">×1</span>' : '')
      + '</div>'
      + '<p class="itemtext' + (connu ? "" : " teaser") + '">' + esc(connu ? it.effect : it.teaser) + '</p>'
      + barreObjet(it, libre, arme, reste(it.target))
      + '</article>';
  }).join("");

  majCoffres();

  grille.querySelectorAll("[data-lock]").forEach(b =>
    b.addEventListener("click", () => ouvrirCible(b.dataset.lock)));
  grille.querySelectorAll("[data-unlock]").forEach(b =>
    b.addEventListener("click", () => deverrouiller(b.dataset.unlock)));
}

/* Au plus un bonus et trois malus armés en même temps. Au-delà, plus
   rien à verrouiller tant qu'un objet n'a pas agi. Ces chiffres doivent
   rester identiques à ceux de lock_item, dans objets-effets.sql. */
const PLAFOND_ARME = { soi: 1, adversaire: 3 };

// On ne reprend un objet que dans les 2 minutes qui suivent, pour que
// personne ne puisse attendre le résultat d'une partie (unlock_item).
const FENETRE_ANNULE = 120e3;

/* Un objet en main se verrouille sur une cible AVANT la partie. */
function barreObjet(it, libre, arme, reste){
  if(arme){
    const cible = S.players.find(p => p.id === arme.target_id);
    const encore = FENETRE_ANNULE - (Date.now() - new Date(arme.locked_at).getTime());
    return '<div class="itemact armed">'
      + '<span class="armedon">Armé sur <b>' + esc(cible ? cible.name : "?") + '</b></span>'
      + (encore > 0
          ? '<button type="button" class="btn ghost sm" data-unlock="' + esc(arme.id) + '">'
            + 'Annuler (' + Math.ceil(encore / 1000) + ' s)</button>'
          : '<span class="lockedin" title="Passé ce délai, un objet ne se reprend plus : '
            + 'sinon il suffirait d\'attendre le résultat de la partie.">Verrouillé</span>')
      + '</div>';
  }
  if(libre){
    const bloque = reste <= 0;
    const quoi = it.target === "soi" ? "bonus" : "malus";
    const combien = PLAFOND_ARME[it.target];
    return '<div class="itemact">'
      + '<button type="button" class="btn sm"' + (bloque ? ' disabled' : '')
        + (bloque ? '' : ' data-lock="' + esc(libre.id) + '"')
        + (bloque ? ' title="Tu as déjà ' + combien + ' ' + quoi
                    + (combien > 1 ? ' armés' : ' armé') + '."' : '')
        + '>Verrouiller</button>'
      + (bloque
          ? '<span class="capfull">' + combien + ' ' + quoi + (combien > 1 ? ' armés' : ' armé')
            + ' : attends qu\'' + (combien > 1 ? 'ils agissent' : 'il agisse') + '</span>'
          : '')
      + '</div>';
  }
  return "";
}

/* ------------------------------------------------------------------
   Les coffres

   Le contenu n'existe pas avant l'ouverture : c'est open_box, côté
   serveur, qui tire. Le navigateur ne fait que montrer le résultat.

   D'où l'ordre des choses : le coffre tremble pendant que l'appel
   part, et la roulette ne se construit qu'une fois le gagnant connu,
   parce qu'elle doit s'arrêter dessus. L'attente réseau se cache
   derrière la secousse.
------------------------------------------------------------------- */
const MIN_SECOUSSE = 650;      // le coffre tremble au moins ce temps-là
const DUREE_REEL   = 4200;     // le défilé, comme sur une caisse CS:GO
const PAUSE_FIN    = 280;      // un souffle avant de lire ce qu'on a eu

// Une révélation est à l'écran : loadAll ne doit pas l'effacer.
let reveleEnCours = false;

function coffresEnAttente(){
  const moi = myPlayer();
  if(!moi) return 0;
  return S.boxes.filter(b => b.player_id === moi.id && !b.opened_at).length;
}

/* Le compteur de la barre du haut et l'état au repos de la scène. */
function majCoffres(){
  const n = coffresEnAttente();
  const pastille = $("#itemsBadge");
  if(pastille){ pastille.textContent = n; pastille.hidden = !n; }

  const btn = $("#boxOpen");
  if(!btn) return;
  btn.hidden = !n;

  if(reveleEnCours){
    // Le butin reste sous les yeux, et la roulette garde la main sur
    // le bouton : on ne touche ni à son état ni à la scène.
    btn.textContent = n > 1 ? "Ouvrir le suivant (" + n + ")" : "Ouvrir le dernier";
    return;
  }
  btn.disabled = false;

  $("#boxStage").hidden = false;
  $("#boxStage").className = "boxstage";
  $("#reel").hidden = true;
  $("#boxPrize").hidden = true;
  $("#boxLog").textContent = "";
  $("#boxTitle").textContent = n > 1 ? n + " coffres t'attendent"
                             : n     ? "Un coffre t'attend"
                             :         "Aucun coffre pour l'instant";
  $("#boxHint").textContent = n
    ? "Tu ne sauras ce qu'il contient qu'en l'ouvrant."
    : "Chaque victoire en fait tomber un.";
  btn.textContent = "Ouvrir";
}

function openItems(open){
  if(open){ openShop(false); openWar(false); }   // un seul volet à la fois
  $("#itemsDrawer").classList.toggle("open", open);
  $("#itemsDrawer").setAttribute("aria-hidden", String(!open));
  $("#itemsScrim").hidden = !open;
  if(open){ reveleEnCours = false; renderItems(); }
}

/* La roulette.

   On la construit APRÈS la réponse du serveur : la case d'arrêt doit
   contenir l'objet gagné. Les autres cases sont tirées au hasard dans
   le catalogue, et celles qu'on n'a jamais découvertes restent
   masquées — défiler les noms de tout le catalogue reviendrait à le
   révéler en entier. */
function lancerReel(gagnant){
  const reel = $("#reel"), strip = $("#reelStrip");
  $("#boxStage").hidden = true;
  reel.hidden = false;
  reel.className = "reel";

  const CASES = 54, ARRET = CASES - 7;
  const pool = S.items.filter(i => i.active !== false);
  const moi = myPlayer();
  const vus = new Set(moi ? S.inventory.filter(r => r.player_id === moi.id).map(r => r.item_key) : []);
  vus.add(gagnant.key);                    // on vient tout juste de le décrocher
  const tout = isAdmin();

  const carte = it => {
    const vu = tout || vus.has(it.key);
    return '<div class="rcell ' + esc(it.rarity || "commun") + (vu ? "" : " voile") + '">'
      + '<span class="ricon">' + (vu ? esc(it.icon || "") : "?") + '</span>'
      + '<span class="rname">' + esc(vu ? (it.name || "") : "Inconnu") + '</span>'
      + '</div>';
  };

  let html = "";
  for(let i = 0; i < CASES; i++)
    html += carte(i === ARRET ? gagnant
                              : (pool[Math.floor(Math.random() * pool.length)] || gagnant));
  strip.innerHTML = html;
  strip.style.transition = "none";
  strip.style.transform = "translateX(0px)";

  const reduit = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return new Promise(resolve => {
    /* On attend une image pour que les cases soient mesurables. Si
       l'onglet est en arrière-plan, requestAnimationFrame ne se
       déclenche pas du tout : le filet de sécurité évite une promesse
       qui ne se résoudrait jamais, et donc un volet bloqué. */
    let parti = false;
    const partir = () => {
      if(parti) return;
      parti = true;
      const cell = strip.querySelector(".rcell");
      if(!cell){ resolve(); return; }
      const largeur = cell.getBoundingClientRect().width;
      const gap = parseFloat(getComputedStyle(strip).gap) || 0;
      const vue = strip.parentElement.getBoundingClientRect().width;
      // Un léger décalage au hasard : l'aiguille ne tombe pas toujours
      // pile au milieu de la case, comme sur une vraie caisse.
      const ecart = reduit ? 0 : (Math.random() - .5) * largeur * .56;
      const x = ARRET * (largeur + gap) - (vue / 2 - largeur / 2) + ecart;
      const duree = reduit ? 0 : DUREE_REEL;
      strip.style.transition = duree
        ? "transform " + (duree / 1000) + "s cubic-bezier(.08,.72,.1,1)" : "none";
      strip.style.transform = "translateX(" + (-x) + "px)";
      setTimeout(resolve, duree + (reduit ? 0 : PAUSE_FIN));
    };
    requestAnimationFrame(partir);
    setTimeout(partir, 80);
  });
}

async function ouvrirCoffre(){
  const btn = $("#boxOpen"), scene = $("#boxStage");
  btn.disabled = true;
  reveleEnCours = true;
  $("#boxPrize").hidden = true;
  $("#boxLog").textContent = "";
  $("#reel").hidden = true;
  scene.hidden = false;
  scene.className = "boxstage secoue";
  $("#boxTitle").textContent = "Le coffre s'ouvre\u2026";
  $("#boxHint").textContent = "";

  const [{ data, error }] = await Promise.all([
    sb.rpc("open_box"),
    new Promise(r => setTimeout(r, MIN_SECOUSSE))
  ]);

  if(error){
    reveleEnCours = false;
    majCoffres();
    say("#boxLog", expliquerRpc(error), true);
    return;
  }

  await lancerReel(data);

  const rarete = esc(data.rarity || "");
  $("#reel").className = "reel fini " + rarete;
  $("#boxTitle").textContent = "Tu as trouv\u00e9";
  $("#boxHint").textContent = RARETES[data.rarity] || data.rarity || "";
  $("#boxPrize").className = "boxprize " + rarete;
  $("#boxPrize").innerHTML =
      '<span class="prizeicon">' + esc(data.icon || "") + '</span>'
    + '<div class="prizetext">'
      + '<div class="prizename">' + esc(data.name) + '</div>'
      + '<div class="prizeeffect">' + esc(data.effect) + '</div>'
    + '</div>';
  $("#boxPrize").hidden = false;

  const reste = data.restants || 0;
  btn.hidden = !reste;
  btn.disabled = false;
  btn.textContent = reste > 1 ? "Ouvrir le suivant (" + reste + ")" : "Ouvrir le dernier";

  await loadAll();
}

/* ---------- choix de la cible ---------- */
let objetAPoser = null;

function ouvrirCible(rowId){
  const moi = myPlayer();
  const ligne = S.inventory.find(r => r.id === rowId);
  if(!moi || !ligne) return;
  const it = S.items.find(x => x.key === ligne.item_key);
  if(!it) return;

  objetAPoser = rowId;
  // Un bonus ne se pose que sur soi, un malus que sur un adversaire :
  // la base refuse le reste, autant ne pas le proposer.
  const cibles = it.target === "soi"
    ? S.players.filter(p => p.id === moi.id)
    : S.players.filter(p => p.team !== moi.team);

  $("#tgTitle").textContent = (it.icon ? it.icon + " " : "") + it.name;
  $("#tgHint").textContent = it.effect + (it.target === "soi"
    ? " — il s'applique à ta prochaine partie."
    : " — il s'applique à la prochaine partie de la personne visée.");
  $("#tgLog").textContent = "";
  $("#tgList").innerHTML = cibles.map(p =>
    '<button type="button" class="tgpick" data-p="' + esc(p.id) + '">'
      + avatarRing(p) + '<span>' + esc(p.name) + '</span></button>').join("")
    || '<div class="empty">Aucune cible possible.</div>';
  $("#tgList").querySelectorAll("[data-p]").forEach(b =>
    b.addEventListener("click", () => verrouiller(b.dataset.p)));
  $("#targetDialog").showModal();
}

/* PostgREST répond « Could not find the function … in the schema cache »
   quand la fonction n'existe pas — presque toujours un script SQL pas
   encore passé. Personne ne peut deviner ça : on le dit en français. */
function expliquerRpc(error){
  const m = error && error.message || "";
  if(/schema cache|does not exist|42883/i.test(m)){
    return isAdmin()
      ? "Les objets ne sont pas installés : lance supabase/objets-effets.sql dans le SQL Editor."
      : "Les objets ne sont pas encore activés sur le site. Préviens l'organisateur.";
  }
  return m || "Erreur inconnue.";
}

async function verrouiller(targetId){
  if(!objetAPoser) return;
  say("#tgLog", "Verrouillage…");
  const { error } = await sb.rpc("lock_item", { p_item: objetAPoser, p_target: targetId });
  if(error) return say("#tgLog", expliquerRpc(error), true);
  objetAPoser = null;
  $("#targetDialog").close();
  await loadAll();
}

async function deverrouiller(rowId){
  const { error } = await sb.rpc("unlock_item", { p_item: rowId });
  if(error) return alert(expliquerRpc(error));
  await loadAll();
}

function renderEntry(){
  const block = $("#entryBlock");
  const mine = myPlayer();
  // Visible pour tout le monde, connecté ou non : le suivi d'un joueur
  // est public, et c'est précisément ce qu'on vient regarder.
  if(!S.players.length){ block.hidden = true; return; }
  block.hidden = false;

  // Le menu est rempli pour tous, pas seulement pour l'admin.
  const sel = $("#fPlayer");
  const cur = sel.value;
  sel.innerHTML = S.players.map(p =>
    '<option value="' + esc(p.id) + '">' + esc(p.name)
    + (mine && p.id === mine.id ? " (toi)" : "") + '</option>').join("");
  sel.value = cur && S.players.some(p => p.id === cur)
    ? cur
    : (mine ? mine.id : (S.players[0] && S.players[0].id));

  const vu = targetPlayer();
  const cestMoi = mine && vu && vu.id === mine.id;

  $("#autoHint").textContent = !started()
    ? "Le relevé automatique commencera le jour du lancement. Les parties jouées avant ne comptent pas."
    : cestMoi
      ? "Tes parties classées Solo/Duo sont relevées automatiquement chez Riot, dans les minutes qui suivent leur fin. Les duos avec un joueur du challenge sont reconnus tout seuls."
      : "Les parties classées Solo/Duo de chaque joueur sont relevées automatiquement chez Riot, dans les minutes qui suivent leur fin.";

  renderSyncStatus();
  renderFeed(vu);
  renderInventaire(vu);
}

/* L'inventaire d'un joueur — le sien ou celui d'un autre.

   Un objet n'est nommé que si le VISITEUR l'a déjà obtenu, même quand
   il regarde la réserve de quelqu'un d'autre : sinon il suffirait de
   consulter les autres pour apprendre tout le catalogue. On voit donc
   combien d'objets l'adversaire garde sous le coude, pas lesquels. */
function renderInventaire(t){
  const grille = $("#invGrid");
  if(!grille || !t) return;

  const moi = myPlayer();
  const vus = new Set(isAdmin()
    ? S.items.map(i => i.key)
    : (moi ? S.inventory.filter(r => r.player_id === moi.id).map(r => r.item_key) : []));

  const aLui = S.inventory.filter(r => r.player_id === t.id && !r.used_at);
  if(!aLui.length){
    grille.innerHTML = '<div class="empty">'
      + esc(t.name) + " n'a aucun objet en réserve.</div>";
    return;
  }

  // Regroupés par objet : trois Pierres de Garde font une carte « ×3 ».
  const parCle = {};
  aLui.forEach(r => { (parCle[r.item_key] = parCle[r.item_key] || []).push(r); });

  grille.innerHTML = Object.entries(parCle).map(([cle, rangs]) => {
    const it = S.items.find(i => i.key === cle);
    const connu = vus.has(cle);
    const arme = rangs.find(r => r.locked_at);
    const cible = arme ? S.players.find(p => p.id === arme.target_id) : null;

    return '<article class="item' + (connu ? "" : " locked") + ' ' + esc(it ? it.rarity : "") + '">'
      + '<div class="itemhead">'
        + '<span class="itemicon">' + (connu && it ? esc(it.icon) : "\u{1F512}") + '</span>'
        + '<div class="itemid">'
          + '<div class="itemname">' + esc(connu && it ? it.name : "Objet inconnu") + '</div>'
          + '<div class="itemtags">'
            + (it ? '<span class="rarity ' + esc(it.rarity) + '">'
                  + esc(RARETES[it.rarity] || it.rarity) + '</span>' : "")
            + (it ? '<span class="itemtarget">'
                  + (it.target === "soi" ? "pour lui" : "sur un adversaire") + '</span>' : "")
          + '</div>'
        + '</div>'
        + (rangs.length > 1 ? '<span class="itemcount">\u00d7' + rangs.length + '</span>' : '')
      + '</div>'
      + '<p class="itemtext' + (connu ? "" : " teaser") + '">'
        + esc(connu && it ? it.effect : (it ? it.teaser : "")) + '</p>'
      + (arme
          ? '<div class="itemact armed"><span class="armedon">Armé sur <b>'
            + esc(cible ? cible.name : "?") + '</b></span></div>'
          : "")
      + '</article>';
  }).join("");
}

/* Historique ou inventaire : on bascule l'affichage, pas les données. */
function majVueSuivi(){
  const hist = suiviVue === "hist";
  const f = $("#feed"), g = $("#invGrid");
  if(f) f.hidden = !hist;
  if(g) g.hidden = hist;
}

/* ---------------------------------------------------------------------
   « En direct »
   Spectator-V5 nous dit qui joue et depuis quand. Le compteur n'est
   jamais stocké : on le recalcule depuis l'heure de début, sinon il
   serait faux l'instant d'après.

   Garde-fou : au-delà de deux heures, on considère que la ligne est
   restée coincée — une partie classée ne dure pas si longtemps, et
   mieux vaut ne rien afficher qu'un compteur absurde.
--------------------------------------------------------------------- */
const DUREE_MAX_LIVE = 2 * 3600e3;

function enDirect(id){
  const r = S.live && S.live[id];
  if(!r || !r.started_at) return null;
  const ms = Date.now() - new Date(r.started_at).getTime();
  if(ms < 0 || ms > DUREE_MAX_LIVE) return null;
  return ms;
}

const chrono = ms => {
  const t = Math.floor(ms / 1000);
  return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
};

function pastilleLive(id){
  const ms = enDirect(id);
  if(ms === null) return "";
  return '<span class="livenow" data-live="' + esc(id) + '"'
    + ' title="En partie classée en ce moment">'
    + '<i></i><span class="lbl">En direct</span><b>' + chrono(ms) + '</b></span>';
}

// Les compteurs avancent chaque seconde sans tout redessiner.
function tickLive(){
  document.querySelectorAll("[data-live]").forEach(el => {
    const ms = enDirect(el.dataset.live);
    const b = el.querySelector("b");
    if(ms === null){ el.remove(); return; }
    if(b) b.textContent = chrono(ms);
  });
}

/* Photo Discord cerclée de la couleur de l'équipe.
   Sans compte lié, on retombe sur l'initiale du pseudo. */
function avatarRing(p, opts){
  opts = opts || {};
  if(!p) return '<span class="pav ghost" aria-hidden="true"></span>';
  const prof = p.claimed_by ? S.profiles[p.claimed_by] : null;
  const url  = prof && prof.avatar_url ? prof.avatar_url : null;
  const title = p.name + " #" + p.tag;
  const taille = opts.lg ? " lg" : opts.sm ? " sm" : "";
  return '<span class="pav ' + p.team + taille + '" title="' + esc(title) + '">'
    + (url ? '<img src="' + esc(url) + '" alt="' + esc(p.name) + '">'
           : '<i>' + esc(p.name.trim().charAt(0).toUpperCase() || "?") + '</i>')
    + '</span>';
}

const heureDe = g => new Date(g.created_at).toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit" });
const jourDe  = g => new Date(g.created_at).toLocaleDateString("fr-FR", { day:"numeric", month:"short" });

/* Le classement général se fait au LP NET : c'est lui la vérité du
   challenge. La partie, elle, s'affiche au total objets compris, parce
   que c'est ce que le joueur a vraiment vécu. Les deux sont montrés. */
function celluleLp(x){
  const net = x.lp, obj = x.lp_items || 0, tot = net + obj;
  const signe = v => (v >= 0 ? "up" : "down");
  if(!obj){
    return '<span class="delta ' + signe(net) + '"' + (x.approx ? ' title="Valeur estimée"' : '') + '>'
      + (x.approx ? "≈" : "") + signed(net) + '</span>';
  }
  return '<span class="deltabox">'
    + '<b class="delta big ' + signe(tot) + '" title="Total ressenti, objets compris">'
      + (x.approx ? "≈" : "") + signed(tot) + '</b>'
    + '<i class="deltanet" title="LP nets rendus par Riot : ce qui compte au classement">'
      + signed(net) + ' net</i>'
    + '</span>';
}

/* ------------------------------------------------------------------
   Infobulle en bloc
   Le `title` du navigateur met une seconde à sortir, s'affiche en police
   système et ne se met pas en forme. On refait la même chose en HTML,
   dans le style du reste : tout élément portant data-tip la déclenche.
------------------------------------------------------------------- */
function initInfobulles(){
  const bulle = $("#floatTip");
  if(!bulle) return;

  const montrer = el => {
    const txt = el.getAttribute("data-tip");
    if(!txt) return;
    const [titre, ...reste] = txt.split("\n").filter(Boolean);

    /* Qui a posé l'objet. On le montre même quand l'objet reste
       inconnu : savoir qui t'a visé fait partie du jeu, c'est l'effet
       qui doit rester secret. */
    const qui = el.getAttribute("data-tip-who");
    const par = qui ? S.players.find(p => p.id === qui) : null;
    const soi = el.getAttribute("data-tip-self") === "1";

    bulle.innerHTML =
        (par ? '<div class="tipwho">' + avatarRing(par, { sm:true })
             + '<span>' + esc(soi ? "posé par " + par.name : "lancé par " + par.name) + '</span></div>'
             : "")
      + '<div class="tiptitre">' + esc(titre) + '</div>'
      + reste.map(l => '<div class="tipcorps' + (l.startsWith("\u2192") ? " tipnote" : "") + '">'
          + esc(l) + '</div>').join("");
    bulle.hidden = false;
    placer(el);
  };

  const placer = el => {
    const r = el.getBoundingClientRect();
    const b = bulle.getBoundingClientRect();
    // On préfère au-dessus ; en haut d'écran on bascule en dessous.
    const dessus = r.top > b.height + 12;
    let x = r.left + r.width / 2 - b.width / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - b.width - 8));
    bulle.style.left = x + "px";
    bulle.style.top = (dessus ? r.top - b.height - 8 : r.bottom + 8) + "px";
  };

  document.addEventListener("mouseover", e => {
    const el = e.target.closest && e.target.closest("[data-tip]");
    if(el) montrer(el);
  });
  document.addEventListener("mouseout", e => {
    const el = e.target.closest && e.target.closest("[data-tip]");
    if(el) bulle.hidden = true;
  });
  // Un défilement sous une infobulle ouverte la laisserait flotter seule.
  window.addEventListener("scroll", () => { bulle.hidden = true; }, true);
}

/* L'infobulle d'un objet : son nom, son effet, et ce qu'il a donné ici.
   L'effet n'apparaît que si le visiteur connaît l'objet — sinon on
   dévoilerait par l'infobulle ce que la grille garde secret. */
function infobulleObjet(it, connu, note){
  // Sans la note : elle dit POURQUOI l'objet a agi (« 11 morts »,
  // « vision 30 »), donc elle trahit son effet aussi sûrement que son
  // nom. Un objet jamais obtenu ne doit rien livrer du tout.
  if(!connu || !it) return "Un objet que tu n'as pas encore découvert";
  return it.name
    + (it.effect ? "\n" + it.effect : "")
    + (note ? "\n\n→ " + note : "");
}

/* ------------------------------------------------------------------
   D'où vient l'or d'une partie

   Le même barème que la fonction « riot » (OR_ROLES / orDeLaPartie).
   Il vit donc à DEUX endroits : là-bas il calcule, ici il explique. Si
   tu changes l'un, change l'autre — et le total affiché reste celui
   enregistré en base, pas celui recalculé ici, pour qu'un barème qui
   aurait bougé depuis ne réécrive pas l'histoire.
------------------------------------------------------------------- */
const OR_ROLES = {
  TOP:     { kill: 20, mort: 10, assist: 5 },
  MIDDLE:  { kill: 20, mort: 10, assist: 5 },
  BOTTOM:  { kill: 20, mort: 10, assist: 5 },
  JUNGLE:  { kill: 12, mort: 10, assist: 4, drake: 20, nashor: 40, vol: 30 },
  UTILITY: { kill: 10, mort: 10, assist: 7, vision: 1.2 }
};
const OR_VICTOIRE = 50;
const ROLE_FR = { TOP:"Top", JUNGLE:"Jungle", MIDDLE:"Mid", BOTTOM:"Bot", UTILITY:"Support" };

function detailOr(g){
  const b = OR_ROLES[g.role] || OR_ROLES.MIDDLE;
  const l = [];
  const pousse = (quoi, or) => { if(or) l.push({ quoi, or: Math.round(or) }); };

  pousse((g.kills   || 0) + " kills",   b.kill   * (g.kills   || 0));
  pousse((g.deaths  || 0) + " morts",  -b.mort   * (g.deaths  || 0));
  pousse((g.assists || 0) + " assists", b.assist * (g.assists || 0));
  if(b.drake)  pousse((g.dragons || 0) + " drakes",  b.drake  * (g.dragons || 0));
  if(b.nashor) pousse((g.barons  || 0) + " nashors", b.nashor * (g.barons  || 0));
  if(b.vision) pousse((g.vision  || 0) + " de vision", b.vision * (g.vision || 0));
  if(g.win) pousse("victoire", OR_VICTOIRE);
  return l;
}

// Le texte de l'infobulle : le total enregistré, puis le détail.
function infobulleOr(g){
  const detail = detailOr(g);
  const somme = detail.reduce((a, x) => a + x.or, 0);
  const lignes = [orFr(g.gold_gagne) + " or" + (g.role ? " \u00b7 " + (ROLE_FR[g.role] || g.role) : "")];
  detail.forEach(x => lignes.push((x.or > 0 ? "+" : "\u2212") + orFr(Math.abs(x.or)) + "   " + x.quoi));
  // Un barème qui aurait changé depuis : on le dit plutôt que de faire
  // comme si le détail expliquait le total.
  if(somme !== g.gold_gagne && Math.max(0, somme) !== g.gold_gagne){
    lignes.push("\u2192 bar\u00e8me modifi\u00e9 depuis : le total fait foi");
  }else if(somme < 0){
    lignes.push("\u2192 jamais moins de 0 sur une partie");
  }
  return lignes.join("\n");
}

/* Les objets qui ont pesé sur cette partie, avec ce qu'ils ont fait. */
function chipsObjets(x, decouverts){
  const rows = S.inventory.filter(r => r.applied_match && r.applied_match === x.match_id);
  if(!rows.length) return "";
  return '<div class="rowitems">' + rows.map(r => {
    const it = S.items.find(i => i.key === r.item_key);
    const vu = decouverts.has(r.item_key);
    const lp = r.lp_effect || 0;
    // Même règle que le journal : ni nom ni raison si l'objet est inconnu.
    const titre = infobulleObjet(it, vu && !!it, r.note);
    // r.player_id : celui qui a posé l'objet. r.target_id : celui qui
    // le subit. Les deux sont la même personne pour un bonus.
    return '<span class="objchip ' + (lp > 0 ? "up" : lp < 0 ? "down" : "flat") + '"'
      + ' data-tip="' + esc(titre) + '"'
      + ' data-tip-who="' + esc(r.player_id) + '"'
      + ' data-tip-self="' + (r.player_id === r.target_id ? "1" : "0") + '">'
      + '<span class="objico">' + (vu && it ? esc(it.icon) : "🔒") + '</span>'
      + signed(lp) + '</span>';
  }).join("") + '</div>';
}

/* ------------------------------------------------------------------
   Journal de guerre
   Tout ce qui a été lancé, dans l'ordre inverse. Un objet déjà résolu
   est nommé : son effet a eu lieu, le cacher n'a plus de sens. Un objet
   encore armé reste anonyme pour qui ne l'a jamais obtenu — savoir
   qu'on est visé fait partie du jeu, savoir par quoi serait tricher.
------------------------------------------------------------------- */
/* ------------------------------------------------------------------
   Lu / non lu
   Propre à chaque visiteur, donc stocké dans son navigateur : ce n'est
   pas une donnée du challenge, et la partager n'aurait aucun sens.
   Tout accès est protégé — en navigation privée le stockage peut jeter,
   et le journal doit rester lisible dans ce cas.
------------------------------------------------------------------- */
const CLE_LUS = "soloq-journal-lus";

function chargerLus(){
  try{ return new Set(JSON.parse(localStorage.getItem(CLE_LUS) || "[]")); }
  catch(_){ return new Set(); }
}
function enregistrerLus(set){
  try{ localStorage.setItem(CLE_LUS, JSON.stringify([...set].slice(-400))); }
  catch(_){}
}
let journalLus = chargerLus();

function basculerLu(id){
  journalLus.has(id) ? journalLus.delete(id) : journalLus.add(id);
  enregistrerLus(journalLus);
  renderWarlog();
}

function toutMarquerLu(){
  S.inventory.filter(r => r.locked_at || r.applied_match).forEach(r => journalLus.add(r.id));
  enregistrerLus(journalLus);
  renderWarlog();
}

function renderWarlog(){
  const box = $("#warLog");
  if(!box) return;
  const lignes = S.inventory
    .filter(r => r.locked_at || r.applied_match)
    .sort((x, y) => new Date(y.locked_at || y.obtained_at) - new Date(x.locked_at || x.obtained_at));

  const moi = myPlayer();
  const vus = new Set(isAdmin()
    ? S.items.map(i => i.key)
    : (moi ? S.inventory.filter(r => r.player_id === moi.id).map(r => r.item_key) : []));

  // La pastille compte les NON LUS : un compteur qui ne redescend
  // jamais n'incite plus personne à ouvrir le journal.
  const nonLus = lignes.filter(r => !journalLus.has(r.id)).length;
  const pastille = $("#warCount");
  if(pastille){
    pastille.textContent = nonLus;
    pastille.hidden = !nonLus;
  }
  const btnLu = $("#warRead");
  if(btnLu) btnLu.disabled = !nonLus;
  const intro = $("#warHint");
  if(intro){
    intro.textContent = lignes.length
      ? "Qui a lancé quoi, sur qui, et ce que ça a donné."
      : "Rien n'a encore été lancé.";
  }

  if(!lignes.length){
    box.innerHTML = '<div class="empty">Aucun objet n\'a encore été lancé. Ça ne saurait tarder.</div>';
    return;
  }


  box.innerHTML = lignes.slice(0, 60).map(r => {
    const par = S.players.find(p => p.id === r.player_id);
    const sur = S.players.find(p => p.id === r.target_id);
    const it = S.items.find(i => i.key === r.item_key);
    const resolu = !!r.applied_match;
    /* Un objet ARMÉ ne se révèle à personne : le nommer avant la partie
       dirait à la cible exactement ce qui l'attend, et lui laisserait le
       temps d'adapter son jeu. On annonce la manœuvre, pas l'arme.

       Un objet RÉSOLU ne se révèle qu'à qui l'a déjà obtenu. Le nommer
       à tout le monde apprendrait son effet à ceux qui ne l'ont jamais
       looté — et la découverte est la moitié du plaisir. */
    const connu = resolu && vus.has(r.item_key);
    const soi = par && sur && par.id === sur.id;
    const lp = r.lp_effect || 0;
    const nomPar = esc(par ? par.name : "?");
    const nomSur = esc(sur ? sur.name : "?");

    let ligne;
    if(!resolu){
      ligne = soi
        ? '<b>' + nomPar + '</b> prépare quelque chose'
        : '<b>' + nomPar + '</b> manigance une attaque sur <b>' + nomSur + '</b>';
    }else{
      const nom = connu && it
        ? (it.icon ? it.icon + " " : "") + it.name
        : "\u{1F512} un objet";
      ligne = '<b>' + nomPar + '</b> ' + (soi ? "s'est protégé avec" : "a lancé")
        + ' <span class="waritem" data-tip="' + esc(infobulleObjet(it, connu, r.note)) + '">'
        + nom + '</span>'
        + (soi ? "" : ' sur <b>' + nomSur + '</b>');
    }

    const lu = journalLus.has(r.id);
    return '<div class="warrow' + (resolu ? "" : " pending") + (lu ? "" : " unread")
      + '" data-lu="' + esc(r.id) + '" title="' + (lu ? "Marquer non lu" : "Marquer lu") + '">'
      + avatarRing(par, { sm:true })
      + '<div class="wartext">'
        + '<div class="warline">' + ligne + '</div>'
        + '<div class="warmeta">'
          + (resolu
              // La note explique l'effet : réservée à qui connaît l'objet.
              ? (connu ? esc(r.note || "effet appliqué") + " · " : "") + quand(r.used_at || r.locked_at)
              : "en attente de sa prochaine partie · " + quand(r.locked_at))
        + '</div>'
      + '</div>'
      + (resolu
          ? '<span class="delta ' + (lp > 0 ? "up" : lp < 0 ? "down" : "flat") + '">' + signed(lp) + '</span>'
          : '<span class="warwait">en embuscade</span>')
      + '</div>';
  }).join("");

  box.querySelectorAll("[data-lu]").forEach(el => el.addEventListener("click", e => {
    // Le nom de l'objet porte son infobulle : on ne bascule pas dessus.
    if(e.target.closest("[data-tip]")) return;
    basculerLu(el.dataset.lu);
  }));
}

// « il y a 12 min », « il y a 3 h », « le 4 oct. »
function quand(t){
  if(!t) return "—";
  const ms = Date.now() - new Date(t).getTime();
  const m = Math.floor(ms / 60000);
  if(m < 1) return "à l'instant";
  if(m < 60) return "il y a " + m + " min";
  const h = Math.floor(m / 60);
  if(h < 24) return "il y a " + h + " h";
  return "le " + new Date(t).toLocaleDateString("fr-FR", { day:"numeric", month:"short" });
}

function renderFeed(t){
  const box = $("#feed");
  const head = $("#feedTitle");

  if(!t){
    head.textContent = "Historique";
    box.innerHTML = '<div class="empty">Aucun profil sélectionné.</div>';
    return;
  }

  const g = gamesOf(t.id).slice().reverse();
  const nb = g.filter(x => x.kind !== "adjust").length;
  const mine = myPlayer();
  head.innerHTML = avatarRing(t, { lg:true })
    + '<span class="feedwho">' + esc(t.name) + '</span>' + pastilleLive(t.id)
    + '<span class="feedcount">' + (nb ? nb + (nb > 1 ? " parties relevées" : " partie relevée") : "aucune partie") + '</span>'
    + '<span class="goldchip" title="Or en réserve">' + PIECE_OR + '<b>' + orFr(t.gold || 0) + '</b></span>';

  if(!g.length){
    const amoi = myPlayer() && myPlayer().id === t.id;
    box.innerHTML = '<div class="empty">Rien pour l\'instant. '
      + (amoi ? "Tes parties classées apparaîtront ici quelques minutes après leur fin."
              : esc(t.name) + " n\'a pas encore de partie relevée.") + '</div>';
    return;
  }

  const admin = isAdmin();
  // Ce que CE visiteur a déjà découvert : un objet jamais obtenu reste
  // une icône cadenassée, même quand il vient de le prendre en pleine figure.
  const moi = myPlayer();
  const decouvertsParMoi = new Set(
    admin ? S.items.map(i => i.key)
          : (moi ? S.inventory.filter(r => r.player_id === moi.id).map(r => r.item_key) : []));

  box.innerHTML = g.slice(0, 80).map(x => {
    const del = admin
      ? '<button type="button" class="x" data-id="' + esc(x.id) + '" aria-label="Supprimer cette ligne">✕</button>' : '';
    const time = '<div class="rowtime"><b>' + heureDe(x) + '</b><span>' + jourDe(x) + '</span></div>';

    if(x.kind === "adjust"){
      return '<div class="row">'
        + '<span class="delta ' + (x.lp >= 0 ? "up" : "down") + '">' + signed(x.lp) + '</span>'
        + '<span class="pavpair">' + avatarRing(t) + '</span>'
        + '<div class="rowmain"><div class="rowtitle">Hors partie<span class="tagchip solo">ajustement</span></div>'
        + '<div class="rowmeta">Esquive ou décroissance : des LP ont bougé sans partie jouée</div></div>'
        + time + del + '</div>';
    }

    const partner = x.partner_id ? S.players.find(q => q.id === x.partner_id) : null;

    let chip = '<span class="tagchip solo">solo</span>';
    if(x.duo === "team")  chip = '<span class="tagchip">duo allié</span>';
    if(x.duo === "enemy") chip = '<span class="tagchip enemy">duo adverse</span>';

    let meta;
    // Le butin suit peutLooter() dans la fonction serveur : victoire en
    // solo ou en duo allié. Un duo adverse n'en donne jamais.
    const aLoote = !!x.win;
    if(x.duo === "team")      meta = "Avec " + (partner ? partner.name : "un coéquipier");
    else if(x.duo === "enemy") meta = "Contre " + (partner ? partner.name : "un adversaire");
    else                       meta = "Partie solo";
    if(aLoote) meta += " · un objet est tombé";
    if(x.champion) meta = x.champion + " · " + meta;
    if(x.approx) meta += " · LP estimés (plusieurs parties entre deux relevés)";

    return '<div class="row">'
      + celluleLp(x)
      + '<span class="pavpair">' + avatarRing(t)
        + (partner ? avatarRing(partner, { sm:true }) : "") + '</span>'
      + '<div class="rowmain">'
        + '<div class="rowtitle">' + (x.win ? "Victoire" : "Défaite") + chip + '</div>'
        + '<div class="rowmeta">' + esc(meta) + '</div>'
        + chipsObjets(x, decouvertsParMoi)
        + (x.gold_gagne
            ? '<div class="rowgold" data-tip="' + esc(infobulleOr(x)) + '">'
              + PIECE_OR + '<b>+' + orFr(x.gold_gagne) + '</b></div>'
            : "")
      + '</div>'
      + time + del + '</div>';
  }).join("");

  box.querySelectorAll(".x").forEach(b => b.addEventListener("click", () => removeGame(b.dataset.id)));
}

function renderAdmin(){
  const panel = $("#adminPanel");
  if(!isAdmin()){ panel.hidden = true; return; }
  panel.hidden = false;
  const c = S.challenge;
  if(document.activeElement && document.activeElement.closest("#adminPanel")) return; // ne pas écraser une saisie en cours
  $("#aName").value = c.name;
  $("#aStart").value = c.start_date;
  $("#aDays").value = c.days;
  $("#aTeamA").value = c.team_a_name;
  $("#aTeamB").value = c.team_b_name;
  $("#aPlayers").innerHTML = S.players.map(p =>
    '<tr data-id="'+esc(p.id)+'">'
    + '<td><input type="text" class="pn" value="'+esc(p.name)+'" aria-label="Pseudo"></td>'
    + '<td style="width:110px"><input type="text" class="pt" value="'+esc(p.tag)+'" aria-label="Tag"></td>'
    + '<td style="width:130px"><select class="pteam" aria-label="Équipe"><option value="a"'+(p.team==="a"?" selected":"")+'>'+esc(c.team_a_name)+'</option><option value="b"'+(p.team==="b"?" selected":"")+'>'+esc(c.team_b_name)+'</option></select></td>'
    + '<td style="width:110px">'+(p.claimed_by ? '<button type="button" class="btn ghost sm release">Libérer</button>' : '<span class="wr">libre</span>')+'</td></tr>'
  ).join("");
  $("#aPlayers").querySelectorAll(".release").forEach(b =>
    b.addEventListener("click", () => releasePlayer(b.closest("tr").dataset.id)));
}

function render(){
  if(!S.ready) return;
  const states = allStates();
  renderHeader();
  renderAccount();
  renderCountdown();
  renderClaim();
  renderBalance(states);
  renderRosters(states);
  renderEntry();
  renderItems();
  renderWarlog();
  renderShop();
  renderLadder(states);
  renderChart();
  renderAdmin();
  $("#foot").innerHTML = '© ' + new Date().getFullYear() + ' <b>ChezLesBatards</b> · Tous droits réservés';
}

/* ===================================================================
   Règlement — volet latéral à onglets
=================================================================== */
const RULES = [
  { t:"Les deux scores", h:
    "<p>Il y a <strong>deux classements</strong>, et ils ne se lisent pas pareil.</p>"
  + "<p><strong>Le classement individuel se fait au LP net</strong> \u2014 ce que Riot t'a vraiment donn\u00e9, rien d'autre. Aucun objet ne peut t'y faire monter ni descendre, et personne ne peut t'y faire chuter.</p>"
  + "<p><strong>Le duel d'\u00e9quipes se fait au LP global</strong>, objets et primes journali\u00e8res compris. C'est l\u00e0 que les objets p\u00e8sent : on sabote le camp d'en face, pas une personne au tableau.</p>"
  + "<p>Sur chaque partie, le gros chiffre est ton total ressenti, objets compris ; le petit en dessous est ton LP net. Le premier nourrit le score d'\u00e9quipe, le second ton classement.</p>"
  + "<p>Le rang affich\u00e9 \u00e0 c\u00f4t\u00e9 de ton pseudo est ton vrai rang chez Riot. Il ne compte pas : partir de Fer ou de Diamant ne change rien.</p>" },

  { t:"Suivi automatique", h:
    "<p>Personne ne déclare rien : <strong>tes parties sont relevées directement chez Riot</strong>, toutes les cinq minutes environ. Une partie apparaît quelques minutes après sa fin.</p>"
  + "<p>L'API Riot ne donne pas les LP d'une partie : le site les déduit en comparant ton rang avant et après. Les promotions et rétrogradations sont prises en compte.</p>"
  + "<p>Si tu enchaînes deux parties entre deux relevés, leur total est exact mais la répartition est estimée : elle est alors marquée « ≈ ».</p>"
  + "<p>Une esquive ou une décroissance fait perdre des LP sans partie : elle apparaît comme un <em>ajustement</em> et compte dans ton net.</p>" },

  { t:"Les duos", h:
    "<p>Deux joueurs du challenge dans la <strong>même équipe LoL</strong> sont reconnus comme un duo, allié ou adverse selon leurs équipes du challenge. Rien à taguer.</p>"
  + "<p>Le classement affiche ton winrate avec chacun, à côté de son winrate global.</p>"
  + "<p>L'API ne distingue pas un vrai duo de deux joueurs tombés ensemble par hasard : entre joueurs du même niveau, ça peut arriver.</p>" },

  { t:"Le duel d'équipes", h:
    "<p>Le score d'une équipe est la somme des LP nets de ses membres.</p>"
  + "<p>Une seule mauvaise soirée peut faire basculer la balance : personne n'est jamais à l'abri.</p>" },

  { t:"Les objets", h:
    "<p><strong>Gagne une partie</strong> : un objet tombe. Solo, duo allié, duo adverse — toute victoire compte.</p>"
  + "<p>Un objet est un <strong>bonus</strong> que tu poses sur toi, ou un <strong>malus</strong> que tu poses sur un adversaire.</p>"
  + "<p><strong>Il faut le verrouiller avant de jouer.</strong> Tu choisis l'objet, tu choisis la cible, et il agira sur la <strong>prochaine partie de cette personne</strong> — où qu'elle joue, avec qui qu'elle veuille. Tu n'as pas besoin d'être dans sa partie, ni même d'être connecté. Que sa condition soit remplie ou non, l'objet est consommé.</p>"
  + "<p>Sur une même partie, au plus <strong>un bonus et trois malus</strong> font effet. Les objets verrouillés en trop restent en réserve, intacts.</p>"
  + "<p>Le récap d'une partie montre en gros ce que tu as <em>ressenti</em>, objets compris, et en petit tes <em>LP nets</em>.</p>"
  + "<p><strong>Les objets ne touchent pas ton classement individuel</strong>, qui reste au LP net. Mais ils comptent pleinement dans le <strong>score de ton équipe</strong>, calculé en LP globaux. Un malus bien placé ne fait pas chuter quelqu'un au tableau : il coûte des points à son camp.</p>"
  + "<p>Tant que tu n'as jamais obtenu un objet, l'onglet n'en montre qu'une <em>rumeur</em> : tu sais qu'il existe, pas ce qu'il fait. Dès que tu en décroches un, son effet t'est révélé pour de bon — y compris dans le récap des parties.</p>"
  + "<p>Plus un objet est rare, plus il est puissant — et plus il se fait attendre.</p>" },

  { t:"L'objectif du jour", h:
    "<p>Chaque jour, une équipe qui engrange <strong>150 LP</strong> décroche <strong>+80 LP</strong> de plus pour elle.</p>"
  + "<p><strong>Seuls les gains comptent.</strong> Une défaite ne fait pas reculer le compteur du jour : l'objectif récompense ce qu'on va chercher, pas ce qu'on évite de perdre.</p>"
  + "<p>Le compteur se lit en <strong>LP globaux</strong>, comme le score d'équipe : une victoire annulée par un malus adverse ne le fait pas avancer.</p>"
  + "<p>La jauge est sous le nom de chaque équipe. La prime s'ajoute au total de l'équipe, jamais au compte d'un joueur : personne ne grimpe au classement individuel grâce à elle.</p>"
  + "<p>Un jour couru, un jour gagné : les primes s'accumulent sur toute la durée du challenge.</p>" },

  { t:"Le journal de guerre", h:
    "<p>Tout ce qui a été lancé, par qui et sur qui, dans l'ordre inverse.</p>"
  + "<p>Un objet <strong>encore armé</strong> n'est jamais nommé, pour personne : on lit « machin manigance une attaque sur bidule ». Savoir qu'on est visé fait partie du jeu ; savoir par quoi laisserait le temps d'adapter sa partie.</p>"
  + "<p>Un objet <strong>déjà résolu</strong> n'est nommé qu'à ceux qui l'ont déjà obtenu. Pour les autres il reste un cadenas, avec les LP qu'il a coûtés : la découverte fait la moitié du plaisir, et on ne l'apprend pas en regardant les malheurs des autres.</p>" },

  { t:"Ce qui compte", h:
    "<p>File <strong>Solo/Duo classée</strong> uniquement — ni Flex, ni ARAM. Les remakes sont ignorés, les placements ne rapportent rien tant que le rang n'est pas attribué.</p>"
  + "<p>Une partie compte si elle se <strong>termine</strong> pendant le challenge. Lancée à 23h58 la veille et finie à 00h02, elle compte — les LP ont bien bougé pendant. Lancée avant la fin et finie après, elle ne compte pas : la même règle des deux côtés.</p>" },

  { t:"Durée", h:
    "<p>21 jours pleins. Le relevé qui compte est celui du dernier soir : le classement au coup de sifflet, pas le pic de la semaine 2.</p>" }
];
let ruleIndex = 0;

function renderRules(){
  $("#rulesTabs").innerHTML = RULES.map((r,i) =>
    '<button type="button" role="tab" aria-selected="'+(i===ruleIndex)+'" data-i="'+i+'">'+esc(r.t)+'</button>').join("");
  $("#rulesBody").innerHTML = "<h3>" + esc(RULES[ruleIndex].t) + "</h3>" + RULES[ruleIndex].h;
  $("#rulesTabs").querySelectorAll("button").forEach(b =>
    b.addEventListener("click", () => { ruleIndex = +b.dataset.i; renderRules(); }));
}
/* --------------------------- boutique -----------------------------
   L'or se gagne en jouant ; il s'y dépense. Deux rayons seulement :
   des objets qu'on a DÉJÀ décrochés en jeu — on n'achète pas une
   surprise — et des LP fictifs hors de prix qui ne comptent que dans
   le score d'équipe, jamais au classement individuel.
------------------------------------------------------------------- */
/* Le rayon. Les prix vivent AUSSI dans boutique-v2.sql, qui seul
   décide : la page ne fait que les annoncer. Si tu changes l'un,
   change l'autre. */
const PRIX = { lp25: 2000, boost: 5000, swap: 25000 };
const BOOST_HEURES = 2;
const orFr = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");

/* Le bonus « double LP » d'une équipe, s'il court encore. */
function boostEquipe(team){
  const b = S.boosts && S.boosts[team];
  if(!b || !b.until) return 0;
  const fin = new Date(b.until).getTime();
  return fin > Date.now() ? fin : 0;
}

function openShop(open){
  if(open){ openWar(false); openItems(false); }   // un seul volet à la fois
  $("#shopDrawer").classList.toggle("open", open);
  $("#shopDrawer").setAttribute("aria-hidden", String(!open));
  $("#shopScrim").hidden = !open;
  if(open) renderShop();
}

function renderShop(){
  const corps = $("#shopBody"), bourse = $("#purse");
  if(!corps) return;
  const moi = myPlayer();
  const or = moi ? (moi.gold || 0) : 0;

  const pastille = $("#goldCount");
  if(pastille){
    pastille.textContent = orFr(or);
    pastille.hidden = !moi;
  }

  if(!moi){
    bourse.textContent = "\u2014";
    corps.innerHTML = '<div class="empty">Connecte-toi avec ton profil joueur pour gagner et dépenser de l\'or.</div>';
    return;
  }
  bourse.innerHTML = PIECE_OR + '<b>' + orFr(or) + '</b> <span>or</span>';

  // Les objets déjà décrochés au moins une fois : eux seuls sont en rayon.
  const connus = new Set(S.inventory.filter(r => r.player_id === moi.id).map(r => r.item_key));
  const rayon = S.items.filter(i => connus.has(i.key) && i.active !== false);

  const ligneObjet = it => {
    const prix = it.price || 0;
    const possible = or >= prix;
    return '<div class="shoprow' + (possible ? "" : " court") + '">'
      + '<span class="shopico" data-tip="' + esc(infobulleObjet(it, true, null)) + '">' + esc(it.icon) + '</span>'
      + '<div class="shoptext"><div class="shopname">' + esc(it.name) + '</div>'
        + '<div class="shopsub"><span class="rarity ' + esc(it.rarity) + '">'
        + esc(RARETES[it.rarity] || it.rarity) + '</span> · '
        + (it.target === "soi" ? "pour toi" : "sur un adversaire") + '</div></div>'
      + '<button type="button" class="btn sm" data-buy="' + esc(it.key) + '"'
        + (possible ? "" : " disabled") + '>' + orFr(prix) + ' or</button>'
      + '</div>';
  };

  const article = (ico, nom, sous, prix, attr, bloque) => {
    const possible = or >= prix && !bloque;
    return '<div class="shoprow' + (possible ? "" : " court") + '">'
      + '<span class="shopico">' + ico + '</span>'
      + '<div class="shoptext"><div class="shopname">' + nom + '</div>'
        + '<div class="shopsub">' + sous + '</div></div>'
      + '<button type="button" class="btn sm" ' + attr
        + (possible ? "" : " disabled") + '>' + orFr(prix) + ' or</button>'
      + '</div>';
  };

  // Le bonus en cours — celui de TON ÉQUIPE, pas le tien.
  const finBoost = boostEquipe(moi.team);
  const boostActif = finBoost > 0;

  const mouvements = S.ledger.filter(r => r.player_id === moi.id).slice(0, 12);

  corps.innerHTML =
      '<h4>Tes objets</h4>'
    + (rayon.length
        ? rayon.map(ligneObjet).join("")
        : '<div class="empty">Tu ne peux acheter qu\'un objet que tu as déjà décroché en jeu. Gagne une partie pour en découvrir un.</div>')
    + '<h4>Pour ton équipe</h4>'
    + article("\u{1F4C8}", "25 LP", "cr\u00e9dit\u00e9s \u00e0 ton \u00e9quipe", PRIX.lp25, 'data-lp="25"', false)
    + article("\u26A1", "Double LP \u00b7 " + BOOST_HEURES + " h",
        boostActif
          ? '<b class="boostvif">actif encore ' + resteBoost(finBoost) + '</b> \u00b7 rachat = +' + BOOST_HEURES + ' h'
          : "les gains de <b>toute ton \u00e9quipe</b> comptent double pendant " + BOOST_HEURES + " heures",
        PRIX.boost, 'data-boost="1"', false)
    + article("\u{1F500}", "Changer d'\u00e9quipe",
        "\u00e9change avec un adversaire <b>tir\u00e9 au sort</b>", PRIX.swap, 'data-swap="1"', false)
    + '<p class="hint">Ces LP comptent dans le <b>score de ton équipe</b>, pas dans ton classement individuel — celui-là reste du pur LP Riot. Le doublement suit la même règle, et ne double que les gains.</p>'
    + '<h4>Tes derniers mouvements</h4>'
    + (mouvements.length
        ? '<div class="ledger">' + mouvements.map(r =>
            '<div class="ledrow"><span class="delta ' + (r.delta > 0 ? "up" : "down") + '">'
            + (r.delta > 0 ? "+" : "\u2212") + orFr(Math.abs(r.delta)) + '</span>'
            + '<span class="ledwhy">' + esc(r.raison) + '</span>'
            + '<span class="ledwhen">' + quand(r.at) + '</span></div>').join("") + '</div>'
        : '<div class="empty">Aucun mouvement pour l\'instant.</div>')
    + '<div class="log" id="shopLog"></div>';

  corps.querySelectorAll("[data-buy]").forEach(b =>
    b.addEventListener("click", () => acheterObjet(b.dataset.buy, b)));
  corps.querySelectorAll("[data-lp]").forEach(b =>
    b.addEventListener("click", () => acheterLp(Number(b.dataset.lp), b)));
  corps.querySelectorAll("[data-boost]").forEach(b =>
    b.addEventListener("click", () => acheterBoost(b)));
  corps.querySelectorAll("[data-swap]").forEach(b =>
    b.addEventListener("click", () => echangerEquipe(b)));
}

async function acheter(fn, args, btn, dire){
  btn.disabled = true;
  say("#shopLog", "Achat en cours\u2026");
  try{
    const { data, error } = await sb.rpc(fn, args);
    if(error) throw new Error(expliquerRpc(error));
    say("#shopLog", dire(data));
    await loadAll();
    renderShop();
  }catch(e){
    say("#shopLog", e.message || String(e), true);
    btn.disabled = false;
  }
}

function acheterObjet(cle, btn){
  const it = S.items.find(i => i.key === cle);
  acheter("shop_buy_item", { p_item: cle }, btn,
    () => (it ? it.name : "Objet") + " ajouté à ta réserve.");
}

function acheterLp(lp, btn){
  acheter("shop_buy_lp", { p_lp: lp }, btn,
    r => lp + " LP crédités à ton équipe pour " + orFr((r && r.prix) || 0) + " or.");
}

// « 1 h 47 » / « 23 min » : ce qu'il reste de bonus.
function resteBoost(fin){
  const ms = Math.max(0, fin - Date.now());
  const m = Math.round(ms / 60000);
  return m >= 60 ? Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") : m + " min";
}

function acheterBoost(btn){
  acheter("shop_buy_boost", {}, btn,
    r => "Double LP actif pour toute ton équipe jusqu'à "
       + new Date(r.boost_until).toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit" })
       + ". Seuls les gains comptent double.");
}

/* Le changement d'équipe est irréversible et coûte très cher : on le
   fait confirmer, en disant bien que la cible est tirée au sort. */
function echangerEquipe(btn){
  const moi = myPlayer();
  if(!moi) return;
  const camp = moi.team === "a" ? S.challenge.team_b_name : S.challenge.team_a_name;
  if(!confirm("Changer d'équipe pour " + orFr(PRIX.swap) + " or ?\n\n"
    + "Tu rejoins " + camp + ", et un joueur de ce camp — TIRÉ AU SORT, tu ne le choisis pas — "
    + "prend ta place.\n\nTous tes LP suivent ta nouvelle équipe. C'est irréversible.")) return;

  acheter("shop_swap_team", {}, btn,
    r => "Échange fait : tu pars avec " + (r && r.autre ? r.autre : "un adversaire") + ".");
}

/* Le journal s'ouvre et se ferme comme le règlement, mais par la droite. */
function openWar(open){
  if(open){ openShop(false); openItems(false); }  // un seul volet à la fois
  $("#warDrawer").classList.toggle("open", open);
  $("#warDrawer").setAttribute("aria-hidden", String(!open));
  $("#warScrim").hidden = !open;
  if(open) renderWarlog();
}

function openRules(open){
  $("#rulesDrawer").classList.toggle("open", open);
  $("#rulesDrawer").setAttribute("aria-hidden", String(!open));
  $("#rulesScrim").hidden = !open;
  if(open) renderRules();
}

/* ===================================================================
   Actions
=================================================================== */
function say(sel, msg, bad){
  const el = $(sel);
  el.classList.toggle("bad", !!bad);
  el.textContent = msg;
}

async function releasePlayer(id){
  const { error } = await sb.from("players").update({ claimed_by: null }).eq("id", id);
  say("#adminLog", error ? "Erreur : " + error.message : "Profil libéré.", !!error);
  await loadAll();
}

async function removeGame(id){
  if(!confirm("Supprimer cette ligne ? Elle ne sera pas réimportée : son identifiant Riot reste connu.")) return;
  const { error } = await sb.from("games").delete().eq("id", id);
  if(error) return say("#entryLog", "Suppression refusée : " + error.message, true);
  await loadAll();
  say("#entryLog", "Ligne supprimée.");
}

/* Relance un relevé si le dernier date de plus de 3 minutes. On n'attend
   pas la réponse : le temps réel ramènera les nouvelles parties. C'est la
   roue de secours si la tâche planifiée tombe. */
/* Le serveur refuse un relevé lancé moins de 90 s après le précédent
   (riot_try_start_sync). On n'essaie donc pas de deviner autre chose :
   on lit l'heure du dernier relevé et on dit ce qu'il reste à attendre. */
/* Le bouton est toujours cliquable : aucun compte à rebours ne le
   bloque. C'est le serveur qui décide s'il y a lieu de relancer un
   relevé (riot_try_start_sync, 30 s) ; quand il refuse, le bouton
   répond « Déjà à jour » du tac au tac. Un refus instantané vaut mieux
   qu'un bouton éteint qu'on regarde décompter.

   Le garde-fou n'a pas disparu, il a changé de place : il n'est plus
   dans l'interface, il est là où il protège vraiment — le quota Riot. */

// On laisse le résultat lisible avant de rendre au bouton son libellé.
let resultatVisibleJusqua = 0;

function majBoutonRefresh(){
  const b = $("#btnRefresh");
  if(!b || b.classList.contains("spinning")) return;
  if(Date.now() < resultatVisibleJusqua) return;
  b.disabled = false;
  $("#refreshLbl").textContent = "Actualiser";
  b.title = "Relever les parties chez Riot maintenant";
}

async function refreshNow(){
  const b = $("#btnRefresh");
  if(b.disabled) return;
  b.classList.add("spinning");
  b.disabled = true;
  $("#refreshLbl").textContent = "Relevé…";
  try{
    const r = await callRiot("sync");
    // Le temps réel ramène déjà les nouvelles lignes ; loadAll rattrape le
    // cas où la souscription n'est pas établie.
    await loadAll();
    if(r && r.skipped) $("#refreshLbl").textContent = "Déjà à jour";
    else if(r && r.games)  $("#refreshLbl").textContent = r.games + " partie" + (r.games > 1 ? "s" : "");
    else $("#refreshLbl").textContent = "À jour";
  }catch(e){
    $("#refreshLbl").textContent = "Échec";
    b.title = e.message || String(e);
  }finally{
    b.classList.remove("spinning");
    // Rendu cliquable des la reponse : seul le libelle attend, pour
    // qu'on ait le temps de lire le resultat. Un deuxieme clic dans la
    // foulee doit partir.
    b.disabled = false;
    resultatVisibleJusqua = Date.now() + 2500;
    setTimeout(majBoutonRefresh, 2600);
  }
}

function nudgeSync(){
  if(!sb || !S.ready) return;
  const last = S.sync && S.sync.last_run ? new Date(S.sync.last_run).getTime() : 0;
  if(Date.now() - last < 300e3) return;   // meme cadence que la tache planifiee : 5 min
  sb.functions.invoke("riot", { body: { action: "sync" } }).catch(() => {});
}

async function saveChallenge(){
  const { error } = await sb.from("challenge").update({
    name: $("#aName").value.trim() || "SoloQ Challenge",
    start_date: $("#aStart").value,
    days: Math.max(1, Math.min(365, parseInt($("#aDays").value,10) || 21)),
    team_a_name: $("#aTeamA").value.trim() || "Équipe A",
    team_b_name: $("#aTeamB").value.trim() || "Équipe B"
  }).eq("id", 1);
  say("#adminLog", error ? "Erreur : " + error.message : "Réglages enregistrés.", !!error);
  await loadAll();
}

async function savePlayers(){
  const rows = [...$("#aPlayers").querySelectorAll("tr")];
  for(const tr of rows){
    const { error } = await sb.from("players").update({
      name: tr.querySelector(".pn").value.trim(),
      tag:  tr.querySelector(".pt").value.trim(),
      team: tr.querySelector(".pteam").value
    }).eq("id", tr.dataset.id);
    if(error){ say("#adminLog", "Erreur : " + error.message, true); return; }
  }
  say("#adminLog", "Joueurs enregistrés.");
  await loadAll();
}

/* ===================================================================
   Câblage
=================================================================== */
// Les deux boutons LP doivent refléter l'état réel après une bascule
// de mode, sinon ils mentiraient sur ce qui est tracé.
/* Le rang ne se trace qu'à deux conditions : en mode joueurs, et en LP
   nets. Une équipe n'a pas de rang chez Riot, et un rang reconstitué
   sur des LP d'objets ne correspondrait à rien de réel.

   Hors mode joueurs la case disparaît ; en LP globaux elle reste
   visible mais éteinte, avec la raison en infobulle — la masquer
   laisserait croire qu'elle a disparu pour de bon. */
function majCaseRang(){
  const w = $("#rankWrap"), c = $("#rankMode");
  if(!w || !c) return;

  w.hidden = chartMode !== "players";
  const possible = chartMode === "players" && chartLp === "net";
  c.disabled = !possible;
  w.classList.toggle("off", !possible);
  w.title = possible
    ? "Tracer le rang chez Riot — Fer, Bronze, Or… — plutôt que les LP cumulés"
    : "Le rang ne se trace qu'en LP nets : un rang calculé avec les LP d'objets ne correspondrait à rien chez Riot.";

  if(!possible) chartRank = false;
  c.checked = chartRank;
}

function majSegLp(){
  const n = $("#lpNet"), t = $("#lpTotal");
  if(!n || !t) return;
  n.setAttribute("aria-pressed", String(chartLp === "net"));
  t.setAttribute("aria-pressed", String(chartLp === "total"));
}

function segment(aSel, bSel, onA, onB){
  const a = $(aSel), b = $(bSel);
  a.addEventListener("click", () => { a.setAttribute("aria-pressed","true"); b.setAttribute("aria-pressed","false"); onA(); });
  b.addEventListener("click", () => { b.setAttribute("aria-pressed","true"); a.setAttribute("aria-pressed","false"); onB(); });
}

function initUI(){
  $("#fPlayer").addEventListener("change", () => renderEntry());
  segment("#suiviHist", "#suiviInv",
    () => { suiviVue = "hist"; majVueSuivi(); },
    () => { suiviVue = "inv";  majVueSuivi(); });
  majVueSuivi();
  // Le délai d'annulation s'écoule : on redessine la grille chaque
  // seconde tant qu'un objet armé est encore reprenable.
  setInterval(() => {
    const mine = myPlayer();
    if(!mine || !S.ready) return;
    const chaud = S.inventory.some(r => r.player_id === mine.id && !r.used_at && r.locked_at
      && Date.now() - new Date(r.locked_at).getTime() < FENETRE_ANNULE);
    if(chaud) renderItems();
  }, 1000);
  $("#boxOpen").addEventListener("click", ouvrirCoffre);
  $("#btnItems").addEventListener("click", () => openItems(true));
  $("#itemsClose").addEventListener("click", () => openItems(false));
  $("#itemsScrim").addEventListener("click", () => openItems(false));
  $("#tgClose").addEventListener("click", () => { objetAPoser = null; $("#targetDialog").close(); });
  $("#btnRefresh").addEventListener("click", refreshNow);
  // Plus de décompte : on repasse seulement après l'affichage du
  // résultat, d'où un intervalle large.
  setInterval(majBoutonRefresh, 3000);
  setInterval(tickLive, 1000);
  $("#btnShop").addEventListener("click", () => openShop(true));
  $("#shopClose").addEventListener("click", () => openShop(false));
  $("#shopScrim").addEventListener("click", () => openShop(false));
  $("#btnWar").addEventListener("click", () => openWar(true));
  $("#warClose").addEventListener("click", () => openWar(false));
  $("#warRead").addEventListener("click", toutMarquerLu);
  initInfobulles();
  $("#warScrim").addEventListener("click", () => openWar(false));
  $("#btnRules").addEventListener("click", () => openRules(true));
  $("#rulesClose").addEventListener("click", () => openRules(false));
  $("#rulesScrim").addEventListener("click", () => openRules(false));
  document.addEventListener("keydown", e => {
    if(e.key === "Escape" && $("#itemsDrawer").classList.contains("open")) openItems(false);
    if(e.key === "Escape" && $("#shopDrawer").classList.contains("open")) openShop(false);
    if(e.key === "Escape" && $("#warDrawer").classList.contains("open")) openWar(false);
    if(e.key === "Escape" && $("#rulesDrawer").classList.contains("open")) openRules(false);
  });

  setInterval(tickCountdown, 1000);        // à la seconde : c'est tout l'intérêt
  setInterval(() => { if(S.ready){ renderSyncStatus(); nudgeSync(); } }, 60000);
  $("#aSaveChallenge").addEventListener("click", saveChallenge);
  $("#aSavePlayers").addEventListener("click", savePlayers);

  $("#btnLogin").addEventListener("click", async () => {
    const { error } = await sb.auth.signInWithOAuth({
      provider: "discord",
      options: { redirectTo: window.location.origin + window.location.pathname }
    });
    if(error) fatal("<b>Connexion impossible</b><br>" + esc(error.message) + "<br>Vérifie que le provider Discord est activé dans Supabase &gt; Authentication &gt; Providers.");
  });
  $("#btnLogout").addEventListener("click", async () => { await sb.auth.signOut(); });
  $("#btnClaim").addEventListener("click", () => {
    claimDismissed = false;
    const dlg = $("#claimDialog");
    if(!dlg.open) dlg.showModal();
  });
  $("#claimDialog").addEventListener("close", () => { claimDismissed = true; });

  $("#regId").addEventListener("input", () => {
    const v = $("#regId").value.trim(), cut = v.lastIndexOf("#");
    $("#regIdNote").classList.toggle("bad", !!v && (cut < 1 || cut === v.length - 1));
  });
  $("#regGo").addEventListener("click", register);
  $("#regId").addEventListener("keydown", e => { if(e.key === "Enter") register(); });
  $("#regClose").addEventListener("click", () => {
    const d = $("#claimDialog");
    if(d.open) d.close();
    $("#regStep").hidden = false;
    $("#wheelStep").hidden = true;
    $("#wheelResult").hidden = true;
    $("#wheelDone").hidden = true;
  });

  segment("#perAll", "#perWeek",
    () => { period = "all";  render(); },
    () => { period = "week"; render(); });
  initChartZoom();
  segment("#chartPlayers", "#chartTeams",
    // On bascule aussi la lecture des LP : en joueurs c'est le net qui
    // classe, en équipes c'est le global qui compte. Rien n'empêche de
    // changer ensuite, les deux boutons restent libres.
    () => { chartMode = "players"; chartLp = "net";   hidden = new Set(); majSegLp(); majCaseRang(); renderChart(); },
    // Le rang n'existe pas pour une équipe : on le retire en passant.
    () => { chartMode = "teams";   chartLp = "total"; chartRank = false; hidden = new Set(); majSegLp(); majCaseRang(); renderChart(); });

  $("#rankMode").addEventListener("change", e => {
    chartRank = e.target.checked;
    majCaseRang();
    renderChart();
  });
  majCaseRang();
  segment("#lpNet", "#lpTotal",
    () => { chartLp = "net";   majCaseRang(); renderChart(); },
    // Le rang n'a plus de sens en LP globaux : on le coupe en passant.
    () => { chartLp = "total"; chartRank = false; majCaseRang(); renderChart(); });
}

async function boot(){
  initUI();
  if(!sb) return;
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  await loadAll();
  subscribeRealtime();
  nudgeSync();

  sb.auth.onAuthStateChange(async (_e, session) => {
    S.session = session;
    claimDismissed = false;
    await loadAll();
  });
}
boot();

// --- echafaudage de test, retire apres verification ---
window.__reel = lancerReel;
window.__items = () => S.items;
