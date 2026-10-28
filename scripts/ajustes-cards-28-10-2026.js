// Ajustes pedidos pelo André em 28/10/2026 (duplicados, representante da Technofer, card SCOTTECH da MAQSOLDAS).
//   node scripts/ajustes-cards-28-10-2026.js [--aplicar]
require("dotenv").config({ quiet: true });
const fs = require("fs");
const l = require("../src/services/rd.leads.service");
const C = require("../src/config/constants");
const APLICAR = process.argv.includes("--aplicar");

const resumoErro = e => {
    const m = String(e.message || "");
    const labels = [...m.matchAll(/"label":"([^"]+)"/g)].map(x => x[1]);
    return labels.length ? "campos obrigatórios: " + [...new Set(labels)].join(", ") : m.slice(0, 160);
};

const ACOES = [
    { tipo: "fechar", id: "6a68ee59f545e800247ac0f4", stage: C.RD_STAGE_EXCLUIDO, nota: "Cancelado por duplicidade (mesmo CNPJ 04.449.995/0001-23): a negociacao foi mantida no card 6ab2b8d90f49d1002a35fdc9 (Tecnoservise Alysson). Decisao do Andre em 28/10/2026." },
    // ESTADO vazio no card (Technofer é de Araraquara/SP, cliente em São Carlos): o RD exige o campo para qualquer alteração
    { tipo: "fechar", id: "6a8c8d98c5acb00020f3d155", stage: C.RD_STAGE_PERDIDO, campos: { estado: "SP" }, nota: "Cadastro repetido (mesmo CNPJ 23.288.781/0001-67): mantido o card 6a8c7f44e9e56e002a5819b9. Decisao do Andre em 28/10/2026." },
    { tipo: "campos", id: "6a8c8d1fbd335500203ae4c0", campos: { representante: "Victor Lantyer", estado: "SP" } },
    {
        tipo: "scottech", id: "6ae1f6403bd126002515472e",
        data: { owner_id: C.RD_OWNERS["Revenda"], stage_id: C.RD_STAGE_ASSUMIDO, custom_fields: { "perfil-pci": "PCI 14", "seguimento-do-produto": "Laser" } },
        nota: "Correcao 28/10/2026: lead trazido pela MAQSOLDAS, Laser = PCI 14 (antes 12b). A revenda ATENDE o cliente e mantem a comissao; o lead saiu da Negociacao da Industria e NAO deve ser contatado por vendedor Boxer."
    }
];

(async () => {
    const backup = [];
    for (const a of ACOES) {
        const d = await l.getDealById(a.id);
        const estado = { id: a.id, nome: d.name, etapa: d.deal_stage && d.deal_stage.name, funil: d.deal_stage && d.deal_stage.deal_pipeline_id, dono: d.user && d.user.name, donoId: d.user && (d.user._id || d.user.id), pci: l.getCustomField(d, "PERFIL PCI"), seg: l.getCustomField(d, "SEGMENTO DE PRODUTO"), rep: l.getCustomField(d, "REPRESENTANTE"), win: d.win };
        backup.push(estado);
        console.log(`${a.tipo.padEnd(8)} | ${String(d.name).slice(0, 40).padEnd(40)} | ${estado.etapa} | dono ${estado.dono} | PCI ${estado.pci} | rep ${estado.rep}`);
    }
    if (!APLICAR) { console.log("(simulação — use --aplicar)"); process.exit(0); }
    fs.writeFileSync(`scripts/backups/ajustes-cards-${Date.now()}.json`, JSON.stringify(backup, null, 1));

    // --so=id1,id2 repete só essas ações (o resto já foi aplicado)
    const soArg = (process.argv.find(x => x.startsWith("--so=")) || "").slice(5).split(",").filter(Boolean);
    for (const a of ACOES.filter(x => !soArg.length || soArg.includes(x.id))) {
        try {
            if (a.tipo === "fechar") await l.updateLead(a.id, { data: { stage_id: a.stage, ...(a.campos ? { custom_fields: a.campos } : {}) } });
            else if (a.tipo === "campos") await l.updateLead(a.id, { data: { custom_fields: a.campos } });
            else if (a.tipo === "scottech") await l.updateLead(a.id, { data: a.data });
            if (a.nota) await l.createNote(a.id, a.nota);
            if (a.tipo === "scottech") await l.createTask({ deal_id: a.id, name: "Revenda conduz o atendimento", notes: "Lead trazido pela revenda MAQSOLDAS (PCI 14, Laser). A REVENDA atende o cliente - vendedor Boxer nao deve contatar o cliente. Caminho: Boxer vende e a revenda ganha comissao.", owner_id: C.RD_OWNERS["Revenda"], type: "task" });
            const d = await l.getDealById(a.id);
            console.log("OK  ", a.tipo, a.id, "->", d.deal_stage && d.deal_stage.name, "| dono", d.user && d.user.name, "| PCI", l.getCustomField(d, "PERFIL PCI"), "| rep", l.getCustomField(d, "REPRESENTANTE"), "| win", d.win);
        } catch (e) { console.log("ERRO", a.tipo, a.id, "-", resumoErro(e)); }
    }
    process.exit(0);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
