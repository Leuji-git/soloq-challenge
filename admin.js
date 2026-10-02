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
// Caractères de contrôle invisibles d'un copier-coller Discord (voir app.js).
const cleanRiot = v => String(v ?? "").replace(/[​-‏‪-‮⁠-⁩﻿]/g, "").trim();
const signed = n => (n>0 ? "+" : n<0 ? "−" : "±") + Math.abs(n);
const iso = d => d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
const emblem = t => "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-shared-components/global/default/" + t.toLowerCase() + ".png";

const S = { challenge:null, players:[], games:[], profiles:[], snaps:{}, sync:null, items:[], inventory:[], session:null, me:null };
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
  const [ch, pl, gm, pr, sn, st, it, pi] = await Promise.all([
    sb.from("challenge").select("*").eq("id",1).maybeSingle(),
    sb.from("players").select("*").order("sort"),
    sb.from("games").select("*").order("created_at", { ascending:false }),
    sb.from("profiles").select("id, display_name, avatar_url, is_admin"),
    sb.from("rank_snapshots").select("*"),
    sb.from("sync_state").select("*").eq("id",1).maybeSingle(),
    sb.from("items").select("key,name,icon,rarity,target,effect,active").order("sort"),
    sb.from("player_items").select("*").order("obtained_at")
  ]);
  // items.sql n'est peut-être pas encore lancé : son absence ne doit pas
  // rendre toute la console inutilisable, seulement le bac à sable.
  const err = ch.error || pl.error || gm.error || pr.error || sn.error || st.error;
  if(err) return fatal("<b>Base injoignable</b><br>" + esc(err.message));

  S.challenge = ch.data;
  S.players   = (pl.data || []).map(p => Object.assign({}, p, { name: cleanRiot(p.name), tag: cleanRiot(p.tag) }));
  S.games     = gm.data || [];
  S.profiles  = pr.data || [];
  S.snaps     = Object.fromEntries((sn.data || []).map(r => [r.player_id, r]));
  S.sync      = st.data || null;
  S.items     = it.error ? [] : (it.data || []);
  S.inventory = pi.error ? [] : (pi.data || []);
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
  renderSync();
  renderPlayers();
  renderGames();
  renderAccounts();
  renderSandbox();
}


/* --------------------------- bac à sable ---------------------------
   riot-api.sql a fermé l'écriture des parties au navigateur, et items.sql
   celle des objets : c'est voulu, personne ne doit pouvoir s'inventer des
   LP. Ces trois boutons passent donc par des fonctions SQL réservées à
   l'admin, qui marquent « sim- » tout ce qu'elles écrivent.           */
const RARETE_FR = { commun:"Commun", rare:"Rare", legendaire:"Légendaire" };

function renderSandbox(force){
  // On ne rebat pas les menus pendant que l'admin est dedans — sauf
  // quand il vient lui-même de changer de joueur.
  if(!force && document.activeElement && document.activeElement.closest(".sandbox")) return;

  const joueurs = $("#bPlayer"), choisiJ = joueurs.value;
  joueurs.innerHTML = S.players.map(p =>
    '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join("");
  if(choisiJ) joueurs.value = choisiJ;

  const objets = $("#bItem"), choisiO = objets.value;
  objets.innerHTML = '<option value="">Au hasard (selon la rareté)</option>'
    + S.items.filter(i => i.active !== false).map(i =>
        '<option value="' + esc(i.key) + '">'
        + esc((i.icon ? i.icon + " " : "") + i.name + " — " + (RARETE_FR[i.rarity] || i.rarity))
        + '</option>').join("");
  if(choisiO) objets.value = choisiO;

  // Objets libres du joueur choisi : ni consommés, ni déjà armés.
  const qui = joueurs.value;
  const libres = S.inventory.filter(r => r.player_id === qui && !r.used_at && !r.locked_at);
  const owned = $("#bOwned"), choisiL = owned.value;
  owned.innerHTML = libres.map(r =>
    '<option value="' + esc(r.id) + '">' + esc(nomObjet(r.item_key)) + '</option>').join("")
    || '<option value="">— aucun objet libre —</option>';
  if(choisiL) owned.value = choisiL;

  const cibles = $("#bTarget"), choisiC = cibles.value;
  cibles.innerHTML = S.players.map(p =>
    '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join("");
  if(choisiC) cibles.value = choisiC;

  // Ce qui est déjà armé, pour ne pas chercher pourquoi un effet retombe.
  const arms = S.inventory.filter(r => !r.used_at && r.locked_at);
  const info = $("#bArmed");
  if(info){
    info.textContent = arms.length
      ? "Armé en ce moment : " + arms.map(r => nomObjet(r.item_key) + " → "
          + ((S.players.find(x => x.id === r.target_id) || {}).name || "?")).join(" · ")
      : "Aucun objet armé pour l'instant.";
  }

  if(!S.items.length) say("#bLog", "Catalogue vide : lance supabase/items.sql.", true);
}

// Les fonctions SQL renvoient une erreur parlante : on la montre telle
// quelle plutôt que de la traduire à moitié.
/* Une fonction absente veut dire « script SQL pas encore passé », et
   le message brut de PostgREST ne le dit pas. */
function expliquerRpc(error, fichier){
  const m = error && error.message || "";
  return /schema cache|does not exist|42883/i.test(m)
    ? "Fonction absente : lance supabase/" + fichier + " dans le SQL Editor."
    : (m || "Erreur inconnue.");
}

const FICHIER_DE = {
  lock_item: "objets-effets.sql", unlock_item: "objets-effets.sql",
  admin_grant_item: "bac-a-sable.sql", admin_clear_sim: "bac-a-sable.sql"
};

async function sandbox(fn, args, btnSel, raconter){
  const btn = $(btnSel);
  btn.disabled = true;
  try{
    const { data, error } = await sb.rpc(fn, args);
    if(error) throw new Error(expliquerRpc(error, FICHIER_DE[fn] || "le script correspondant"));
    say("#bLog", raconter(data));
    await loadAll();
  }catch(e){
    say("#bLog", e.message || String(e), true);
  }finally{
    btn.disabled = false;
  }
}

const nomObjet = cle => {
  const i = S.items.find(x => x.key === cle);
  return i ? (i.icon ? i.icon + " " : "") + i.name : cle;
};

function giveItem(){
  const p = $("#bPlayer").value;
  if(!p) return say("#bLog", "Choisis un joueur.", true);
  sandbox("admin_grant_item", { p_player: p, p_item: $("#bItem").value || null },
    "#bGive", cle => "Objet donné : " + nomObjet(cle) + ".");
}

/* La simulation passe par la fonction serveur « riot » et non par du SQL :
   c'est elle qui porte le moteur d'effets, et on veut que le bac à sable
   donne exactement ce que donnera le relèvement réel. */
async function simGame(){
  const p = $("#bPlayer").value;
  if(!p) return say("#bLog", "Choisis un joueur.", true);
  const lp = Number($("#bLp").value);
  if(!Number.isInteger(lp) || lp < -200 || lp > 200)
    return say("#bLog", "Les LP doivent être un entier entre -200 et 200.", true);

  const btn = $("#bPlay");
  btn.disabled = true;
  say("#bLog", "Simulation en cours…");
  try{
    const { data, error } = await sb.functions.invoke("riot", { body: {
      action: "sim", player: p, lp,
      win: $("#bWin").value === "1", duo: $("#bDuo").value,
      champion: $("#bChamp").value.trim() || undefined,
      dureeMin: Number($("#bDur").value) || undefined,
      deaths: $("#bDeaths").value === "" ? undefined : Number($("#bDeaths").value),
      vision: $("#bVision").value === "" ? undefined : Number($("#bVision").value)
    }});
    if(error){
      let msg = error.message;
      try{ const b = await error.context.json(); if(b && b.error) msg = b.error; }catch(_){}
      throw new Error(msg);
    }
    if(data && data.error) throw new Error(data.error);

    const bouts = [signed(data.lp) + " LP nets"];
    if(data.objets && data.objets.length){
      bouts.push("objets " + signed(data.lp_items)
        + " (" + data.objets.map(o => nomObjet(o.itemKey) + " " + signed(o.lp)
            + (o.note ? ", " + o.note : "")).join(" · ") + ")");
      bouts.push("total ressenti " + signed(data.total));
    }
    if(data.butin) bouts.push("butin : " + nomObjet(data.butin));
    say("#bLog", "Partie simulée — " + bouts.join(" · ") + ".");
    await loadAll();
  }catch(e){
    say("#bLog", e.message || String(e), true);
  }finally{
    btn.disabled = false;
  }
}

/* Verrouiller un objet à la place d'un joueur, pour pouvoir essayer les
   effets sans devoir se connecter avec son compte. */
function lockItem(){
  const row = $("#bOwned").value, cible = $("#bTarget").value;
  if(!row)   return say("#bLog", "Ce joueur n'a aucun objet libre en réserve.", true);
  if(!cible) return say("#bLog", "Choisis une cible.", true);
  sandbox("lock_item", { p_item: row, p_target: cible }, "#bLock",
    r => "Objet verrouillé : " + nomObjet(r && r.item_key) + " sur "
       + ((S.players.find(x => x.id === cible) || {}).name || cible) + ".");
}

function clearSim(){
  if(!confirm("Effacer toutes les parties et tous les objets simulés ?\nLes vraies parties ne sont pas touchées.")) return;
  sandbox("admin_clear_sim", {}, "#bClear",
    r => "Effacé : " + (r && r.parties || 0) + " partie(s) simulée(s), "
       + (r && r.objets || 0) + " objet(s)"
       + (r && r.rendus ? ", " + r.rendus + " rendu(s) à la réserve" : "") + ".");
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

function renderSync(){
  const st = S.sync, pill = $("#sPill"), det = $("#sDetail");
  if(!st || !st.last_run){
    pill.className = "syncpill wait"; pill.textContent = "Jamais lancé";
    det.textContent = "Vérifie que la fonction « riot » est déployée et que la tâche planifiée tourne.";
    return;
  }
  const depuis = t => { const m = Math.floor((Date.now() - new Date(t).getTime()) / 60000); return m < 1 ? "à l'instant" : "il y a " + m + " min"; };
  const retard = !st.last_ok || (Date.now() - new Date(st.last_ok).getTime()) > 12 * 60000;
  pill.className = "syncpill " + (st.last_error ? "err" : retard ? "wait" : "ok");
  pill.textContent = st.last_error ? "Perturbé" : retard ? "En retard" : "Opérationnel";
  det.textContent = "Dernier relevé réussi : " + (st.last_ok ? depuis(st.last_ok) : "jamais")
    + (st.last_error ? " · " + st.last_error : "");
  renderKey(st);
}

/* La panne la plus fréquente du challenge : une clé de développement
   meurt toutes les 24 h. Quand elle est refusée, on met les deux liens
   du remplacement sous la main plutôt qu'un message d'erreur à décoder. */
function renderKey(st){
  const box = $("#sKey");
  const hs = st.key_down_since
    ? Math.floor((Date.now() - new Date(st.key_down_since).getTime()) / 3600000) : 0;
  // key_down_since est posé par la fonction ; last_error couvre le cas
  // où le script SQL de l'alerte n'a pas encore été lancé.
  const cassee = !!st.key_down_since || /Clé API Riot refusée|RIOT_API_KEY absent/.test(st.last_error || "");
  box.hidden = !cassee;
  if(!cassee) return;

  // Deux pannes très différentes à réparer : une clé morte se regénère,
  // un secret absent se repose.
  const absent = /RIOT_API_KEY absent/.test(st.last_error || "");
  $("#sKeyTitle").textContent = absent
    ? "Le secret RIOT_API_KEY est absent de la fonction"
    : "La clé API Riot est refusée";
  $("#sKeyWhen").textContent = st.key_down_since
    ? "Le suivi est à l'arrêt depuis " + (hs < 1 ? "moins d'une heure" : hs + " h") + "."
    : "Le suivi est à l'arrêt.";
  $("#sKeyRiot").href = "https://developer.riotgames.com/";
  // Le ref du projet se lit dans l'URL Supabase : pas de valeur à recopier.
  const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
  $("#sKeySb").href = "https://supabase.com/dashboard/project/" + ref + "/settings/functions";
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
    const snap = S.snaps[p.id];
    const prof = p.claimed_by ? S.profiles.find(x => x.id === p.claimed_by) : null;
    const discord = prof
      ? (prof.avatar_url ? '<img class="av" src="'+esc(prof.avatar_url)+'" alt="">' : '')
        + ' <span class="wl">'+esc(prof.display_name || "compte")+'</span>'
      : '<span class="wr">aucun compte Discord</span>';
    const riotOk = !!p.puuid;
    const rang = snap && snap.ranked && snap.tier
      ? '<img class="minicrest" src="'+emblem(snap.tier)+'" alt=""> <span class="wl">'
        + esc(TIERS[TIDX[snap.tier]][1] + (TIDX[snap.tier] >= APEX ? "" : " " + ROMAN[snap.division]) + " · " + snap.lp + " LP")
        + '</span><div class="wr">'+snap.wins+'V '+snap.losses+'D</div>'
      : '<span class="wr">'+(riotOk ? "non classé" : "—")+'</span>';
    // Un compte rattaché porte le pseudo officiel de Riot : on ne le modifie plus.
    const verrou = riotOk ? ' disabled title="Pseudo officiel relevé chez Riot"' : '';
    return '<tr data-id="'+esc(p.id)+'">'
      + '<td><input type="text" class="pn2" value="'+esc(p.name)+'"'+verrou+'></td>'
      + '<td style="width:110px"><input type="text" class="pt2" value="'+esc(p.tag)+'"'+verrou+'></td>'
      + '<td style="width:150px">'+teamSel(p.team)+'</td>'
      + '<td style="width:200px"><div class="inline">'+rang+'</div></td>'
      + '<td>'+(riotOk
          ? '<span class="pill live">Riot rattaché</span>'
          : '<span class="pill">En attente</span><div class="wr">rattaché au prochain relevé si le pseudo est exact</div>')
        + '<div style="margin-top:4px">'+discord+'</div></td>'
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

  const kf = $("#gFilter").value;
  $("#gFilter").innerHTML = '<option value="all">Tous les joueurs</option>' + opts;
  $("#gFilter").value = kf && (kf === "all" || S.players.some(p => p.id === kf)) ? kf : "all";

  $("#nTeam").innerHTML = '<option value="a">'+esc(teamName("a"))+'</option><option value="b">'+esc(teamName("b"))+'</option>';
}

function renderGames(){
  const list = gameFilter === "all" ? S.games : S.games.filter(g => g.player_id === gameFilter);
  $("#gCount").textContent = list.filter(g => g.kind !== "adjust").length + " parties";
  if(!list.length){ $("#gFeed").innerHTML = '<div class="empty">Aucune partie.</div>'; return; }

  $("#gFeed").innerHTML = list.slice(0, 300).map(g => {
    const p = playerById(g.player_id);
    const bits = [];
    if(g.kind === "adjust") bits.push("ajustement hors partie");
    else {
      bits.push(g.win ? "victoire" : "défaite");
      if(g.champion) bits.push(g.champion);
      if(g.duo === "team")  bits.push("duo allié");
      if(g.duo === "enemy") bits.push(g.stake ? "duo adverse, pari " + g.stake + " LP" : "duo adverse sans pari");
      if(g.approx) bits.push("LP estimés");
    }
    return '<div class="row">'
      + '<span class="delta '+(g.lp>=0?"up":"down")+'" style="min-width:52px">'+(g.approx ? "≈" : "")+signed(g.lp)+'</span>'
      + '<span class="wl" style="min-width:130px">'+esc(p ? p.name : g.player_id)+'</span>'
      + '<span class="g">'+esc(g.played_on)+' · '+esc(bits.join(" · "))+'</span>'
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
    const p = playerById(tr.dataset.id);
    const maj = { team: tr.querySelector(".pteam").value };
    if(p && !p.puuid){                       // pseudo modifiable tant que Riot n'est pas rattaché
      maj.name = cleanRiot(tr.querySelector(".pn2").value);
      maj.tag  = cleanRiot(tr.querySelector(".pt2").value);
    }
    const { error } = await sb.from("players").update(maj).eq("id", tr.dataset.id);
    if(error) return say("#pLog", "Erreur : " + error.message, true);
  }
  say("#pLog", "Joueurs enregistrés.");
  await loadAll();
}

async function addPlayer(){
  const id = $("#nId").value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const name = cleanRiot($("#nName").value);
  if(!id || !name) return say("#pLog", "Il faut au moins un identifiant et un pseudo.", true);
  if(playerById(id)) return say("#pLog", "Cet identifiant est déjà pris.", true);
  const { error } = await sb.from("players").insert({
    id, name, tag: cleanRiot($("#nTag").value), team: $("#nTeam").value,
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

async function forceSync(){
  const btn = $("#sForce");
  btn.disabled = true;
  say("#gLog", "Relevé en cours chez Riot…");
  try{
    const { data, error } = await sb.functions.invoke("riot", { body: { action: "sync", force: true } });
    let res = data;
    if(error){
      let msg = error.message;
      try{ const b = await error.context.json(); if(b && b.error) msg = b.error; }catch(_){}
      throw new Error(msg);
    }
    if(res && res.error) throw new Error(res.error);
    if(res && res.skipped){ say("#gLog", "Un relevé est déjà en cours, réessaie dans une minute."); }
    else {
      const parts = [res.games + " partie(s)"];
      if(res.linked)  parts.push(res.linked + " compte(s) rattaché(s)");
      if(res.bets)    parts.push(res.bets + " pari(s) résolu(s)");
      if(res.adjusts) parts.push(res.adjusts + " ajustement(s)");
      if(res.waiting && res.waiting.length) parts.push("en attente : " + res.waiting.join(", "));
      const erreurs = res.errors && res.errors.length ? " — " + res.errors.join(" | ") : "";
      say("#gLog", "Relevé terminé : " + parts.join(", ") + "." + erreurs, !!erreurs);
    }
  }catch(e){
    say("#gLog", "Relevé impossible : " + e.message, true);
  }finally{
    btn.disabled = false;
    await loadAll();
  }
}

async function deleteGame(id){
  if(!confirm("Supprimer cette ligne ? Elle ne sera pas réimportée : son identifiant Riot reste connu.")) return;
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
  $("#cSave").addEventListener("click", saveChallenge);
  $("#pSave").addEventListener("click", savePlayers);
  $("#nAdd").addEventListener("click", addPlayer);
  $("#sForce").addEventListener("click", forceSync);
  $("#sKeyTest").addEventListener("click", forceSync);
  $("#bGive").addEventListener("click", giveItem);
  $("#bPlay").addEventListener("click", simGame);
  $("#bClear").addEventListener("click", clearSim);
  $("#bLock").addEventListener("click", lockItem);
  $("#bPlayer").addEventListener("change", () => renderSandbox(true));
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
