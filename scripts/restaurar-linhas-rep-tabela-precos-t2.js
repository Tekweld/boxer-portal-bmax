// RESTAURA as linhas "REP > IND" e "REP+REV > IND" da Tabela de Preços t=2 (removidas em 09/11/2026 como limpeza).
// Usa o backup scripts/backups/tabela-precos-t2-linhas-REP-removidas.json (guardado localmente; fora do Git).
// Uso: node scripts/restaurar-linhas-rep-tabela-precos-t2.js            -> só mostra o que seria reinserido
//      node scripts/restaurar-linhas-rep-tabela-precos-t2.js --aplicar  -> reinsere (ignora as que já existem)
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const arq = path.join(__dirname, "backups", "tabela-precos-t2-linhas-REP-removidas.json");
const K = process.env.SUPABASE_SERVICE_KEY_SISTEMAS;
const H = { apikey: K, Authorization: "Bearer " + K, "Content-Type": "application/json", Prefer: "return=representation" };
const URL = "https://bmepxcnrsofofoswubuu.supabase.co/rest/v1/comissoes";
(async () => {
  const linhas = JSON.parse(fs.readFileSync(arq, "utf8"));
  const atuais = await (await fetch(URL + "?tabela_id=eq.2&select=id", { headers: H })).json();
  const ids = new Set(atuais.map(a => a.id));
  const faltam = linhas.filter(l => !ids.has(l.id));
  console.log(`backup: ${linhas.length} linhas | já existem: ${linhas.length - faltam.length} | a reinserir: ${faltam.length}`);
  if (!process.argv.includes("--aplicar") || !faltam.length) return;
  const r = await fetch(URL, { method: "POST", headers: H, body: JSON.stringify(faltam) });
  if (!r.ok) throw new Error("POST " + r.status + " " + (await r.text()));
  console.log("reinseridas:", (await r.json()).length);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
