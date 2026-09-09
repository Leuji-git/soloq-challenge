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
const rankLabel = r => TIDX[r.t] >= APEX
  ? TIERS[TIDX[r.t]].fr + " " + r.lp + " LP"
  : TIERS[TIDX[r.t]].fr + " " + ROMAN[r.d] + " · " + r.lp + " LP";
const shortRank = r => TIDX[r.t] >= APEX ? TIERS[TIDX[r.t]].fr : TIERS[TIDX[r.t]].fr + " " + ROMAN[r.d];

// Écussons de rang officiels servis par Community Dragon.
// Ce jeu-ci est en 500x500 cadré sur l'écusson et couvre les 10 paliers,
// Émeraude compris — contrairement à `ranked-emblem` (visuel 2560x1440,
// illisible en petit) et à `ranked-mini-crests` (Émeraude manquant).
const emblem = t => "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-shared-components/global/default/" + t.toLowerCase() + ".png";
const dpmUrl = p => "https://dpm.lol/" + encodeURIComponent(p.name) + "-" + encodeURIComponent(p.tag);

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const signed = n => (n>0 ? "+" : n<0 ? "−" : "±") + Math.abs(n);
const deltaHtml = n => '<span class="delta '+(n>0?"up":n<0?"down":"flat")+'">'+signed(n)+'</span>';
const iso = d => d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");

/* ===================================================================
   État
=================================================================== */
const S = {
  challenge: null,
  players: [],
  games: [],
  syncs: {},
  profiles: {},     // id du compte -> { display_name, avatar_url, is_admin }
  bets: {},         // id joueur -> pari ouvert
  session: null,
  profile: null,
  ready: false
};
let claimDismissed = false;
let period = "all";
let chartMode = "players";
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
  const [ch, pl, gm, sy, pr, bt] = await Promise.all([
    sb.from("challenge").select("*").eq("id",1).maybeSingle(),
    sb.from("players").select("*").order("sort"),
    sb.from("games").select("*").order("created_at"),
    sb.from("rank_syncs").select("*"),
    sb.from("profiles").select("id, display_name, avatar_url, is_admin"),
    sb.from("pending_bets").select("*")
  ]);
  const err = ch.error || pl.error || gm.error || sy.error || pr.error || bt.error;
  if(err){
    fatal("<b>Base injoignable</b><br>" + esc(err.message) + "<br>Vérifie que <code>supabase/schema.sql</code> a bien été exécuté dans le SQL Editor.");
    return;
  }
  S.challenge = ch.data || { name:"SoloQ Challenge", start_date:iso(new Date()), days:21, team_a_name:"Équipe A", team_b_name:"Équipe B" };
  S.players = pl.data || [];
  S.games   = gm.data || [];
  S.syncs    = Object.fromEntries((sy.data||[]).map(r => [r.player_id, r]));
  S.profiles = Object.fromEntries((pr.data||[]).map(r => [r.id, r]));
  S.profile  = S.session ? (S.profiles[S.session.user.id] || null) : null;
  S.bets     = Object.fromEntries((bt.data||[]).map(r => [r.player_id, r]));
  S.ready = true;
  $("#errBox").hidden = true;
  render();
}

function subscribeRealtime(){
  if(!sb) return;
  sb.channel("board")
    .on("postgres_changes", { event:"*", schema:"public", table:"games" },      loadAll)
    .on("postgres_changes", { event:"*", schema:"public", table:"players" },    loadAll)
    .on("postgres_changes", { event:"*", schema:"public", table:"rank_syncs" }, loadAll)
    .on("postgres_changes", { event:"*", schema:"public", table:"challenge" },  loadAll)
    .on("postgres_changes", { event:"*", schema:"public", table:"pending_bets" }, loadAll)
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
  const net = games.reduce((a,g) => a + g.lp, 0);
  const w = games.filter(g => g.win).length;
  const byDay = {};
  games.forEach(g => { const d = dayOf(g.played_on); byDay[d] = (byDay[d]||0) + g.lp; });
  let best = null;
  Object.keys(byDay).forEach(k => { if(!best || byDay[k] > best.lp) best = { day:+k, lp:byDay[k] }; });
  return { player:p, all, games, net, w, l:games.length - w, best };
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
   Duo adverse : le pari.
   La mise est posée AVANT la partie (table pending_bets), puis elle
   change de camp selon le résultat. Elle ne touche jamais au compteur
   individuel : seuls les scores d'équipe bougent.
   MISE_MAX est le seul curseur d'équilibrage.
------------------------------------------------------------------ */
const MISE_MAX = 50;
const MISE_MIN = 5;    // une mise à 0 ne serait pas un pari (voir supabase/bet-required.sql)

const stakeOf = g => (g.duo === "enemy") ? Math.max(0, Math.min(g.stake || 0, MISE_MAX)) : 0;

/* Le gain est linéaire, la perte ne l'est pas : miser gros double la
   facture. À 50 (le maximum), on gagne 50 mais on en perd 100.
   perte = mise x (1 + mise / MISE_MAX) */
const betLoss = st => Math.round(st * (1 + st / MISE_MAX));

// Impact d'une partie sur les deux scores d'équipe.
function impact(g){
  const st = stakeOf(g);
  if(!st) return { mine: g.lp, theirs: 0 };
  if(g.win) return { mine: g.lp + st, theirs: -st };
  const l = betLoss(st);
  return { mine: g.lp - l, theirs: l };
}

/* Le score d'équipe n'est PLUS la somme des LP nets de ses membres :
   les paris déplacent des points d'un camp à l'autre. */
function teamScores(){
  const from = windowStart();
  const out = { a:0, b:0, won:0, lost:0 };
  S.games.forEach(g => {
    if(dayOf(g.played_on) < from) return;
    const p = S.players.find(x => x.id === g.player_id);
    if(!p) return;
    const other = p.team === "a" ? "b" : "a";
    const im = impact(g);
    out[p.team] += im.mine;
    out[other]  += im.theirs;
    const st = stakeOf(g);
    if(st){ if(g.win) out.won += st; else out.lost += st; }
  });
  return out;
}

function estRank(p){
  const g = gamesOf(p.id);
  const sync = S.syncs[p.id];
  let score, after;
  if(sync){ score = sync.score; after = new Date(sync.synced_at).getTime(); }
  else    { score = p.seed_score; after = 0; }
  g.forEach(x => { if(new Date(x.created_at).getTime() > after) score += x.lp; });
  return fromScore(Math.max(0, score));
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

/* Avant le jour J : jours en gros, heures en petit juste à côté. */
function tickCountdown(){
  if(!S.challenge) return;
  const small = $("#clocksmall");
  if(started()){ small.textContent = ""; return; }
  let ms = startDate() - new Date();
  if(ms < 0) ms = 0;
  $("#clockbig").firstChild.nodeValue = Math.floor(ms / 86400000) + " j";
  small.textContent = (Math.floor(ms / 3600000) % 24) + " h";
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
  const bits = [];
  if(ts.won)  bits.push(ts.won + " LP de paris remportés");
  if(ts.lost) bits.push(ts.lost + " LP de paris perdus");
  $("#leadTxt").innerHTML = lead + (bits.length ? ' <span class="raid">· ' + bits.join(" · ") + '</span>' : "");
}

function renderRosters(states){
  const mine = myPlayer();
  $("#rosters").innerHTML = ["a","b"].map(tk => {
    const tname = tk === "a" ? S.challenge.team_a_name : S.challenge.team_b_name;
    const ms = states.filter(s => s.player.team === tk).sort((x,y) => y.net - x.net);
    const total = teamScores()[tk];
    const played = ms.reduce((acc,s) => acc + s.games.length, 0);
    return '<div class="roster '+tk+'">'
      + '<header><span class="tname '+tk+'">'+esc(tname)+'</span><span class="lbl">'+played+' parties · '+signed(total)+' LP</span></header>'
      + '<ul>' + (ms.length ? ms.map(s => {
          const r = estRank(s.player);
          return '<li'+(mine && mine.id === s.player.id ? ' class="me"' : '')+'>' + crest(r)
            + '<div style="min-width:0">' + nameLink(s.player)
            + '<div class="psub">'+esc(rankLabel(r))+(s.player.claimed_by ? "" : " · profil libre")+'</div></div>'
            + '<div class="pright">'+deltaHtml(s.net)+'<span class="plp">'+s.w+'V '+s.l+'D</span></div></li>';
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

  return '<span class="wl num bigwr">' + global + '</span>'
       + (d ? '<span class="duowr">' + d.pct + '% avec toi</span>' : '')
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
  return gs.map(g => ({ t: tsOf(g), y: (run += g.lp) }));
}
// Paliers cumulés d'une équipe, paris compris.
function teamPoints(tk){
  const evts = [];
  S.games.forEach(g => {
    const p = S.players.find(x => x.id === g.player_id);
    if(!p) return;
    const im = impact(g);
    const d = (p.team === tk) ? im.mine : im.theirs;
    if(d) evts.push({ t: tsOf(g), d });
  });
  evts.sort((a,b) => a.t - b.t);
  let run = 0;
  return evts.map(e => ({ t: e.t, y: (run += e.d) }));
}

// Valeur au temps t0, puis tracé en escalier jusqu'à t1.
function valueAt(pts, t){
  let y = 0;
  for(const p of pts){ if(p.t > t) break; y = p.y; }
  return y;
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

  const series = chartMode === "players"
    ? S.players.map(p => ({ key:p.id, label:p.name, color:TEAM_COLOR[p.team], pts:playerPoints(p.id) }))
    : ["a","b"].map(tk => ({
        key: tk,
        label: tk === "a" ? S.challenge.team_a_name : S.challenge.team_b_name,
        color: TEAM_COLOR[tk],
        pts: teamPoints(tk)
      }));

  const vis = series.filter(s => !hidden.has(s.key));

  // L'axe vertical se recalcule sur ce qui est visible : c'est ce qui
  // donne du relief quand on zoome sur une soirée.
  const ys = [0];
  vis.forEach(s => {
    ys.push(valueAt(s.pts, t0));
    s.pts.filter(p => p.t > t0 && p.t <= t1).forEach(p => ys.push(p.y));
  });
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const amp = hi - lo;
  const pad = Math.max(20, amp * 0.18);
  const grain = amp > 400 ? 50 : amp > 120 ? 20 : 10;
  lo = Math.floor((lo - pad) / grain) * grain;
  hi = Math.ceil((hi + pad) / grain) * grain;
  if(hi === lo) hi = lo + grain * 4;

  const X = t => PL + ((t - t0) / (t1 - t0)) * (W - PL - PR);
  const Y = v => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);

  let out = "";
  const vStep = Math.max(grain, Math.ceil((hi - lo) / 6 / grain) * grain);
  for(let v = Math.ceil(lo / vStep) * vStep; v <= hi; v += vStep){
    const y = Y(v);
    out += '<line x1="'+PL+'" y1="'+y.toFixed(1)+'" x2="'+(W-PR)+'" y2="'+y.toFixed(1)+'" stroke="var(--line-soft)" stroke-width="1"/>'
        +  '<text x="'+(PL-10)+'" y="'+(y+4).toFixed(1)+'" text-anchor="end" fill="var(--muted)" font-family="Barlow Semi Condensed" font-size="12">'+(v>0?"+":"")+v+'</text>';
  }
  out += '<line x1="'+PL+'" y1="'+Y(0).toFixed(1)+'" x2="'+(W-PR)+'" y2="'+Y(0).toFixed(1)+'" stroke="var(--line)" stroke-width="1.5"/>';

  const pas = pickStep(t1 - t0);
  axisTicks(t0, t1, pas).forEach(t => {
    const x = X(t);
    out += '<line x1="'+x.toFixed(1)+'" y1="'+PT+'" x2="'+x.toFixed(1)+'" y2="'+(H-PB)+'" stroke="var(--line-soft)" stroke-width="1" opacity=".5"/>'
        +  '<text x="'+x.toFixed(1)+'" y="'+(H-20)+'" text-anchor="middle" fill="var(--muted)" font-family="Barlow Semi Condensed" font-size="12">'+esc(tickLabel(t, pas))+'</text>';
  });

  const jour = new Date(t0).toLocaleDateString("fr-FR", { day:"numeric", month:"long" });
  out += '<text x="'+PL+'" y="'+(H-4)+'" text-anchor="start" fill="var(--muted)" font-family="Barlow Semi Condensed" font-size="11" letter-spacing="1.2">'
       + 'LP NETS CUMULÉS · ' + esc(jour.toUpperCase()) + '</text>';

  vis.forEach(s => {
    out += '<path d="'+stepPath(s.pts, X, Y, t0, t1)+'" fill="none" stroke="'+s.color
        +  '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="'+(chartMode==="players"?0.85:1)+'"/>';
    // Un point par partie : visible dès qu'on zoome assez.
    s.pts.filter(p => p.t >= t0 && p.t <= t1).forEach(p => {
      out += '<circle cx="'+X(p.t).toFixed(1)+'" cy="'+Y(p.y).toFixed(1)+'" r="3" fill="'+s.color+'"/>';
    });
  });

  $("#chart").innerHTML = out;
  $("#zoomLabel").textContent = spanLabel(t1 - t0);

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
function chartTimeAt(clientX){
  const box = $("#chart").getBoundingClientRect();
  const PL = 58, PR = 20, W = 920;
  const x = ((clientX - box.left) / box.width) * W;
  const r = Math.max(0, Math.min(1, (x - PL) / (W - PL - PR)));
  return view.t0 + r * (view.t1 - view.t0);
}
function initChartZoom(){
  const svg = $("#chart");

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
    box.innerHTML = '<span class="lbl">Consultation libre — connecte-toi pour déclarer tes parties</span>';
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
  $("#btnSync").hidden  = !(S.session && myPlayer());
  if(!needed){ if(dlg.open) dlg.close(); return; }
  regPreview();
  if(!dlg.open && !claimDismissed) dlg.showModal();
}

/* ---------- inscription ---------- */
function parseRiotId(v){
  const i = String(v || "").lastIndexOf("#");
  if(i < 1) return null;
  const name = v.slice(0, i).trim();
  const tag  = v.slice(i + 1).trim();
  return (name && tag) ? { name, tag } : null;
}
function regRank(){
  const t = $("#regTier").value;
  const d = parseInt($("#regDiv").value, 10);
  const lp = Math.max(0, Math.min(2000, parseInt($("#regLp").value, 10) || 0));
  return { t, d, lp };
}
function regPreview(){
  const id = parseRiotId($("#regId").value);
  const r = regRank();
  const apex = TIDX[r.t] >= APEX;
  $("#regDiv").disabled = apex;
  $("#regName").textContent = id ? id.name + " #" + id.tag : "\u2014";
  $("#regRank").textContent = rankLabel(r);
  $("#regCrest").innerHTML = '<img src="' + emblem(r.t) + '" alt="">';
  $("#regIdNote").classList.toggle("bad", !!$("#regId").value && !id);
}

function slugify(v){
  return String(v).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "joueur";
}

async function register(){
  const id = parseRiotId($("#regId").value);
  if(!id) return say("#claimLog", "Indique ton pseudo complet, avec le # (ex. Pseudo#EUW).", true);
  if($("#regLp").value === "") return say("#claimLog", "Indique tes LP actuels.", true);

  const r = regRank();
  let slug = slugify(id.name + "-" + id.tag);
  if(S.players.some(p => p.id === slug)) slug += "-" + Math.random().toString(36).slice(2, 5);

  $("#regGo").disabled = true;
  say("#claimLog", "Cr\u00e9ation du profil\u2026");

  const { data, error } = await sb.from("players").insert({
    id: slug,
    name: id.name,
    tag: id.tag,
    team: "a",                       // ignor\u00e9 : la base tranche
    seed_score: toScore(r.t, TIDX[r.t] >= APEX ? 1 : r.d, r.lp),
    claimed_by: S.session.user.id,
    sort: S.players.length + 1
  }).select().single();

  $("#regGo").disabled = false;
  if(error) return say("#claimLog", "Impossible : " + error.message, true);

  say("#claimLog", "");
  await loadAll();
  spinWheel(data.team);
}

/* ---------- roulette : elle r\u00e9v\u00e8le, elle ne d\u00e9cide pas ---------- */
function spinWheel(team){
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

  // derni\u00e8re cellule de la bonne \u00e9quipe, loin dans la bande
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

  setTimeout(() => {
    const res = $("#wheelResult");
    res.hidden = false;
    res.className = "wheelresult " + team;
    res.innerHTML = "Tu rejoins <b>" + esc(names[team]) + "</b>";
    $("#wheelTitle").textContent = "Ton \u00e9quipe";
    $("#wheelDone").hidden = false;
  }, 4400);
}

/* ---------- duo : partenaire à taguer + état du pari ---------- */
const MODES = {
  solo:  { label:"Avec qui ?",   hint:"Une partie classée jouée seul. Renseigne les LP gagnés ou perdus, c'est tout." },
  team:  { label:"Avec qui ?",   hint:"Duo avec quelqu'un de ton équipe. Tague-le : ça alimente vos winrates communs. Rien d'autre ne change." },
  enemy: { label:"Contre qui ?", hint:"Duo avec quelqu'un d'en face : le pari est obligatoire. Tout se passe sur l'écran de pari, adversaire compris." }
};

function setDuo(mode){
  $("#fDuo").value = mode;
  document.querySelectorAll(".mode").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.duo === mode)));
  duoUI();
}

function duoUI(){
  const duo = $("#fDuo").value;
  const t = targetPlayer();
  const m = MODES[duo] || MODES.solo;

  const enemy = duo === "enemy";
  // En duo adverse, tout passe par l'écran de pari : on retire le reste.
  $("#lpWrap").hidden      = enemy;
  $("#winWrap").hidden     = enemy;
  $("#lossWrap").hidden    = enemy;
  $("#partnerWrap").hidden = enemy || duo === "solo";
  $("#partnerLabel").textContent = m.label;
  // En duo adverse on ne laisse que le bouton : pas de texte autour.
  $("#modeHint").textContent = m.hint;
  $("#modeHint").hidden = enemy;

  if(duo === "team" && t){
    const pool = S.players.filter(p => p.id !== t.id
      && (duo === "team" ? p.team === t.team : p.team !== t.team));
    const keep = $("#fPartner").value;
    $("#fPartner").innerHTML = pool.length
      ? pool.map(p => '<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join("")
      : '<option value="">Personne dans cette équipe</option>';
    if(keep && pool.some(p => p.id === keep)) $("#fPartner").value = keep;
  }

  const bet = t ? S.bets[t.id] : null;
  $("#betCta").hidden = !(enemy && t && !bet);
}

/* ------------------------------------------------------------------
   Écran de pari bloquant : tant qu'une mise est ouverte, on ne fait
   rien d'autre que déclarer le résultat.
------------------------------------------------------------------ */
function renderBetLock(){
  const t = myPlayer();
  const bet = t ? S.bets[t.id] : null;
  const dlg = $("#betDialog");

  if(!bet){
    if(dlg.open && !$("#betStep2").hidden) dlg.close();
    return;
  }

  const us   = t.team === "a" ? S.challenge.team_a_name : S.challenge.team_b_name;
  const them = t.team === "a" ? S.challenge.team_b_name : S.challenge.team_a_name;
  const partner = S.players.find(p => p.id === bet.partner_id);
  const perte = betLoss(bet.stake);

  $("#lockAmount").textContent  = bet.stake;
  $("#lockAgainst").textContent = partner ? "En duo contre " + partner.name : "Adversaire non précisé";
  $("#lockWin").textContent  = "Gagné · " + us + " " + signed(bet.stake) + " · " + them + " " + signed(-bet.stake);
  $("#lockLoss").textContent = "Perdu · " + us + " " + signed(-perte)    + " · " + them + " " + signed(perte);

  $("#betStep1").hidden = true;
  $("#betStep2").hidden = false;
  $("#betCloseRow").hidden = true;          // pas de croix : l'écran est bloqué
  if(!dlg.open) dlg.showModal();
}

async function resolveBet(win){
  const t = myPlayer();
  const bet = t ? S.bets[t.id] : null;
  if(!bet) return;
  const raw = Math.abs(parseInt($("#betLpIn").value, 10) || 0);
  if(!raw)      return say("#betLog2", "Indique le nombre de LP de la partie.", true);
  if(raw > 200) return say("#betLog2", "200 LP maximum pour une partie.", true);

  const btns = [$("#betResWin"), $("#betResLoss")];
  btns.forEach(b => b.disabled = true);
  const { error } = await sb.from("games").insert({
    player_id: t.id,
    lp: win ? raw : -raw,
    win: win,
    duo: "enemy",
    stake: bet.stake,
    partner_id: bet.partner_id,
    played_on: iso(new Date())
  });
  btns.forEach(b => b.disabled = false);
  if(error) return say("#betLog2", "Erreur : " + error.message, true);

  await sb.from("pending_bets").delete().eq("player_id", t.id);
  await loadAll();
  const gain = win ? bet.stake : -betLoss(bet.stake);
  say("#entryLog", win
    ? "Pari remporté : " + bet.stake + " LP pris à l'équipe adverse."
    : "Pari perdu : " + betLoss(bet.stake) + " LP cédés à l'équipe adverse.");
}

async function abortBet(){
  const t = myPlayer();
  if(!t) return;
  if(!confirm("Annuler ce pari sans déclarer de résultat ?")) return;
  const { error } = await sb.from("pending_bets").delete().eq("player_id", t.id);
  if(error) return say("#betLog2", "Erreur : " + error.message, true);
  await loadAll();
}

function targetPlayer(){
  if(isAdmin() && $("#fPlayer").value) return S.players.find(p => p.id === $("#fPlayer").value) || myPlayer();
  return myPlayer();
}

function renderEntry(){
  const block = $("#entryBlock");
  const mine = myPlayer();
  if(!S.session || (!mine && !isAdmin())){ block.hidden = true; return; }
  if(!started() && !isAdmin()){ block.hidden = true; return; }
  block.hidden = false;

  const wrap = $("#adminPickWrap");
  wrap.hidden = !isAdmin();
  if(isAdmin()){
    const cur = $("#fPlayer").value;
    $("#fPlayer").innerHTML = S.players.map(p => '<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join("");
    $("#fPlayer").value = cur && S.players.some(p => p.id === cur) ? cur : (mine ? mine.id : (S.players[0] && S.players[0].id));
  }

  const t = targetPlayer();
  $("#entryFor").textContent = t ? t.name : "—";
  duoUI();
  renderFeed(t);
}

/* Photo Discord cerclée de la couleur de l'équipe.
   Sans compte lié, on retombe sur l'initiale du pseudo. */
function avatarRing(p, opts){
  opts = opts || {};
  if(!p) return '<span class="pav ghost" aria-hidden="true"></span>';
  const prof = p.claimed_by ? S.profiles[p.claimed_by] : null;
  const url  = prof && prof.avatar_url ? prof.avatar_url : null;
  const title = p.name + " #" + p.tag;
  return '<span class="pav ' + p.team + (opts.lg ? " lg" : "") + '" title="' + esc(title) + '">'
    + (url ? '<img src="' + esc(url) + '" alt="' + esc(p.name) + '">'
           : '<i>' + esc(p.name.trim().charAt(0).toUpperCase() || "?") + '</i>')
    + '</span>';
}

const heureDe = g => new Date(g.created_at).toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit" });
const jourDe  = g => new Date(g.created_at).toLocaleDateString("fr-FR", { day:"numeric", month:"short" });

function renderFeed(t){
  const box = $("#feed");
  const head = $("#feedTitle");

  if(!t){
    head.textContent = "Historique";
    box.innerHTML = '<div class="empty">Aucun profil sélectionné.</div>';
    return;
  }

  const g = gamesOf(t.id).slice().reverse();
  head.innerHTML = avatarRing(t, { lg:true })
    + '<span class="feedcount">'
    + (g.length ? g.length + (g.length > 1 ? " parties déclarées" : " partie déclarée") : "aucune partie")
    + '</span>';

  if(!g.length){
    box.innerHTML = '<div class="empty">Rien de déclaré pour l\'instant.</div>';
    return;
  }

  box.innerHTML = g.slice(0,80).map(x => {
    const partner = x.partner_id ? S.players.find(q => q.id === x.partner_id) : null;
    const st = stakeOf(x);

    let chip = '<span class="tagchip solo">solo</span>';
    if(x.duo === "team")  chip = '<span class="tagchip">duo allié</span>';
    if(x.duo === "enemy") chip = '<span class="tagchip enemy">duo adverse</span>';

    let meta;
    if(st) meta = x.win
      ? "Pari de " + st + " LP remporté · " + signed(st) + " pour l'équipe"
      : "Pari de " + st + " LP perdu · " + signed(-betLoss(st)) + " pour l'équipe";
    else if(partner) meta = "Avec " + partner.name;
    else meta = "Partie solo · jour " + dayOf(x.played_on);

    return '<div class="row">'
      + '<span class="delta ' + (x.lp >= 0 ? "up" : "down") + '">' + signed(x.lp) + '</span>'
      + '<span class="pavpair">' + avatarRing(t) + (partner ? avatarRing(partner) : "") + '</span>'
      + '<div class="rowmain">'
        + '<div class="rowtitle">' + (x.win ? "Victoire" : "Défaite") + chip + '</div>'
        + '<div class="rowmeta">' + esc(meta) + '</div>'
      + '</div>'
      + '<div class="rowtime"><b>' + heureDe(x) + '</b><span>' + jourDe(x) + '</span></div>'
      + '<button type="button" class="x" data-id="' + esc(x.id) + '" aria-label="Supprimer cette partie">✕</button>'
      + '</div>';
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
  renderBetLock();
  renderLadder(states);
  renderChart();
  renderAdmin();
  $("#foot").innerHTML = '© ' + new Date().getFullYear() + ' <b>ChezLesBatards</b> · Tous droits réservés';
}

/* ===================================================================
   Règlement — volet latéral à onglets
=================================================================== */
const RULES = [
  { t:"Le seul score qui compte", h:
    "<p>Le <strong>LP net</strong> : la somme des LP gagnés moins ceux perdus, partie après partie. Tu gagnes une game à +20 ? +20 au compteur. Tu la perds à −18 ? −18.</p>"
  + "<p>Ton rang de départ n'entre pas dans le calcul. Un Argent qui enchaîne bat un Diamant qui stagne.</p>" },

  { t:"Déclaration", h:
    "<p>Chacun saisit ses propres parties. Ton profil est lié à ton compte Discord : tu ne peux écrire que sur ta ligne, et c'est la base de données qui le garantit, pas la page.</p>"
  + "<p>Quand tu joues en duo, <strong>tague la personne</strong> : le classement affiche alors ton winrate avec chacun, à côté de son winrate global.</p>"
  + "<p>Une erreur de saisie se corrige en supprimant la ligne dans ton historique.</p>" },

  { t:"Le duel d'équipes", h:
    "<p>Le score d'une équipe est la somme des LP nets de ses membres, plus ou moins les paris remportés et perdus.</p>"
  + "<p>Une seule mauvaise soirée peut faire basculer la balance : personne n'est jamais à l'abri.</p>" },

  { t:"Le pari du duo adverse", h:
    "<p>Duo avec un coéquipier : rien ne change. Duo avec quelqu'un d'en face : <strong>le pari est obligatoire</strong>. Tu poses une mise de 5 à 50 LP avant de lancer la partie — il n'y a pas d'autre façon de déclarer ce type de partie.</p>"
  + "<p>Le gain est linéaire, la perte ne l'est pas. <strong>Plus tu mises, plus la défaite coûte cher</strong> :</p>"
  + "<table class=\"minitable\"><tr><th>Mise</th><th>Gagné</th><th>Perdu</th></tr>"
  + "<tr><td>10</td><td class=\"g\">+10</td><td class=\"r\">−12</td></tr>"
  + "<tr><td>25</td><td class=\"g\">+25</td><td class=\"r\">−38</td></tr>"
  + "<tr><td>50</td><td class=\"g\">+50</td><td class=\"r\">−100</td></tr></table>"
  + "<p>Le pari se verrouille avant la partie et l'écran reste bloqué jusqu'à ce que tu déclares le résultat : impossible de choisir sa mise une fois l'issue connue.</p>" },

  { t:"Ce qui compte", h:
    "<p>File <strong>Solo/Duo classée</strong> uniquement — ni Flex, ni ARAM. Le duo est autorisé, avec un coéquipier comme avec un adversaire. Les placements ne rapportent rien tant que le rang n'est pas attribué.</p>"
  + "<p>Le rang affiché est une <em>estimation</em> reconstruite depuis tes LP ; recale-le quand tu veux, ça ne touche pas à ton score.</p>" },

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
function openRules(open){
  $("#rulesDrawer").classList.toggle("open", open);
  $("#rulesDrawer").setAttribute("aria-hidden", String(!open));
  $("#rulesScrim").hidden = !open;
  if(open) renderRules();
}

/* ===================================================================
   Ouverture du pari
=================================================================== */
function openBetDialog(){
  const t = targetPlayer();
  if(!t) return;
  const pool = S.players.filter(p => p.team !== t.team);
  $("#betPartner").innerHTML = pool.length
    ? pool.map(p => '<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join("")
    : '<option value="">Aucun adversaire inscrit</option>';
  dialValue = Math.max(MISE_MIN, 10);
  $("#betStep1").hidden = false;
  $("#betStep2").hidden = true;
  $("#betCloseRow").hidden = false;
  drawDial();
  say("#betLog", "");
  const d = $("#betDialog");
  if(!d.open) d.showModal();
}

/* ===================================================================
   Cadran de mise — arc de 270°, de 0 à MISE_MAX
=================================================================== */
const DIAL = { cx:130, cy:130, r:96, a0:135, sweep:270 };
let dialValue = 10;

function dialPoint(deg){
  const a = deg * Math.PI / 180;
  return [DIAL.cx + DIAL.r * Math.cos(a), DIAL.cy + DIAL.r * Math.sin(a)];
}
function arcPath(fromDeg, toDeg){
  const [x0,y0] = dialPoint(fromDeg), [x1,y1] = dialPoint(toDeg);
  const large = (toDeg - fromDeg) > 180 ? 1 : 0;
  return "M " + x0.toFixed(1) + " " + y0.toFixed(1)
       + " A " + DIAL.r + " " + DIAL.r + " 0 " + large + " 1 " + x1.toFixed(1) + " " + y1.toFixed(1);
}
function drawDial(){
  const t = dialValue / MISE_MAX;
  const end = DIAL.a0 + DIAL.sweep * t;
  $("#dialTrack").setAttribute("d", arcPath(DIAL.a0, DIAL.a0 + DIAL.sweep));
  $("#dialFill").setAttribute("d", t > 0.001 ? arcPath(DIAL.a0, end) : "M 0 0");
  const [kx,ky] = dialPoint(end);
  $("#dialKnob").setAttribute("cx", kx.toFixed(1));
  $("#dialKnob").setAttribute("cy", ky.toFixed(1));

  const t2 = targetPlayer();
  const us   = t2 ? (t2.team === "a" ? S.challenge.team_a_name : S.challenge.team_b_name) : "Toi";
  const them = t2 ? (t2.team === "a" ? S.challenge.team_b_name : S.challenge.team_a_name) : "Eux";
  // Au centre : court, pour ne jamais déborder du cercle.
  $("#dialValue").textContent = dialValue;
  const perte = betLoss(dialValue);
  $("#dialWin").textContent  = signed(dialValue) + " si tu gagnes";
  $("#dialLoss").textContent = signed(-perte)    + " si tu perds";
  // Le détail par équipe a de la place sous le cadran.
  $("#dialWinDetail").textContent  = "Gagné · " + us + " " + signed(dialValue) + " · " + them + " " + signed(-dialValue);
  $("#dialLossDetail").textContent = "Perdu · " + us + " " + signed(-perte)    + " · " + them + " " + signed(perte);
  $("#dial").setAttribute("aria-valuenow", dialValue);
  $("#dial").setAttribute("aria-valuetext", dialValue + " LP misés");
}
function setDialFromPointer(ev){
  const box = $("#dial").getBoundingClientRect();
  const scale = 260 / box.width;
  const x = (ev.clientX - box.left) * scale - DIAL.cx;
  const y = (ev.clientY - box.top)  * scale - DIAL.cy;
  let deg = Math.atan2(y, x) * 180 / Math.PI;
  if(deg < 0) deg += 360;
  if(deg < DIAL.a0) deg += 360;
  const t = Math.max(0, Math.min(1, (deg - DIAL.a0) / DIAL.sweep));
  dialValue = Math.max(MISE_MIN, Math.round(t * MISE_MAX));
  drawDial();
}

/* ===================================================================
   Actions
=================================================================== */
function say(sel, msg, bad){
  const el = $(sel);
  el.classList.toggle("bad", !!bad);
  el.textContent = msg;
}

async function claim(id){
  const { error } = await sb.from("players").update({ claimed_by: S.session.user.id }).eq("id", id).is("claimed_by", null);
  if(error) return say("#claimLog", "Impossible : " + error.message, true);
  await loadAll();
  say("#claimLog", "Profil réclamé.");
}

async function releasePlayer(id){
  const { error } = await sb.from("players").update({ claimed_by: null }).eq("id", id);
  say("#adminLog", error ? "Erreur : " + error.message : "Profil libéré.", !!error);
  await loadAll();
}

async function addGame(win){
  const t = targetPlayer();
  if(!t) return say("#entryLog", "Réclame d'abord ton profil joueur.", true);
  const raw = Math.abs(parseInt($("#fLp").value, 10) || 0);
  if(!raw) return say("#entryLog", "Indique le nombre de LP de la partie.", true);
  if(raw > 200) return say("#entryLog", "200 LP maximum pour une partie.", true);

  const duo = $("#fDuo").value;
  if(duo === "enemy"){
    return say("#entryLog", "Le duo adverse passe par un pari : ouvre-le avant de jouer.", true);
  }
  const partner = duo === "solo" ? null : ($("#fPartner").value || null);

  const btns = [$("#fWin"), $("#fLoss")];
  btns.forEach(b => b.disabled = true);
  const { error } = await sb.from("games").insert({
    player_id: t.id,
    lp: win ? raw : -raw,
    win: win,
    duo: duo,
    stake: 0,
    partner_id: partner,
    played_on: iso(new Date())
  });
  btns.forEach(b => b.disabled = false);

  if(error){
    const denied = /row-level security|violates/i.test(error.message);
    return say("#entryLog", denied
      ? "Refusé par la base : tu ne peux déclarer des parties que pour ton propre profil."
      : "Erreur : " + error.message, true);
  }
  await loadAll();
  say("#entryLog", (win ? "Victoire " : "Défaite ") + signed(win ? raw : -raw) + " LP enregistrée pour " + t.name + ".");
}

async function removeGame(id){
  const { error } = await sb.from("games").delete().eq("id", id);
  if(error) return say("#entryLog", "Suppression refusée : " + error.message, true);
  await loadAll();
  say("#entryLog", "Partie supprimée.");
}

async function lockBet(){
  const t = targetPlayer();
  if(!t) return say("#betLog", "Crée d'abord ton profil joueur.", true);
  $("#betLock").disabled = true;
  const { error } = await sb.from("pending_bets")
    .insert({ player_id: t.id, partner_id: $("#betPartner").value || null, stake: dialValue });
  $("#betLock").disabled = false;
  if(error) return say("#betLog", "Impossible : " + error.message, true);
  say("#betLog", "");
  await loadAll();   // renderBetLock() bascule l'écran sur l'étape 2
}

async function syncRank(){
  const t = targetPlayer();
  if(!t) return say("#entryLog", "Réclame d'abord ton profil joueur.", true);
  const score = toScore($("#fTier").value, parseInt($("#fDiv").value,10), parseInt($("#fRankLp").value,10) || 0);
  const { error } = await sb.from("rank_syncs")
    .upsert({ player_id: t.id, score, synced_at: new Date().toISOString() }, { onConflict:"player_id" });
  if(error) return say("#entryLog", "Refusé : " + error.message, true);
  await loadAll();
  say("#entryLog", "Rang recalé pour " + t.name + " — le total de LP nets est inchangé.");
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
function segment(aSel, bSel, onA, onB){
  const a = $(aSel), b = $(bSel);
  a.addEventListener("click", () => { a.setAttribute("aria-pressed","true"); b.setAttribute("aria-pressed","false"); onA(); });
  b.addEventListener("click", () => { b.setAttribute("aria-pressed","true"); a.setAttribute("aria-pressed","false"); onB(); });
}

function initUI(){
  const tierOpts = TIERS.map(t => '<option value="'+t.k+'">'+t.fr+'</option>').join("");
  $("#fTier").innerHTML = tierOpts;
  $("#fTier").value = "GOLD";
  $("#regTier").innerHTML = tierOpts;
  $("#regTier").value = "GOLD";
  $("#fWin").addEventListener("click", () => addGame(true));
  $("#fLoss").addEventListener("click", () => addGame(false));
  $("#fLp").addEventListener("keydown", e => { if(e.key === "Enter") addGame(true); });
  $("#fSync").addEventListener("click", syncRank);
  $("#fPlayer").addEventListener("change", () => { renderEntry(); duoUI(); });
  document.querySelectorAll(".mode").forEach(b =>
    b.addEventListener("click", () => setDuo(b.dataset.duo)));
  $("#btnRules").addEventListener("click", () => openRules(true));
  $("#rulesClose").addEventListener("click", () => openRules(false));
  $("#rulesScrim").addEventListener("click", () => openRules(false));
  document.addEventListener("keydown", e => {
    if(e.key === "Escape" && $("#rulesDrawer").classList.contains("open")) openRules(false);
  });
  $("#betLock").addEventListener("click", lockBet);
  $("#betResWin").addEventListener("click", () => resolveBet(true));
  $("#betResLoss").addEventListener("click", () => resolveBet(false));
  $("#betAbort").addEventListener("click", abortBet);
  // Échap ne ferme pas un pari verrouillé.
  $("#betDialog").addEventListener("cancel", e => {
    if(!$("#betStep2").hidden) e.preventDefault();
  });
  $("#betOpenBtn").addEventListener("click", openBetDialog);

  const dial = $("#dial");
  let dragging = false;
  dial.addEventListener("pointerdown", e => {
    dragging = true; dial.setPointerCapture(e.pointerId); setDialFromPointer(e);
  });
  dial.addEventListener("pointermove", e => { if(dragging) setDialFromPointer(e); });
  dial.addEventListener("pointerup", () => { dragging = false; });
  dial.addEventListener("pointercancel", () => { dragging = false; });
  dial.addEventListener("keydown", e => {
    const step = e.shiftKey ? 5 : 1;
    if(e.key === "ArrowRight" || e.key === "ArrowUp"){   dialValue = Math.min(MISE_MAX, dialValue + step); drawDial(); e.preventDefault(); }
    if(e.key === "ArrowLeft"  || e.key === "ArrowDown"){ dialValue = Math.max(MISE_MIN, dialValue - step);  drawDial(); e.preventDefault(); }
    if(e.key === "Home"){ dialValue = MISE_MIN; drawDial(); e.preventDefault(); }
    if(e.key === "End"){  dialValue = MISE_MAX; drawDial(); e.preventDefault(); }
  });
  setInterval(tickCountdown, 60000);   // jours + heures : inutile de battre la seconde
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
  $("#btnSync").addEventListener("click", () => {
    const t = myPlayer();
    if(t){
      const r = estRank(t);
      $("#fTier").value = r.t;
      $("#fDiv").value = r.d;
      $("#fRankLp").value = r.lp;
    }
    const d = $("#syncDialog");
    if(!d.open) d.showModal();
  });

  ["#regId", "#regTier", "#regDiv", "#regLp"].forEach(sel =>
    $(sel).addEventListener("input", regPreview));
  $("#regTier").addEventListener("change", regPreview);
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
    () => { chartMode = "players"; hidden = new Set(); renderChart(); },
    () => { chartMode = "teams";   hidden = new Set(); renderChart(); });
}

async function boot(){
  initUI();
  if(!sb) return;
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  await loadAll();
  subscribeRealtime();

  sb.auth.onAuthStateChange(async (_e, session) => {
    S.session = session;
    claimDismissed = false;
    await loadAll();
  });
}
boot();
