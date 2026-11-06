// Corrige a Tabela de Preços t=2 (tabelas/comissoes no boxer-sistemas) conforme decisões do André de 06/11/2026.
// Uso: node corrige_tabela_precos.js            -> só mostra (simulação)
//      node corrige_tabela_precos.js --aplicar  -> faz backup, aplica e confere
const P = "C:/Users/andre.coelho.BXSD/BOXER/Dados - Documentos/Comercial/Geral/Estrategia/2026/Projeto BMax/boxer-portal-bmax";
process.chdir(P);
require(P + "/node_modules/dotenv").config({ quiet: true });
const fs = require("fs");
const K = process.env.SUPABASE_SERVICE_KEY_SISTEMAS;
const H = { apikey: K, Authorization: "Bearer " + K, "Content-Type": "application/json", Prefer: "return=representation" };
const URL = "https://bmepxcnrsofofoswubuu.supabase.co/rest/v1/";
const get = async q => { const r = await fetch(URL + q, { headers: H }); if (!r.ok) throw new Error(q + " " + r.status); return r.json(); };
const APLICAR = process.argv.includes("--aplicar");
(async () => {
  const todas = await get("comissoes?tabela_id=eq.2&select=*&order=segmento,categoria_grupo,classe");
  console.log("colunas de comissoes:", Object.keys(todas[0]).join(","));
  const revLaser = todas.filter(c => c.segmento === "Revenda" && c.categoria_grupo === "Laser");
  const classe7 = todas.filter(c => c.segmento === "Boxer" && c.categoria_grupo === "Máquinas" && Number(c.classe) === 7);
  const mult7 = await get("multiplicadores?tabela_id=eq.2&classe=eq.7&select=segmento,categoria_grupo,porte,classe&limit=5");
  console.log("Revenda/Laser hoje:", revLaser.map(c => `cl${c.classe}: rep ${c.rep_pct} rev ${c.revenda_pct}`).join(" | "));
  console.log("Boxer/Máquinas classe 7:", classe7.length, "linha(s) | multiplicadores de classe 7 na tabela 2:", mult7.length);
  if (!APLICAR) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(P + "/scripts/backups", { recursive: true });
  const arq = `${P}/scripts/backups/tabela-precos-t2-antes-${stamp}.json`;
  fs.writeFileSync(arq, JSON.stringify({ revLaser, classe7, multiplicadoresClasse7: mult7 }, null, 1));
  console.log("backup:", arq);
  // 1) PCI 14: representante 2% (todas as classes)
  let r = await fetch(URL + "comissoes?tabela_id=eq.2&segmento=eq.Revenda&categoria_grupo=eq.Laser", { method: "PATCH", headers: H, body: JSON.stringify({ rep_pct: 2 }) });
  if (!r.ok) throw new Error("PATCH rep " + r.status + " " + (await r.text())); console.log("rep_pct=2 em", (await r.json()).length, "linhas");
  // 2) cashback da revenda no PCI 14, classe 1: 1,7%
  r = await fetch(URL + "comissoes?tabela_id=eq.2&segmento=eq.Revenda&categoria_grupo=eq.Laser&classe=eq.1", { method: "PATCH", headers: H, body: JSON.stringify({ revenda_pct: 1.7 }) });
  if (!r.ok) throw new Error("PATCH rev " + r.status + " " + (await r.text())); console.log("revenda_pct=1,7 classe 1:", (await r.json()).length, "linha");
  // 3) remove a classe 7 de Boxer/Máquinas
  if (!mult7.length) {
    r = await fetch(URL + "comissoes?tabela_id=eq.2&segmento=eq.Boxer&categoria_grupo=eq.M%C3%A1quinas&classe=eq.7", { method: "DELETE", headers: H });
    if (!r.ok) throw new Error("DELETE " + r.status + " " + (await r.text())); console.log("classe 7 removida:", (await r.json()).length, "linha");
  } else console.log("NÃO removi a classe 7: há multiplicadores de classe 7 na tabela 2 (conferir)");
  const depois = await get("comissoes?tabela_id=eq.2&segmento=eq.Revenda&categoria_grupo=eq.Laser&select=classe,rep_pct,revenda_pct,vendedor_tecnico_pct&order=classe");
  console.log("Revenda/Laser depois:", depois.map(c => `cl${c.classe}: rep ${c.rep_pct} rev ${c.revenda_pct} vt ${c.vendedor_tecnico_pct}`).join(" | "));
  const c7 = await get("comissoes?tabela_id=eq.2&classe=eq.7&select=segmento,categoria_grupo,classe");
  console.log("linhas de classe 7 que restam:", c7.length);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
