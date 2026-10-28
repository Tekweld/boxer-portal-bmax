// Preenche REPRESENTANTE nos cards (Indústria/BMAX, em aberto) que têm revenda mas representante vazio,
// com o representante cadastrado da revenda (nome do RD). 28/10/2026 (caso MAQSOLDAS).
//   node scripts/preencher-representante-cards-28-10-2026.js [--aplicar]
require("dotenv").config({ quiet: true });
const fs = require("fs");
const l = require("../src/services/rd.leads.service");
const C = require("../src/config/constants");
const { sbSistemasService: sv } = require("../src/config/supabaseSistemas");

const APLICAR = process.argv.includes("--aplicar");
const vazio = s => !String(s || "").trim() || ["?????", "?", "n/d", "vazio"].includes(String(s).trim().toLowerCase());

(async () => {
    const cad = await sv("/comercial_revendas_bmax?ativo=eq.true&select=nome,nome_rd,rep");
    const opcoesRep = await l.getOpcoesRepresentanteRD();
    const todos = await l.fetchAllDealsAllPipelines();
    const alvos = todos.filter(d => (d._pipelineId === C.RD_PIPELINE_INDUSTRIA || d._pipelineId === C.RD_PIPELINE_BMAX_INTERNO)
        && d.win !== true && d.win !== false && vazio(l.getCustomField(d, "REPRESENTANTE")) && !vazio(l.getCustomField(d, "REVENDA/LOJA")) && l.getCustomField(d, "REVENDA/LOJA") !== "Sem Revenda" && !/^teste|apagar/i.test(String(d.name || "").trim()));
    const plano = [], semRep = [];
    for (const d of alvos) {
        const rev = l.getCustomField(d, "REVENDA/LOJA");
        const rep = await l.resolverRepresentanteDaRevenda(rev, cad);
        const item = { id: d.id || d._id, nome: d.name, revenda: rev, rep };
        if (rep && opcoesRep.some(o => o === rep)) plano.push(item); else semRep.push({ ...item, motivo: rep ? "nome fora da lista do RD" : "revenda sem representante no cadastro" });
    }
    plano.forEach(p => console.log(`${p.nome.slice(0, 40).padEnd(40)} | ${p.revenda.slice(0, 28).padEnd(28)} -> ${p.rep}`));
    console.log("\na preencher:", plano.length, "| sem como preencher:", semRep.length);
    semRep.forEach(p => console.log("  SEM:", p.nome.slice(0, 38), "|", p.revenda, "|", p.motivo, p.rep ? `(${p.rep})` : ""));
    if (!APLICAR) { console.log("(simulação — use --aplicar)"); process.exit(0); }
    fs.writeFileSync(`scripts/backups/preencher-representante-${Date.now()}.json`, JSON.stringify(plano, null, 1));
    let ok = 0, erro = 0;
    for (const p of plano) { try { await l.updateLead(p.id, { data: { custom_fields: { representante: p.rep } } }); ok++; } catch (e) { erro++; console.log("  ERRO", p.nome, String(e.message).slice(0, 100)); } }
    console.log("preenchidos:", ok, "| erros:", erro);
    process.exit(0);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
