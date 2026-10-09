// Même version flottante que le site : les clés publiables récentes
// exigent un client à jour.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ===================================================================
   La Place de Runeterra.

   Tout ce qui décide est en base : les cours sont relevés par
   bourse_tick() toutes les cinq minutes, les ordres passent par des
   fonctions SQL qui recalculent le prix au moment de l'exécution.
   Cette page ne fait que montrer, et transmettre les ordres.
=================================================================== */

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const orFr = n => Math.round(n).toLocaleString("fr-FR").replace(/ /g, " ");
const pctFr = p => (p >= 0 ? "+" : "−") + Math.abs(p).toFixed(2) + " %";

const COULEUR = { a:"#2E9BE0", b:"#E33B3B" };
const RISQUES = {
  prudente:    { barres:1, nom:"Prudente" },
  equilibree:  { barres:2, nom:"Équilibrée" },
  speculative: { barres:3, nom:"Spéculative" }
};
/* Les mêmes sensibilités que prix_indexe() en SQL. Si tu changes l'une,
   change l'autre : la page annoncerait sinon un prix que le serveur ne
   pratique pas. */
const SENSIBILITE = { commun:0.6, coffre:0.8, rare:1.0, legendaire:1.5 };
/* Les memes valeurs que bourse_frais(), bourse_detention() et
   bourse_max_jour() en SQL. C'est le serveur qui refuse ; la page ne
   fait que l'annoncer avant le clic, pour qu'un refus ne soit jamais
   une surprise. */
const FRAIS = 0.02;
const DETENTION_MIN = 30;     // minutes avant de pouvoir revendre
const MAX_JOUR = 12;          // ordres par jour et par joueur

const S = {
  session:null, moi:null, equipes:{ a:"Équipe A", b:"Équipe B" },
  societes:[], cours:{}, positions:[], depeches:[], etat:null, objets:[], ordresJour:0,
  qui:{}, achats:[]
};
let selection = null, fenetre = 36, filtre = "tout";

/* ---------------- chargement ---------------- */
async function charger(){
  const [so, et, po, de, ch, it] = await Promise.all([
    sb.from("bourse_societes").select("*").eq("actif", true).order("sort"),
    sb.from("bourse_etat").select("*").eq("id", 1).maybeSingle(),
    sb.from("bourse_positions").select("*"),
    sb.from("bourse_depeches").select("*").order("at", { ascending:false }).limit(40),
    sb.from("challenge").select("team_a_name,team_b_name").eq("id", 1).maybeSingle(),
    sb.from("items").select("key,name,icon,rarity,price").eq("active", true).order("sort")
  ]);

  if(so.error){
    return fatal("La bourse n'est pas encore en place.<br>Lance <code>supabase/bourse.sql</code> "
      + "dans le SQL Editor.<br><small>" + esc(so.error.message) + "</small>");
  }

  S.societes = so.data || [];
  S.etat = et.data || null;
  S.positions = po.error ? [] : (po.data || []);
  S.depeches = de.error ? [] : (de.data || []);
  S.objets = it.error ? [] : (it.data || []);
  if(ch.data) S.equipes = { a: ch.data.team_a_name, b: ch.data.team_b_name };

  /* Qui est qui, et son avatar Discord. On en a besoin pour poser les
     achats sous les bougies : un pseudo ne se reconnaît pas d'un coup
     d'œil, une photo si. */
  const [jo, pr, ac] = await Promise.all([
    sb.from("players").select("id,name,claimed_by,team"),
    sb.from("profiles").select("id,display_name,avatar_url"),
    sb.from("gold_ledger").select("player_id,delta,raison,at")
      .like("raison", "bourse : achat%").order("at")
  ]);
  const profils = Object.fromEntries((pr.data || []).map(p => [p.id, p]));
  S.qui = Object.fromEntries((jo.data || []).map(p => [p.id, {
    nom: p.name, team: p.team,
    avatar: p.claimed_by && profils[p.claimed_by] ? profils[p.claimed_by].avatar_url : null
  }]));

  /* On relit le journal d'or plutôt que de tenir une table d'ordres :
     il porte déjà tout, et une seconde source finirait par diverger.
     « bourse : achat 30 × SHU » se lit sans ambiguïté. */
  S.achats = (ac.data || []).map(r => {
    const m = /^bourse : achat (\d+) × (\w+)$/.exec(r.raison);
    if(!m) return null;
    return { player_id: r.player_id, nb: +m[1], code: m[2],
             montant: -r.delta,
             slot: Math.floor(new Date(r.at).getTime() / 300000) };
  }).filter(Boolean);

  // L'historique : les quatre cents derniers créneaux suffisent à tous
  // les graphiques, et évitent de rapatrier des milliers de lignes.
  const depuis = (S.etat ? Number(S.etat.slot) : 0) - 400;
  const co = await sb.from("bourse_cours").select("code,slot,o,h,b,c")
    .gte("slot", depuis).order("slot");
  S.cours = {};
  (co.data || []).forEach(r => { (S.cours[r.code] = S.cours[r.code] || []).push(r); });

  if(S.session){
    const me = await sb.from("players").select("*").eq("claimed_by", S.session.user.id).maybeSingle();
    S.moi = me.data || null;
    /* Les ordres du jour se comptent sur le journal d'or, comme le fait
       le serveur. Tenir un second compteur finirait par diverger. */
    if(S.moi){
      const t = new Date(); t.setHours(0, 0, 0, 0);
      const o = await sb.from("gold_ledger").select("id")
        .eq("player_id", S.moi.id).like("raison", "bourse : %").gte("at", t.toISOString());
      S.ordresJour = o.error ? 0 : (o.data || []).length;
    }
  }
  if(!selection && S.societes.length) selection = S.societes[0].code;
}

function fatal(html){
  $("#errBox").hidden = false;
  $("#errTxt").innerHTML = html;
}

/* ---------------- lectures ---------------- */
const soc = c => S.societes.find(x => x.code === c);
const histo = c => S.cours[c] || [];
function cours(c){
  const h = histo(c);
  if(h.length) return h[h.length - 1].c;
  const s = soc(c);
  return s ? Number(s.prix_base) : 0;
}
function veille(c){
  const h = histo(c);
  if(!h.length) return cours(c);
  return h[Math.max(0, h.length - 145)].c;     // douze heures en arrière
}
const variation = c => (cours(c) / veille(c) - 1) * 100;

function indice(){
  if(!S.societes.length) return 1000;
  return S.societes.reduce((a, s) => a + cours(s.code) / Number(s.prix_base), 0)
    / S.societes.length * 1000;
}
function coefPrix(rarete){
  const k = SENSIBILITE[rarete] || 1;
  return Math.max(0.55, Math.min(1.60, 1 + (indice() / 1000 - 1) * k));
}
const prixIndexe = (base, rarete) =>
  Math.max(5, Math.round(base * coefPrix(rarete) / 5) * 5);

const maPosition = c => S.moi
  ? S.positions.find(p => p.player_id === S.moi.id && p.code === c) : null;

/* ---------------- rendu ---------------- */
function badgeRisque(r){
  const R = RISQUES[r] || RISQUES.equilibree;
  let b = "";
  for(let i = 1; i <= 3; i++) b += '<i class="' + (i <= R.barres ? "on" : "") + '"></i>';
  return '<span class="risque ' + esc(r) + '">' + b + R.nom + '</span>';
}

function rendreTape(){
  const un = s => '<span class="tapeitem"><span class="tapenom">' + esc(s.code) + '</span>'
    + '<span class="tapeval">' + cours(s.code).toFixed(1) + '</span>'
    + '<span class="pct ' + (variation(s.code) >= 0 ? "up" : "down") + '">'
    + pctFr(variation(s.code)) + '</span></span>';
  $("#tape").innerHTML = S.societes.map(un).join("") + S.societes.map(un).join("");
}

function rendreValeurs(){
  const liste = S.societes.filter(s => filtre === "tout" || s.risque === filtre);
  $("#nbValeurs").textContent = liste.length + " cotées";
  $("#valeurs").innerHTML = liste.map(s => {
    const p = variation(s.code), pos = maPosition(s.code);
    return '<div class="valeur' + (s.code === selection ? " on" : "") + '" data-code="' + esc(s.code) + '">'
      + '<span><span class="vhaut">'
        + '<span class="vcode" style="background:' + (s.lien ? COULEUR[s.lien] : "#77849A") + '">'
          + esc(s.code) + '</span>'
        + '<span class="vnom">' + esc(s.nom) + '</span></span>'
        + '<span class="vsub">' + badgeRisque(s.risque)
          + '<span>' + esc(s.secteur) + '</span>'
          + (s.lien ? '<span class="lien"><i style="background:' + COULEUR[s.lien] + '"></i>'
                      + esc(S.equipes[s.lien]) + '</span>' : '<span>indépendante</span>')
          + (pos ? '<span style="color:var(--accent)">' + pos.nb + ' en poche</span>' : '')
        + '</span></span>'
      + '<span class="vdroite"><span class="vcours">' + cours(s.code).toFixed(1) + '</span><br>'
        + '<span class="pct ' + (p >= 0 ? "up" : "down") + '">' + pctFr(p) + '</span></span>'
      + '</div>';
  }).join("");
  $$("#valeurs [data-code]").forEach(e =>
    e.addEventListener("click", () => { selection = e.dataset.code; rendre(); }));
}

/* Les chandeliers. Vert quand la bougie monte, rouge quand elle
   descend : la convention se lit sans légende. */
function rendreChandelles(){
  const s = soc(selection);
  if(!s) return;
  const h = histo(selection).slice(-fenetre);
  const svg = $("#chandelles");
  if(!h.length){ svg.innerHTML = ""; return; }

  /* Les achats visibles, regroupés par créneau. On réserve une bande
     en bas du graphique quand il y en a : les poser sur les bougies
     les rendrait illisibles toutes les deux. */
  const parSlot = {};
  S.achats.filter(a => a.code === selection).forEach(a => {
    const i = h.findIndex(c => Number(c.slot) === a.slot);
    if(i >= 0) (parSlot[i] = parSlot[i] || []).push(a);
  });
  const aDesAchats = Object.keys(parSlot).length > 0;

  const W = 900, H = 286, PL = 6, PR = 52, PT = 10, PB = aDesAchats ? 42 : 14;
  const hi = Math.max(...h.map(c => c.h));
  const lo = Math.min(...h.map(c => c.b));
  const pad = (hi - lo) * .08 || 1;
  const Y = p => PT + (1 - (p - (lo - pad)) / ((hi + pad) - (lo - pad))) * (H - PT - PB);
  const pas = (W - PL - PR) / h.length;
  const larg = Math.max(1.5, pas * .62);

  let out = "";
  for(let i = 0; i <= 4; i++){
    const p = (lo - pad) + ((hi + pad) - (lo - pad)) * i / 4, y = Y(p);
    out += '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1)
        +  '" stroke="var(--line-soft)" stroke-width="1" opacity=".55"/>'
        +  '<text x="' + (W - PR + 8) + '" y="' + (y + 4).toFixed(1) + '" fill="var(--muted)"'
        +  ' font-family="Barlow Semi Condensed" font-size="11">' + p.toFixed(1) + '</text>';
  }
  h.forEach((c, i) => {
    const x = PL + i * pas + pas / 2;
    const col = c.c >= c.o ? "var(--up)" : "var(--down)";
    out += '<line x1="' + x.toFixed(1) + '" y1="' + Y(c.h).toFixed(1)
        +  '" x2="' + x.toFixed(1) + '" y2="' + Y(c.b).toFixed(1)
        +  '" stroke="' + col + '" stroke-width="1" opacity=".8"/>'
        +  '<rect x="' + (x - larg / 2).toFixed(1) + '" y="' + Math.min(Y(c.o), Y(c.c)).toFixed(1)
        +  '" width="' + larg.toFixed(1) + '" height="' + Math.max(1.2, Math.abs(Y(c.o) - Y(c.c))).toFixed(1)
        +  '" fill="' + col + '" opacity=".88"/>';
  });
  const der = h[h.length - 1];
  out += '<line x1="' + PL + '" y1="' + Y(der.c).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(der.c).toFixed(1)
      +  '" stroke="var(--accent)" stroke-width="1" stroke-dasharray="3 3" opacity=".75"/>';

  out += rendreAchats(parSlot, h, PL, pas, H, PB, Y);
  svg.innerHTML = out;

  const p = variation(selection);
  $("#chartNom").textContent = s.nom;
  $("#chartCours").textContent = cours(selection).toFixed(1);
  $("#chartPct").className = "pct " + (p >= 0 ? "up" : "down");
  $("#chartPct").textContent = pctFr(p);
  $("#chartSub").innerHTML = badgeRisque(s.risque)
    + '<span>' + esc(s.code) + ' · ' + esc(s.secteur) + '</span>'
    + (s.lien ? '<span class="lien"><i style="background:' + COULEUR[s.lien] + '"></i>liée à '
                + esc(S.equipes[s.lien]) + '</span>'
              : '<span>indépendante du challenge</span>');
  $("#sOuv").textContent  = h[0].o.toFixed(1);
  $("#sHaut").textContent = hi.toFixed(1);
  $("#sBas").textContent  = lo.toFixed(1);
  $("#sAmp").textContent  = ((hi / lo - 1) * 100).toFixed(1) + " %";
}

/* Les achats, posés sous la bougie où ils ont eu lieu.

   On montre QUI est entré, pas combien il a mis. Savoir que trois
   personnes se sont placées sur une valeur est une information de
   marché, que tout le monde mérite ; savoir combien chacune a engagé
   serait regarder dans la bourse du voisin. Seul TON montant t'est
   rendu, parce qu'il est à toi.

   Au-delà de trois acheteurs sur le même créneau, on compte au lieu
   d'empiler : la bande deviendrait une bouillie de vignettes. */
function rendreAchats(parSlot, h, PL, pas, H, PB, Y){
  if(!Object.keys(parSlot).length) return "";
  const R = 7.5, yBande = H - PB + 17;
  let out = "";

  Object.keys(parSlot).forEach(i => {
    const liste = parSlot[i];
    const x = PL + (+i) * pas + pas / 2;
    const bas = Y(h[+i].b);

    // Un trait discret relie l'achat à sa bougie, sinon on ne sait pas
    // à quel moment il se rattache.
    out += '<line x1="' + x.toFixed(1) + '" y1="' + (bas + 3).toFixed(1)
        +  '" x2="' + x.toFixed(1) + '" y2="' + (yBande - R - 2).toFixed(1)
        +  '" stroke="var(--line)" stroke-width="1" stroke-dasharray="2 3" opacity=".7"/>';

    const montre = liste.slice(0, 3);
    montre.forEach((a, k) => {
      const cx = x + (k - (montre.length - 1) / 2) * 17;
      const qui = S.qui[a.player_id] || { nom: a.player_id, avatar: null };
      const moi = S.moi && a.player_id === S.moi.id;
      const cle = "ach" + i + "_" + k;

      const titre = (moi ? "Tu as achet\u00e9 " : esc(qui.nom) + " a achet\u00e9 ")
        + a.nb + " × " + esc(a.code)
        + (moi ? " pour " + orFr(a.montant) + " or" : "");

      out += '<g><title>' + titre + '</title>';
      if(qui.avatar){
        out += '<defs><clipPath id="' + cle + '"><circle cx="' + cx.toFixed(1)
            +  '" cy="' + yBande + '" r="' + R + '"/></clipPath></defs>'
            +  '<image href="' + esc(qui.avatar) + '" x="' + (cx - R).toFixed(1)
            +  '" y="' + (yBande - R) + '" width="' + (R * 2) + '" height="' + (R * 2)
            +  '" clip-path="url(#' + cle + ')" preserveAspectRatio="xMidYMid slice"/>';
      }else{
        out += '<circle cx="' + cx.toFixed(1) + '" cy="' + yBande + '" r="' + R
            +  '" fill="var(--surface-3)"/>'
            +  '<text x="' + cx.toFixed(1) + '" y="' + (yBande + 3.5)
            +  '" text-anchor="middle" font-size="9" fill="var(--muted)"'
            +  ' font-family="Barlow Semi Condensed">' + esc((qui.nom || "?")[0]) + '</text>';
      }
      out += '<circle cx="' + cx.toFixed(1) + '" cy="' + yBande + '" r="' + R
          +  '" fill="none" stroke="' + (moi ? "var(--accent)" : "var(--up)")
          +  '" stroke-width="' + (moi ? 2 : 1.3) + '" opacity=".95"/>';

      // Le montant n'apparaît que sous TON achat.
      if(moi){
        out += '<text x="' + cx.toFixed(1) + '" y="' + (yBande + R + 10)
            +  '" text-anchor="middle" font-size="9.5" fill="var(--accent)"'
            +  ' font-family="Barlow Semi Condensed">' + orFr(a.montant) + '</text>';
      }
      out += '</g>';
    });

    if(liste.length > 3){
      const cx = x + (montre.length - (montre.length - 1) / 2) * 17;
      out += '<g><title>' + (liste.length - 3) + ' autre(s) acheteur(s)</title>'
          +  '<circle cx="' + cx.toFixed(1) + '" cy="' + yBande + '" r="' + R
          +  '" fill="var(--surface-3)" stroke="var(--line)" stroke-width="1"/>'
          +  '<text x="' + cx.toFixed(1) + '" y="' + (yBande + 3.5)
          +  '" text-anchor="middle" font-size="8.5" fill="var(--ink-2)"'
          +  ' font-family="Barlow Semi Condensed">+' + (liste.length - 3) + '</text></g>';
    }
  });
  return out;
}

function rendrePortefeuille(){
  $("#pfQui").textContent = S.moi ? S.moi.name : "";
  if(!S.moi){
    $("#pfOr").textContent = $("#pfTotal").textContent =
      $("#pfInv").textContent = $("#pfPl").textContent = "—";
    $("#positions").innerHTML =
      '<div class="empty" style="font-size:12.5px">Connecte-toi sur le challenge pour investir.</div>';
    return;
  }
  const miennes = S.positions.filter(p => p.player_id === S.moi.id);
  let valeur = 0, investi = 0;
  const lignes = miennes.map(pos => {
    const s = soc(pos.code);
    if(!s) return "";
    const val = pos.nb * cours(pos.code), inv = pos.nb * Number(pos.pru);
    valeur += val; investi += inv;
    const pl = val - inv, plp = inv ? (val / inv - 1) * 100 : 0;
    return '<div class="ligne">'
      + '<span class="vcode" style="background:' + (s.lien ? COULEUR[s.lien] : "#77849A") + '">'
        + esc(s.code) + '</span>'
      + '<span><span class="lnom">' + pos.nb + ' × ' + esc(s.nom) + '</span><br>'
        + '<span class="lsub">PRU ' + Number(pos.pru).toFixed(1) + ' · vaut ' + orFr(val) + ' or</span></span>'
      + '<span class="lpl pct ' + (pl >= 0 ? "up" : "down") + '">' + (pl >= 0 ? "+" : "−")
        + orFr(Math.abs(pl)) + '<br><span style="font-size:11px">' + pctFr(plp) + '</span></span>'
      + '</div>';
  }).filter(Boolean);

  $("#positions").innerHTML = lignes.length ? lignes.join("")
    : '<div class="empty" style="font-size:12.5px">Aucune position. Achète une société pour commencer.</div>';

  const pl = valeur - investi, or = S.moi.gold || 0;
  $("#pfOr").textContent = orFr(or);
  $("#pfTotal").textContent = orFr(or + valeur);
  $("#pfInv").textContent = orFr(investi);
  $("#pfPl").textContent = (pl >= 0 ? "+" : "−") + orFr(Math.abs(pl));
  $("#pfPl").style.color = pl >= 0 ? "var(--up)" : "var(--down)";
}

function rendreDepeches(){
  $("#depeches").innerHTML = S.depeches.length ? S.depeches.map(d => {
    const t = new Date(d.at);
    return '<div class="dep ' + esc(d.genre) + (d.majeur ? " majeur" : "") + '">'
      + '<span class="deph">' + t.getHours() + ":" + String(t.getMinutes()).padStart(2, "0")
      + (d.majeur ? " · exceptionnel" : "") + '</span>'
      + '<b>' + esc(d.titre) + '</b> — ' + esc(d.texte) + '</div>';
  }).join("") : '<div class="empty" style="font-size:12.5px">Rien à signaler.</div>';
}

/* Minutes restantes avant de pouvoir revendre une ligne, 0 si elle est
   libre. Le serveur refusera de toute façon : ceci ne fait que le dire
   avant le clic. */
function verrouRestant(pos){
  if(!pos || !pos.achete_le) return 0;
  const fin = new Date(pos.achete_le).getTime() + DETENTION_MIN * 60000;
  return Math.max(0, Math.ceil((fin - Date.now()) / 60000));
}

function rendreOrdre(){
  const s = soc(selection);
  if(!s) return;
  const q = Math.max(0, parseInt($("#qte").value, 10) || 0);
  const prix = cours(selection);
  const cout = Math.round(prix * q), frais = Math.max(1, Math.round(cout * FRAIS));
  const pos = maPosition(selection);
  const or = S.moi ? (S.moi.gold || 0) : 0;
  const reste = Math.max(0, MAX_JOUR - S.ordresJour);
  const verrou = verrouRestant(pos);

  $("#bAchat").disabled = !S.moi || !q || cout + frais > or || !reste;
  $("#bVente").disabled = !S.moi || !q || !pos || pos.nb < q || !reste || verrou > 0;

  if(!S.moi){
    $("#ordreNote").innerHTML = "Connecte-toi sur le challenge pour passer un ordre.";
    return;
  }
  $("#ordreNote").innerHTML =
      q + ' × ' + esc(s.code) + ' · <b>' + orFr(cout) + ' or</b> + <b>' + orFr(frais)
    + '</b> de frais (2 %) · il te resterait <b>' + orFr(or - cout - frais) + ' or</b>'
    + (pos ? ' · tu en as déjà <b>' + pos.nb + '</b>' : '')
    + '<br><span class="ordrelimites' + (!reste ? " epuise" : "") + '">'
      + (reste ? '<b>' + reste + '</b> ordre' + (reste > 1 ? 's' : '') + ' restant'
                 + (reste > 1 ? 's' : '') + " aujourd'hui"
               : "Tu as usé tes " + MAX_JOUR + " ordres du jour. La bourse rouvre demain.")
      + (verrou > 0
          ? ' · <b class="verrou">revendable dans ' + verrou + ' min</b>'
          : ' · toute ligne se garde ' + DETENTION_MIN + ' min avant revente')
    + '</span>';
}

function rendreIndice(){
  const i = indice(), p = (i / 1000 - 1) * 100;
  $("#indiceVal").textContent = orFr(i);
  $("#indicePct").className = "pct " + (p >= 0 ? "up" : "down");
  $("#indicePct").textContent = pctFr(p);

  const e = $("#etat");
  const sec = S.etat && S.etat.secousse_reste > 0;
  const hausse = sec && S.etat.secousse_genre === "hausse";
  e.className = "etatmarche" + (sec ? " secousse" : "") + (hausse ? " hausse" : "");
  e.innerHTML = '<i></i>' + (sec
    ? (hausse ? "EMBALLEMENT EN COURS" : "SECOUSSE EN COURS")
    : "MARCHÉ OUVERT");

  const h = histo(selection);
  const quand = h.length ? new Date(Number(h[h.length - 1].slot) * 300000) : new Date();
  $("#horloge").textContent = "Dernier relevé " + quand.getHours() + ":"
    + String(quand.getMinutes()).padStart(2, "0");
}

/* Le Commerce suit l'indice : il monte, tout coûte plus cher ; il
   s'effondre, les rayons passent en solde. Plus c'est rare, plus c'est
   cyclique — un légendaire encaisse deux fois et demie plus qu'un
   commun. */
function rendreCommerce(){
  const lot = [{ key:"__coffre", name:"Un coffre", icon:"📦", rarity:"coffre", price:500 }]
    .concat(S.objets.slice(0, 8));
  if(lot.length < 2){ $("#objets").innerHTML = ""; return; }

  const moyen = lot.reduce((a, o) => a + prixIndexe(o.price, o.rarity) / o.price, 0) / lot.length;
  const p = (moyen - 1) * 100;
  $("#indicePrix").innerHTML = '<span class="pct ' + (p > 1 ? "down" : p < -1 ? "up" : "flat") + '">'
    + (p >= 0 ? "+" : "−") + Math.abs(p).toFixed(1) + ' % sur les prix</span>';

  $("#objets").innerHTML = lot.map(o => {
    const prix = prixIndexe(o.price, o.rarity), d = (prix / o.price - 1) * 100;
    const classe = d < -1.5 ? "bas" : d > 1.5 ? "haut" : "plat";
    return '<div class="objet">'
      + '<span class="objico">' + esc(o.icon || "") + '</span>'
      + '<span class="objtxt"><span class="objnom">' + esc(o.name) + '</span>'
        + '<span class="objprix">'
          + (Math.abs(d) > 1.5 ? '<span class="objbase">' + orFr(o.price) + '</span>' : '')
          + '<span class="objnow" style="color:'
            + (d < -1.5 ? "var(--up)" : d > 1.5 ? "var(--down)" : "var(--ink)") + '">'
            + orFr(prix) + ' or</span></span></span>'
      + '<span class="objbadge ' + classe + '">'
        + (classe === "bas" ? "SOLDE" : classe === "haut" ? "+" + d.toFixed(0) + " %" : "—")
      + '</span></div>';
  }).join("");

  $("#commNote").innerHTML = p < -4
    ? "L'indice a chuté : <b>les rayons sont en solde</b>. C'est le moment d'acheter — "
      + "à condition d'avoir gardé de l'or au lieu de tout mettre en bourse."
    : p > 4
      ? "L'indice s'envole : <b>tout coûte plus cher</b>. Les légendaires souffrent le plus, "
        + "le luxe suit les humeurs du marché."
      : "Les prix suivent l'indice. Un commun bouge peu, un légendaire beaucoup : "
        + "<b>plus c'est rare, plus c'est cyclique</b>.";
}

function rendre(){
  rendreTape(); rendreValeurs(); rendreChandelles();
  rendrePortefeuille(); rendreDepeches(); rendreOrdre();
  rendreIndice(); rendreCommerce();
}

/* ---------------- les ordres ---------------- */
function dire(msg, mauvais){
  const l = $("#ordreLog");
  l.textContent = msg;
  l.className = "log" + (mauvais ? " bad" : " ok");
}

async function passer(fn, mot){
  const q = parseInt($("#qte").value, 10) || 0;
  if(!q || !selection) return;
  $("#bAchat").disabled = $("#bVente").disabled = true;
  dire("Ordre en cours…");
  const { data, error } = await sb.rpc(fn, { p_code: selection, p_nb: q });
  if(error){ dire(error.message || String(error), true); rendreOrdre(); return; }

  // Le prix facturé est celui du serveur, pas celui qu'on avait sous
  // les yeux : on le redit, sinon un cours qui a bougé entre le clic et
  // l'exécution passerait pour une erreur.
  if(data.ordres !== undefined) S.ordresJour = data.ordres;
  dire(mot + " " + data.nb + " × " + data.code + " à " + Number(data.prix).toFixed(1)
    + " · frais " + orFr(data.frais) + " or"
    + (data.gain !== undefined ? " · plus-value " + (data.gain >= 0 ? "+" : "−")
        + orFr(Math.abs(data.gain)) + " or" : "")
    + " · il te reste " + orFr(data.or) + " or");
  await charger();
  rendre();
}

/* ===================================================================
   LE TUTORIEL

   Écrit pour quelqu'un qui n'a jamais vu une bourse. Une notion par
   écran, dans l'ordre où on en a besoin : ce qu'on achète, comment lire
   un prix, puis seulement ensuite comment passer un ordre.

   Il s'ouvre tout seul à la première visite, et jamais plus ensuite —
   le bouton reste là pour y revenir.
=================================================================== */
const CLE_TUTO = "soloq.bourse.tuto";

const TUTO = [
  { t:"\u00c0 quoi sert cette page",
    h:"<p>Tu as de l'<b>or</b>, gagn\u00e9 en jouant tes parties. Jusqu'ici il ne servait "
     +"qu'\u00e0 acheter des objets et des coffres. Ici, tu peux le <b>placer</b>.</p>"
     +"<p>Dix soci\u00e9t\u00e9s sont cot\u00e9es. Tu ach\u00e8tes des parts, leur prix monte ou "
     +"descend, et tu revends \u2014 plus cher si tu as eu du nez, moins cher sinon.</p>"
     +"<div class='exemple'>C'est le <b>m\u00eame or</b> que celui du Commerce. Ce que tu "
     +"places ici, tu ne peux pas le d\u00e9penser en objets tant que tu ne l'as pas "
     +"r\u00e9cup\u00e9r\u00e9.</div>" },

  { t:"Lire un prix",
    h:"<p>Chaque soci\u00e9t\u00e9 affiche son <b>cours</b> : ce que vaut une part en ce "
     +"moment. En dessous, le pourcentage dit combien elle a bougé <b>depuis douze "
     +"heures</b>.</p>"
     +"<div class='exemple'>Piltover Tech \u00b7 <b>184,2</b> \u00b7 <span class='vert'>+6,10 %</span><br>"
     +"Une part co\u00fbte 184 or, et elle en valait environ 174 ce matin.</div>"
     +"<p><span class='vert'>Vert</span>, \u00e7a monte. <span class='rouge'>Rouge</span>, "
     +"\u00e7a descend. C'est tout.</p>" },

  { t:"Le graphique",
    h:"<p>Chaque petite barre est un <b>rel\u00e8vement de cinq minutes</b>. Elle raconte "
     +"quatre choses : le prix au d\u00e9but, \u00e0 la fin, le plus haut et le plus bas "
     +"atteints pendant ces cinq minutes.</p>"
     +"<p>Le <b>corps</b> \u00e9pais va du prix de d\u00e9part au prix de fin. S'il est "
     +"<span class='vert'>vert</span>, le prix a fini plus haut qu'il n'avait commenc\u00e9. "
     +"Les <b>traits fins</b> au-dessus et en dessous sont les extr\u00eames.</p>"
     +"<p>Les boutons <b>3 h</b>, <b>12 h</b> et <b>Tout</b> changent la p\u00e9riode "
     +"regard\u00e9e.</p>"
     +"<div class='exemple'>Sous les bougies, les <b>visages</b> de ceux qui ont achet\u00e9 "
     +"\u00e0 ce moment-l\u00e0. Tu vois qui est entr\u00e9 et quand, mais pas combien il a mis \u2014 "
     +"sauf pour <b>tes propres achats</b>, dont le montant s'affiche.</div>" },

  { t:"Le niveau de risque",
    h:"<p>Chaque soci\u00e9t\u00e9 porte une \u00e9tiquette. C'est l'information la plus "
     +"importante de la page.</p>"
     +"<p><b>Prudente</b> \u00b7 bouge lentement. On ne s'enrichit pas vite, on ne perd "
     +"pas gros.</p>"
     +"<p><b>\u00c9quilibr\u00e9e</b> \u00b7 le milieu.</p>"
     +"<p><b>Sp\u00e9culative</b> \u00b7 bouge <b>cinq fois plus</b> qu'une prudente. Dans "
     +"les deux sens.</p>"
     +"<div class='exemple'>Quand le march\u00e9 s'effondre, une prudente perd quelques "
     +"pour cent l\u00e0 o\u00f9 une sp\u00e9culative en perd la moiti\u00e9. Le risque n'est pas "
     +"une d\u00e9coration&nbsp;: c'est un multiplicateur.</div>" },

  { t:"Le lien avec le challenge",
    h:"<p>Six soci\u00e9t\u00e9s sur dix sont <b>li\u00e9es \u00e0 une \u00e9quipe</b>. Leur cours suit les "
     +"LP que cette \u00e9quipe gagne ou perd dans l'heure.</p>"
     +"<p>Acheter une soci\u00e9t\u00e9 li\u00e9e aux Pitoyables, c'est <b>parier sur leur "
     +"soir\u00e9e</b>. Les quatre autres ne dépendent que du march\u00e9, et bougent m\u00eame "
     +"quand personne ne joue.</p>" },

  { t:"Passer un ordre",
    h:"<p>Choisis une soci\u00e9t\u00e9 dans la liste de gauche, tape une <b>quantit\u00e9</b>, "
     +"puis <b>Acheter</b>. Pour r\u00e9cup\u00e9rer ton or, <b>Vendre</b>.</p>"
     +"<p>Il y a <b>2 % de frais</b> à l'achat comme à la vente, et <b>douze ordres "
     +"par jour</b> au maximum. Choisis-les bien.</p>"
     +"<p>Une ligne achetée se garde <b>trente minutes</b> avant de pouvoir être "
     +"revendue. Racheter remet ce délai à zéro sur toute la ligne.</p>"
     +"<div class='exemple'>Ces trois règles visent la même chose : empêcher "
     +"l'aller-retour toutes les cinq minutes, qui transformait la bourse en "
     +"machine à sous. Investir, c'est <b>attendre</b>.</div>"
     +"<div class='exemple'>Le prix qui te sera factur\u00e9 est celui du <b>serveur au "
     +"moment du clic</b>, pas celui affich\u00e9 \u00e0 l'\u00e9cran. Entre les deux, le cours a "
     +"pu bouger. Le message sous le bouton te dit toujours ce qui a r\u00e9ellement "
     +"\u00e9t\u00e9 pr\u00e9lev\u00e9.</div>" },

  { t:"Ton portefeuille",
    h:"<p><b>PRU</b> veut dire prix de revient unitaire&nbsp;: ce que t'a co\u00fbt\u00e9 une "
     +"part en moyenne. Si le cours est au-dessus, tu es gagnant.</p>"
     +"<p>La <b>plus-value</b> est ce que tu gagnerais en vendant tout maintenant. "
     +"Elle monte et descend toute seule.</p>"
     +"<div class='exemple'>Tant que tu n'as pas vendu, <b>tu n'as ni gagn\u00e9 ni "
     +"perdu</b>. Une plus-value de \u2212800 or redevient z\u00e9ro si le cours remonte. "
     +"Elle ne devient vraie qu'au moment o\u00f9 tu vends.</div>" },

  { t:"Les d\u00e9p\u00eaches",
    h:"<p>\u00c0 droite, le fil des nouvelles. Une usine qui ouvre, un directeur qui "
     +"d\u00e9missionne, une enqu\u00eate&nbsp;: chacune pousse une soci\u00e9t\u00e9 dans un sens "
     +"pour un relev\u00e9 ou deux.</p>"
     +"<p>De loin en loin tombe une d\u00e9p\u00eache <b>exceptionnelle</b>, sur fond color\u00e9. "
     +"Krach, euphorie, crise de l'\u00e9nergie. Elles renversent tout pendant une "
     +"demi-heure.</p>"
     +"<div class='exemple'><b>Personne ne les d\u00e9clenche.</b> Ni l'administrateur, "
     +"ni moi. Elles ont une chance sur deux mille \u00e0 chaque relev\u00e9, et on les "
     +"d\u00e9couvre en m\u00eame temps que tout le monde.</div>" },

  { t:"Le Commerce suit la bourse",
    h:"<p>En bas de page, le prix des objets. Il n'est <b>pas fixe</b>&nbsp;: il suit "
     +"l'indice g\u00e9n\u00e9ral.</p>"
     +"<p>Le march\u00e9 monte, tout co\u00fbte plus cher. Le march\u00e9 s'effondre, les rayons "
     +"passent en <b>solde</b>.</p>"
     +"<p>Plus un objet est rare, plus il bouge&nbsp;: un l\u00e9gendaire encaisse deux "
     +"fois et demie plus qu'un commun.</p>"
     +"<div class='exemple'>C'est l\u00e0 qu'un krach devient une occasion. Il ruine ceux "
     +"qui ont tout plac\u00e9, et il offre un l\u00e9gendaire \u00e0 moiti\u00e9 prix \u00e0 celui qui a "
     +"gard\u00e9 de l'or de c\u00f4t\u00e9.</div>" },

  { t:"Trois conseils pour finir",
    h:"<p><b>Ne place pas tout.</b> Sans or disponible, tu ne peux ni profiter des "
     +"soldes ni acheter un objet au bon moment.</p>"
     +"<p><b>Une perte n'existe qu'une fois vendue.</b> Vendre dans la panique, "
     +"c'est transformer une mauvaise journ\u00e9e en perte d\u00e9finitive.</p>"
     +"<p><b>Le risque se choisit.</b> Si tu d\u00e9couvres, commence par une prudente&nbsp;: "
     +"tu verras le m\u00e9canisme sans y laisser ta r\u00e9serve.</p>"
     +"<div class='exemple'>Et souviens-toi que cet or ach\u00e8te des LP et des objets. "
     +"Ce que tu perds ici, tu le perds <b>dans le challenge</b>.</div>" }
];

let tutoPage = 0;

function rendreTuto(){
  const e = TUTO[tutoPage];
  $("#tutoEtape").textContent = "\u00c9tape " + (tutoPage + 1) + " sur " + TUTO.length;
  $("#tutoTitre").textContent = e.t;
  $("#tutoCorps").innerHTML = e.h;
  $("#tutoPoints").innerHTML = TUTO.map((_, i) =>
    '<i class="' + (i === tutoPage ? "on" : "") + '"></i>').join("");
  $("#tutoPrec").disabled = tutoPage === 0;
  $("#tutoSuiv").textContent = tutoPage === TUTO.length - 1 ? "J'ai compris" : "Suivant";
}

function ouvrirTuto(page){
  tutoPage = page || 0;
  rendreTuto();
  const d = $("#tutoDialog");
  if(!d.open) d.showModal();
}

function brancherTuto(){
  $("#btnTuto").addEventListener("click", () => ouvrirTuto(0));
  $("#tutoClose").addEventListener("click", () => $("#tutoDialog").close());
  $("#tutoPrec").addEventListener("click", () => { if(tutoPage > 0){ tutoPage--; rendreTuto(); } });
  $("#tutoSuiv").addEventListener("click", () => {
    if(tutoPage < TUTO.length - 1){ tutoPage++; rendreTuto(); }
    else $("#tutoDialog").close();
  });
  // Les fl\u00e8ches du clavier : on feuillette comme un livre.
  $("#tutoDialog").addEventListener("keydown", ev => {
    if(ev.key === "ArrowRight" && tutoPage < TUTO.length - 1){ tutoPage++; rendreTuto(); }
    if(ev.key === "ArrowLeft"  && tutoPage > 0){ tutoPage--; rendreTuto(); }
  });
  // Une fois vu, on ne le rouvre plus de force.
  $("#tutoDialog").addEventListener("close", () => {
    try{ localStorage.setItem(CLE_TUTO, "vu"); }catch(_){}
  });
}

function tutoDejaVu(){
  try{ return localStorage.getItem(CLE_TUTO) === "vu"; }catch(_){ return false; }
}

/* ---------------- démarrage ---------------- */
function brancher(){
  $("#bAchat").addEventListener("click", () => passer("bourse_acheter", "Achat de"));
  $("#bVente").addEventListener("click", () => passer("bourse_vendre", "Vente de"));
  $("#qte").addEventListener("input", rendreOrdre);
  $$(".qterap button").forEach(b => b.addEventListener("click", () => {
    const or = S.moi ? (S.moi.gold || 0) : 0;
    $("#qte").value = b.dataset.q === "max"
      ? Math.max(1, Math.floor(or / (cours(selection) * (1 + FRAIS)))) : b.dataset.q;
    rendreOrdre();
  }));
  $$(".seg2 button").forEach(b => b.addEventListener("click", () => {
    $$(".seg2 button").forEach(x => x.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", "true");
    fenetre = +b.dataset.vue;
    rendreChandelles();
  }));
  $$(".filtres button").forEach(b => b.addEventListener("click", () => {
    $$(".filtres button").forEach(x => x.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", "true");
    filtre = b.dataset.f;
    rendreValeurs();
  }));
}

async function boot(){
  const { data: { session } } = await sb.auth.getSession();
  S.session = session;
  sb.auth.onAuthStateChange(async (_e, s) => { S.session = s; await charger(); rendre(); });

  brancher();
  brancherTuto();
  await charger();
  rendre();

  // Première visite : on explique avant de laisser quelqu'un engager
  // son or sans savoir ce qu'il fait.
  if(!tutoDejaVu()) ouvrirTuto(0);

  /* Le cron relève les cours toutes les cinq minutes. On pousse quand
     même à l'ouverture de la page : si pg_cron est indisponible sur le
     projet, le marché avance malgré tout dès que quelqu'un regarde.
     bourse_tick est idempotent par créneau, l'appel en trop ne coûte
     rien. */
  if(session){
    try{
      const { data } = await sb.rpc("bourse_tick", { p_max: 24 });
      if(data && data.bougies > 0){ await charger(); rendre(); }
    }catch(_){}
  }

  // Le marché bouge toutes les cinq minutes : un coup d'œil par minute
  // suffit largement, et ménage la base.
  setInterval(async () => { await charger(); rendre(); }, 60000);
}

boot();
