// Passa para PRATA as lojas ativas das 7 revendas que a planilha mestre classifica como Prata (nota 6). Uso: [--aplicar]
const P = "C:/Users/andre.coelho.BXSD/BOXER/Dados - Documentos/Comercial/Geral/Estrategia/2026/Projeto BMax/boxer-portal-bmax";
process.chdir(P);
require(P + "/node_modules/dotenv").config({ quiet: true });
const fs = require("fs");
const K = process.env.SUPABASE_SERVICE_KEY_SISTEMAS;
const H = { apikey: K, Authorization: "Bearer " + K, "Content-Type": "application/json", Prefer: "return=representation" };
const URL = "https://bmepxcnrsofofoswubuu.supabase.co/rest/v1/";
const ZENS = { "48066": "Dsoldas", "42122": "WST", "32052": "Comercial Soldas", "31023": "Suprimig", "42863": "Alphabras", "30204": "Coamassa", "28977": "Via Soldas" };
const APLICAR = process.argv.includes("--aplicar");
(async () => {
  const alvo = new Map();
  for (const [zen, nome] of Object.entries(ZENS)) {
    const r = await (await fetch(URL + `comercial_revendas_bmax?zen_id=eq.${zen}&ativo=eq.true&select=id,nome,grupo,classe,zen_id,user_id`, { headers: H })).json();
    for (const c of r) {
      alvo.set(c.id, { ...c, revenda: nome });
      if (c.grupo) { // mesma revenda = mesmo grupo: todas as lojas ativas do grupo seguem a classe do grupo
        const g = await (await fetch(URL + `comercial_revendas_bmax?grupo=eq.${encodeURIComponent(c.grupo)}&ativo=eq.true&select=id,nome,grupo,classe,zen_id,user_id`, { headers: H })).json();
        g.forEach(x => alvo.set(x.id, { ...x, revenda: nome }));
      }
    }
  }
  const lista = [...alvo.values()];
  console.log("lojas ativas envolvidas:", lista.length);
  lista.forEach(l => console.log(" ", l.revenda.padEnd(17), "|", String(l.nome).slice(0, 44).padEnd(44), "| grupo:", (l.grupo || "-").padEnd(14), "| classe hoje:", l.classe));
  const mudar = lista.filter(l => l.classe !== "Prata");
  console.log("\na mudar para Prata:", mudar.length, "| já Prata:", lista.length - mudar.length);
  const naoOuro = mudar.filter(l => l.classe !== "Ouro");
  if (naoOuro.length) console.log("ATENÇÃO — não são Ouro hoje:", naoOuro.map(l => l.nome + " [" + l.classe + "]").join("; "));
  if (!APLICAR) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(P + "/scripts/backups", { recursive: true });
  const arq = `${P}/scripts/backups/classe-7-revendas-antes-${stamp}.json`;
  fs.writeFileSync(arq, JSON.stringify(mudar, null, 1)); console.log("backup:", arq);
  let feitos = 0;
  for (const l of mudar) {
    const r = await fetch(URL + `comercial_revendas_bmax?id=eq.${l.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ classe: "Prata", editado_em: new Date().toISOString(), editado_por: "planilha-mestre-09-11-2026" }) });
    if (!r.ok) throw new Error("PATCH " + r.status + " " + (await r.text()));
    feitos += (await r.json()).length;
  }
  console.log("lojas alteradas para Prata:", feitos);
  const conf = await Promise.all(lista.map(async l => (await (await fetch(URL + `comercial_revendas_bmax?id=eq.${l.id}&select=nome,classe`, { headers: H })).json())[0]));
  console.log("conferência:", conf.every(c => c.classe === "Prata") ? "todas Prata" : JSON.stringify(conf.filter(c => c.classe !== "Prata")));
  const cont = await (await fetch(URL + "comercial_revendas_bmax?ativo=eq.true&select=classe", { headers: H })).json();
  const t = {}; cont.forEach(c => { t[c.classe] = (t[c.classe] || 0) + 1; });
  console.log("ativas por classe agora:", JSON.stringify(t));
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
