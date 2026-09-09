import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const TIERS = [
  ["IRON","Fer"],["BRONZE","Bronze"],["SILVER","Argent"],["GOLD","Or"],
  ["PLATINUM","Platine"],["EMERALD","Émeraude"],["DIAMOND","Diamant"],
  ["MASTER","Maître"],["GRANDMASTER","Grand Maître"],["CHALLENGER","Challenger"]
];
const TIDX = {}; TIERS.forEach(([k],i) => TIDX[k] = i);
const ROMAN = { 1:"I", 2:"II", 3:"III", 4:"IV" };
const APEX = 7;

const toScore = (t,d,lp) => TIDX[t] >= APEX ? 2800 + lp : TIDX[t]*400 + (4-d)*100 + lp;
function fromScore(s){
  s = Math.max(0, Math.round(s || 0));
  if(s >= 2800) return { t:"MASTER", d:1, lp:s-2800 };
  const i = Math.floor(s/400), rest = s - i*400;
  return { t:TIERS[i][0], d:4 - Math.floor(rest/100), lp:rest%100 };
}
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const signed = n => (n>0 ? "+" : n<0 ? "−" : "±") + Math.abs(n);
const iso = d => d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
const emblem = t => "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-shared-components/global/default/" + t.toLowerCase() + ".png";

const S = { challenge:null, players:[], games:[], profiles:[], session:null, me:null };
let gameFilter = "all";

let sb = null;
function fatal(html){ $("#errTxt").innerHTML = html; $("#errBox").hidden = false; }
function gate(html){ $("#gateTxt").innerHTML = html; $("#gateBox").hidden = false; $("#panels").hidden = true; }
function say(sel, msg, bad){
  const el = $(sel);
  el.classList.toggle("bad", !!bad);
  el.textContent = msg;
}

if(!SUPABASE_URL || SUPABASE_URL.includes("xxxxxxxx") || SUPABASE_ANON_KEY.includes("colle-ici")){
  fatal("<b>Configuration incomplète</b><br>Renseigne <code>config.js</code>.");
} else {
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

const isAdmin = () => !!(S.me && S.me.is_admin);
const teamName = t => t === "a" ? S.challenge.team_a_name : S.challenge.team_b_name;
const playerById = id => S.players.find(p => p.id === id);

/* =================================================================== */
async function loadAll(){
  if(!sb) return;
  const [ch, pl, gm, pr] = await Promise.all([
    sb.from("challenge").select("*").eq("id",1).maybeSingle(),
    sb.from("players").select("*").order("sort"),
    sb.from("games").select("*").order("created_at", { ascending:false }),
    sb.from("profiles").select("id, display_name, avatar_url, is_admin")
  ]);
  const err = ch.error || pl.error || gm.error || pr.error;
  if(err) return fatal("<b>Base injoignable</b><br>" + esc(err.message));

  S.challenge = ch.data;
  S.players   = pl.data || [];
  S.games     = gm.data || [];
  S.profiles  = pr.data || [];
  S.me = S.session ? S.profiles.find(p => p.id === S.session.user.id) || null : null;
  render();
}

/* =================================================================== */
function renderAccount(){
  const box = $("#whoBox");
  if(!S.session){
    box.innerHTML = '<span class="lbl">Non connecté</span>';
    $("#btnLogin").hidden = false; $("#btnLogout").hidden = true;
    return;
  }
  $("#btnLogin").hidden = true; $("#btnLogout").hidden = false;
  const name = (S.me && S.me.display_name) || S.session.user.email || "Connecté";
  const av = S.me && S.me.avatar_url ? '<img class="av" src="'+esc(S.me.avatar_url)+'" alt="">' : "";
  box.innerHTML = av + '<span class="name">'+esc(name)+'</span>'
    + (isAdmin() ? '<span class="pill admin">Admin</span>' : '<span class="pill">Sans droits</span>');
}

function render(){
  renderAccount();
  if(!S.session){
    return gate("<b>Connexion requise</b><br>Connecte-toi avec Discord pour accéder à la console.");
  }
  if(!isAdmin()){
    return gate("<b>Accès refusé</b><br>Ton compte n'a pas les droits d'administration."
      + "<br>Dans Supabase → SQL Editor&nbsp;: <code>update public.profiles set is_admin = true where id = '"
      + esc(S.session.user.id) + "';</code>");
  }
  $("#gateBox").hidden = true;
  $("#panels").hidden = false;
  $("#sub").textContent = S.players.length + " joueurs · " + S.games.length + " parties · "
    + S.profiles.filter(p => p.is_admin).length + " administrateur(s)";

  renderChallenge();
  renderPlayers();
  renderGames();
  renderAccounts();
}

function renderChallenge(){
  if(document.activeElement && document.activeElement.closest(".block")) return;
  const c = S.challenge;
  $("#cName").value  = c.name;
  $("#cStart").value = c.start_date;
  $("#cDays").value  = c.days;
  $("#cTeamA").value = c.team_a_name;
  $("#cTeamB").value = c.team_b_name;
}

function tierSelect(cls, sel){
  return '<select class="'+cls+'">' + TIERS.map(([k,fr]) =>
    '<option value="'+k+'"'+(k===sel?" selected":"")+'>'+fr+'</option>').join("") + '</select>';
}

function renderPlayers(){
  $("#pCount").textContent = S.players.length + " joueurs";
  const teamSel = (sel) => '<select class="pteam">'
    + '<option value="a"'+(sel==="a"?" selected":"")+'>'+esc(teamName("a"))+'</option>'
    + '<option value="b"'+(sel==="b"?" selected":"")+'>'+esc(teamName("b"))+'</option></select>';

  $("#pBody").innerHTML = S.players.map(p => {
    const r = fromScore(p.seed_score);
    const prof = p.claimed_by ? S.profiles.find(x => x.id === p.claimed_by) : null;
    const linked = prof
      ? (prof.avatar_url ? '<img class="av" src="'+esc(prof.avatar_url)+'" alt="">' : '')
        + ' <span class="wl">'+esc(prof.display_name || "compte")+'</span>'
      : '<span class="wr">libre</span>';
    return '<tr data-id="'+esc(p.id)+'">'
      + '<td><input type="text" class="pn2" value="'+esc(p.name)+'"></td>'
      + '<td style="width:110px"><input type="text" class="pt2" value="'+esc(p.tag)+'"></td>'
      + '<td style="width:150px">'+teamSel(p.team)+'</td>'
      + '<td style="width:250px"><div class="inline">'
        + '<img class="minicrest" src="'+emblem(r.t)+'" alt="">'
        + tierSelect("ptier", r.t)
        + '<select class="pdiv">' + [1,2,3,4].map(d => '<option value="'+d+'"'+(d===r.d?" selected":"")+'>'+ROMAN[d]+'</option>').join("") + '</select>'
        + '<input type="number" class="plp2" value="'+r.lp+'" min="0" max="2000" style="width:74px">'
      + '</div></td>'
      + '<td>'+linked+'</td>'
      + '<td class="r"><div class="btnrow" style="justify-content:flex-end">'
        + (p.claimed_by ? '<button type="button" class="btn ghost sm release">Délier</button>' : '')
        + '<button type="button" class="btn ghost sm del">Supprimer</button>'
      + '</div></td></tr>';
  }).join("");

  $("#pBody").querySelectorAll(".release").forEach(b =>
    b.addEventListener("click", () => releasePlayer(b.closest("tr").dataset.id)));
  $("#pBody").querySelectorAll(".del").forEach(b =>
    b.addEventListener("click", () => deletePlayer(b.closest("tr").dataset.id)));

  const opts = S.players.map(p => '<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join("");
  const keep = $("#gPlayer").value;
  $("#gPlayer").innerHTML = opts;
  if(keep && S.players.some(p => p.id === keep)) $("#gPlayer").value = keep;

  const kf = $("#gFilter").value;
  $("#gFilter").innerHTML = '<option value="all">Tous les joueurs</option>' + opts;
  $("#gFilter").value = kf && (kf === "all" || S.players.some(p => p.id === kf)) ? kf : "all";

  $("#nTeam").innerHTML = '<option value="a">'+esc(teamName("a"))+'</option><option value="b">'+esc(teamName("b"))+'</option>';
}

function renderGames(){
  const list = gameFilter === "all" ? S.games : S.games.filter(g => g.player_id === gameFilter);
  $("#gCount").textContent = list.length + " parties";
  if(!list.length){ $("#gFeed").innerHTML = '<div class="empty">Aucune partie.</div>'; return; }

  $("#gFeed").innerHTML = list.slice(0, 300).map(g => {
    const p = playerById(g.player_id);
    const bits = [];
    if(g.duo === "team")  bits.push("duo");
    if(g.duo === "enemy") bits.push("duo adverse");
    if(g.steal)           bits.push(g.steal + " sacrifiés → −" + (g.steal*2) + " pour eux");
    return '<div class="row">'
      + '<span class="delta '+(g.lp>=0?"up":"down")+'" style="min-width:52px">'+signed(g.lp)+'</span>'
      + '<span class="wl" style="min-width:130px">'+esc(p ? p.name : g.player_id)+'</span>'
      + '<span class="g">'+esc(g.played_on)+' · '+(g.win?"victoire":"défaite")+(bits.length ? " · "+esc(bits.join(" · ")) : "")+'</span>'
      + '<button type="button" class="x" data-id="'+esc(g.id)+'" aria-label="Supprimer">✕</button></div>';
  }).join("");

  $("#gFeed").querySelectorAll(".x").forEach(b =>
    b.addEventListener("click", () => deleteGame(b.dataset.id)));
}

function renderAccounts(){
  $("#aBody").innerHTML = S.profiles.map(pr => {
    const owned = S.players.find(p => p.claimed_by === pr.id);
    const me = S.session && pr.id === S.session.user.id;
    return '<tr data-id="'+esc(pr.id)+'">'
      + '<td class="avc">'+(pr.avatar_url ? '<img class="av" src="'+esc(pr.avatar_url)+'" alt="">' : '<span class="av ph"></span>')+'</td>'
      + '<td><span class="wl">'+esc(pr.display_name || "—")+'</span>'+(me ? ' <span class="pill">toi</span>' : '')+'</td>'
      + '<td>'+(owned ? '<span class="pill '+owned.team+'">'+esc(owned.name)+'</span>' : '<span class="wr">aucun</span>')+'</td>'
      + '<td class="r"><button type="button" class="btn '+(pr.is_admin?"":"ghost")+' sm toggle"'+(me?" disabled title=\"Tu ne peux pas retirer tes propres droits\"":"")+'>'
        + (pr.is_admin ? "Administrateur" : "Simple joueur") + '</button></td></tr>';
  }).join("");

  $("#aBody").querySelectorAll(".toggle").forEach(b =>
    b.addEventListener("click", () => toggleAdmin(b.closest("tr").dataset.id)));
}

/* ===================== actions ===================== */
async function saveChallenge(){
  const { error } = await sb.from("challenge").update({
    name: $("#cName").value.trim() || "SoloQ Challenge",
    start_date: $("#cStart").value,
    days: Math.max(1, Math.min(365, parseInt($("#cDays").value,10) || 21)),
    team_a_name: $("#cTeamA").value.trim() || "Équipe A",
    team_b_name: $("#cTeamB").value.trim() || "Équipe B"
  }).eq("id", 1);
  say("#cLog", error ? "Erreur : " + error.message : "Enregistré.", !!error);
  await loadAll();
}

async function savePlayers(){
  for(const tr of $("#pBody").querySelectorAll("tr")){
    const t  = tr.querySelector(".ptier").value;
    const d  = parseInt(tr.querySelector(".pdiv").value, 10);
    const lp = parseInt(tr.querySelector(".plp2").value, 10) || 0;
    const { error } = await sb.from("players").update({
      name: tr.querySelector(".pn2").value.trim(),
      tag:  tr.querySelector(".pt2").value.trim(),
      team: tr.querySelector(".pteam").value,
      seed_score: toScore(t, d, lp)
    }).eq("id", tr.dataset.id);
    if(error) return say("#pLog", "Erreur : " + error.message, true);
  }
  say("#pLog", "Joueurs enregistrés.");
  await loadAll();
}

async function addPlayer(){
  const id = $("#nId").value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const name = $("#nName").value.trim();
  if(!id || !name) return say("#pLog", "Il faut au moins un identifiant et un pseudo.", true);
  if(playerById(id)) return say("#pLog", "Cet identifiant est déjà pris.", true);
  const { error } = await sb.from("players").insert({
    id, name, tag: $("#nTag").value.trim(), team: $("#nTeam").value,
    seed_score: 0, sort: S.players.length + 1
  });
  if(error) return say("#pLog", "Erreur : " + error.message, true);
  $("#nId").value = ""; $("#nName").value = ""; $("#nTag").value = "";
  say("#pLog", "Joueur ajouté.");
  await loadAll();
}

async function deletePlayer(id){
  const p = playerById(id);
  const n = S.games.filter(g => g.player_id === id).length;
  if(!confirm("Supprimer " + (p ? p.name : id) + " ?" + (n ? "\n\nSes " + n + " parties seront supprimées aussi." : ""))) return;
  const { error } = await sb.from("players").delete().eq("id", id);
  say("#pLog", error ? "Erreur : " + error.message : "Joueur supprimé.", !!error);
  await loadAll();
}

async function releasePlayer(id){
  const { error } = await sb.from("players").update({ claimed_by: null }).eq("id", id);
  say("#pLog", error ? "Erreur : " + error.message : "Compte délié — le profil peut être réclamé à nouveau.", !!error);
  await loadAll();
}

async function addGame(win){
  const raw = Math.abs(parseInt($("#gLp").value, 10) || 0);
  if(!raw) return say("#gLog", "Indique le nombre de LP.", true);
  const duo = $("#gDuo").value;
  const steal = (duo === "enemy" && win) ? Math.min(Math.abs(parseInt($("#gSteal").value,10) || 0), raw) : 0;
  const { error } = await sb.from("games").insert({
    player_id: $("#gPlayer").value,
    lp: win ? raw : -raw,
    win, duo, steal,
    played_on: $("#gDate").value || iso(new Date())
  });
  say("#gLog", error ? "Erreur : " + error.message : "Partie ajoutée.", !!error);
  await loadAll();
}

async function deleteGame(id){
  const { error } = await sb.from("games").delete().eq("id", id);
  say("#gLog", error ? "Erreur : " + error.message : "Partie supprimée.", !!error);
  await loadAll();
}

async function toggleAdmin(id){
  const pr = S.profiles.find(p => p.id === id);
  if(!pr) return;
  const { error } = await sb.from("profiles").update({ is_admin: !pr.is_admin }).eq("id", id);
  say("#aLog", error ? "Erreur : " + error.message
    : (pr.is_admin ? "Droits retirés à " : "Droits accordés à ") + (pr.display_name || "ce compte") + ".", !!error);
  await loadAll();
}

async function wipeGames(){
  if(!confirm("Supprimer les " + S.games.length + " parties déclarées ?\n\nC'est définitif.")) return;
  if(!confirm("Vraiment ? Tous les scores repartent de zéro.")) return;
  const { error } = await sb.from("games").delete().gte("created_at", "1970-01-01");
  say("#wLog", error ? "Erreur : " + error.message : "Toutes les parties ont été supprimées.", !!error);
  await loadAll();
}

/* ===================== câblage ===================== */
function initUI(){
  $("#gDate").value = iso(new Date());
  $("#cSave").addEventListener("click", saveChallenge);
  $("#pSave").addEventListener("click", savePlayers);
  $("#nAdd").addEventListener("click", addPlayer);
  $("#gWin").addEventListener("click", () => addGame(true));
  $("#gLoss").addEventListener("click", () => addGame(false));
  $("#wipe").addEventListener("click", wipeGames);
  $("#gFilter").addEventListener("change", e => { gameFilter = e.target.value; renderGames(); });
  $("#btnLogin").addEventListener("click", async () => {
    await sb.auth.signInWithOAuth({ provider:"discord",
      options:{ redirectTo: window.location.origin + window.location.pathname } });
  });
  $("#btnLogout").addEventListener("click", async () => { await sb.auth.signOut(); });
}

async function boot(){
  initUI();
  if(!sb) return;
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  await loadAll();
  sb.auth.onAuthStateChange(async (_e, session) => { S.session = session; await loadAll(); });
}
boot();
