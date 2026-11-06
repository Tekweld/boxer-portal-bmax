// Planeja (e opcionalmente aplica) o preenchimento da cobertura de representante. Uso: node planeja_cobertura.js [--aplicar]
const P = "C:/Users/andre.coelho.BXSD/BOXER/Dados - Documentos/Comercial/Geral/Estrategia/2026/Projeto BMax/boxer-portal-bmax";
process.chdir(P);
require(P + "/node_modules/dotenv").config({ quiet: true });
const fs = require("fs");
const K = process.env.SUPABASE_SERVICE_KEY_SISTEMAS;
const H = { apikey: K, Authorization: "Bearer " + K, "Content-Type": "application/json" };
const URL = "https://bmepxcnrsofofoswubuu.supabase.co/rest/v1/";
const g = async q => (await fetch(URL + q, { headers: H })).json();
const APLICAR = process.argv.includes("--aplicar");
(async () => {
  const reps = await g("comercial_representantes_bmax?select=nome,rd_alias,ativo&limit=100");
  console.log("representantes no Portal:", reps.map(r => `${r.nome}${r.rd_alias ? "(RD:" + r.rd_alias + ")" : ""}${r.ativo === false ? "[inativo]" : ""}`).join("; "));
  const cob = []; for (let off = 0; off < 6000; off += 1000) { const p = await g(`comercial_bmax_cobertura?select=ibge_codigo,cidade,estado,mesorregiao,rep_bmax&order=ibge_codigo&limit=1000&offset=${off}`); cob.push(...p); if (p.length < 1000) break; }
  const vazio = c => !c.rep_bmax || !String(c.rep_bmax).trim();
  const plano = []; const pendentes = [];
  for (const uf of ["PR", "GO", "MG", "SC"]) {
    const doUf = cob.filter(c => c.estado === uf);
    const vazios = doUf.filter(vazio);
    const repsUf = [...new Set(doUf.filter(c => !vazio(c)).map(c => c.rep_bmax))];
    for (const c of vazios) {
      let rep = null, motivo = "";
      if (uf === "GO") { rep = "Weberson"; motivo = "representante de GO (mestre/Portal)"; }
      else if (repsUf.length === 1) { rep = repsUf[0]; motivo = "único representante do estado"; }
      else {
        const daMeso = [...new Set(doUf.filter(x => !vazio(x) && x.mesorregiao && x.mesorregiao === c.mesorregiao).map(x => x.rep_bmax))];
        if (c.mesorregiao && daMeso.length === 1) { rep = daMeso[0]; motivo = "único representante da mesorregião"; }
      }
      (rep ? plano : pendentes).push({ ...c, rep, motivo, uf });
    }
  }
  const resumo = {}; plano.forEach(p => { const k = p.uf + " → " + p.rep + " (" + p.motivo + ")"; resumo[k] = (resumo[k] || 0) + 1; });
  console.log("\nPLANO (municípios a preencher):", plano.length); Object.entries(resumo).forEach(([k, v]) => console.log("  ", v, "|", k));
  const pend = {}; pendentes.forEach(p => { const k = p.uf + " / " + (p.mesorregiao || "sem mesorregião"); pend[k] = (pend[k] || 0) + 1; });
  console.log("DEIXADOS PARA DEPOIS (ambíguos):", pendentes.length); Object.entries(pend).forEach(([k, v]) => console.log("  ", v, "|", k));
  if (!APLICAR) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(P + "/scripts/backups", { recursive: true });
  const arq = `${P}/scripts/backups/cobertura-antes-${stamp}.json`;
  fs.writeFileSync(arq, JSON.stringify(plano.map(p => ({ ibge_codigo: p.ibge_codigo, cidade: p.cidade, estado: p.estado, rep_bmax_antes: p.rep_bmax })), null, 1));
  console.log("\nbackup:", arq);
  const porRep = {}; plano.forEach(p => { (porRep[p.rep] = porRep[p.rep] || []).push(p.ibge_codigo); });
  let feitos = 0;
  for (const [rep, ids] of Object.entries(porRep)) for (let i = 0; i < ids.length; i += 150) {
    const lote = ids.slice(i, i + 150);
    const r = await fetch(URL + `comercial_bmax_cobertura?ibge_codigo=in.(${lote.join(",")})&or=(rep_bmax.is.null,rep_bmax.eq.)`, { method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ rep_bmax: rep }) });
    if (!r.ok) throw new Error("PATCH " + r.status + " " + (await r.text()).slice(0, 150));
    feitos += (await r.json()).length;
  }
  console.log("municípios atualizados:", feitos);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
