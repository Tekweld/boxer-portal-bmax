// Renomeia REVENDA/LOJA dos cards EM ABERTO (funis Indústria/BMAX) cujo nome não é o de nenhum login do Portal,
// quando o destino é claro (decisão do André, 28/10/2026). Cards fechados são ignorados (o RD exige campos obrigatórios).
//   node scripts/renomear-revenda-cards-28-10-2026.js [--aplicar]
require("dotenv").config({ quiet: true });
const fs = require("fs");
const l = require("../src/services/rd.leads.service");
const C = require("../src/config/constants");

const APLICAR = process.argv.includes("--aplicar");
const n = s => String(s || "").trim().toLowerCase();
const DE_PARA = {
    "d. soldas": "Aldesoldas",
    "25932, a alugaasolda aluguel de solda ltda": "AlugaASoldas",
    "31023, heitor nogueira da silva, suprimig suprimentos industriais": "Suprimig",
    "comercial soldas piracicaba": "Comercial Soldas",
    "37662, roma - parafusos e ferramentas ltda, romapar (romapar)": "Romapar",
    "31603, c. s. ferramentas ltda": "CS Ferramentas",
    "alphabras sjbv": "alphabras"
};

(async () => {
    const opcoes = await l.getOpcoesRevendaRD();
    for (const destino of new Set(Object.values(DE_PARA))) if (!opcoes.some(o => o === destino)) throw new Error("destino não existe na lista do RD: " + destino);
    const todos = await l.fetchAllDealsAllPipelines();
    const alvos = todos.filter(d => (d._pipelineId === C.RD_PIPELINE_INDUSTRIA || d._pipelineId === C.RD_PIPELINE_BMAX_INTERNO)
        && d.win !== true && d.win !== false && DE_PARA[n(l.getCustomField(d, "REVENDA/LOJA"))]);
    const backup = alvos.map(d => ({ id: d.id || d._id, nome: d.name, antes: l.getCustomField(d, "REVENDA/LOJA"), depois: DE_PARA[n(l.getCustomField(d, "REVENDA/LOJA"))] }));
    backup.forEach(b => console.log(`${b.nome.slice(0, 40).padEnd(40)} | "${b.antes.slice(0, 34)}" -> "${b.depois}"`));
    console.log("cards em aberto a renomear:", backup.length);
    if (!APLICAR) { console.log("(simulação — use --aplicar)"); process.exit(0); }
    fs.writeFileSync(`scripts/backups/renomear-revenda-cards-${Date.now()}.json`, JSON.stringify(backup, null, 1));
    let ok = 0, erro = 0;
    for (const b of backup) {
        try { await l.updateLead(b.id, { data: { custom_fields: { "revenda-loja": b.depois } } }); ok++; }
        catch (e) { erro++; console.log("  ERRO", b.nome, "-", String(e.message).slice(0, 120)); }
    }
    console.log("renomeados:", ok, "| erros:", erro);
    process.exit(0);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
