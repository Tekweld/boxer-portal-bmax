// Corrige os 8 cards PCI12* cujo REVENDA/LOJA estava com nome sem login no Portal (caso Heitor/Suprimig, 28/10/2026).
//  - TODOS: troca o nome da revenda para o nome que o login enxerga.
//  - Os 4 ABERTOS que o robô de 48h tinha passado para 12b sem a revenda ver: voltam a PCI 12 (responsável André, etapa Lead),
//    prazo de 48h úteis reiniciado e a revenda/representante é avisada por e-mail. Fechados (perdidos) e o 12a só trocam o nome.
//   node scripts/corrigir-pci12-sem-vinculo-28-10-2026.js [--aplicar]
require("dotenv").config({ quiet: true });
const fs = require("fs");
const { QueryTypes } = require("sequelize");
const l = require("../src/services/rd.leads.service");
const C = require("../src/config/constants");
const db = require("../src/database");
const { sendEmail } = require("../src/services/email.service");
const { getRevendaEmailByName, getRepresentativeEmailByName } = require("../src/services/user.service");

const APLICAR = process.argv.includes("--aplicar");
const ALVOS = [
    { id: "6adbac015e5faa0022890cbb", para: "Suprimig", reverter: true },                 // Alicia (o caso reportado)
    { id: "6ad650563249010028473769", para: "AlugaASoldas", reverter: true },             // Luis - SULZER
    { id: "6aca88c08c67c300015c5d35", para: "AlugaASoldas", reverter: true },             // Leandro Segura do Nascimento
    { id: "6ad29fda6dd60e0001f8debc", para: "Comercial Soldas", reverter: true },         // Robson Lucio dos Santos
    { id: "6adbb76b40e37a0020d52d9c", para: "AlugaASoldas", reverter: false },            // Lucas Lima - PROENG (12a, revenda já assumiu)
    { id: "6ad22a52d5330400010eea8a", para: "Aldesoldas", reverter: false },              // Santec (perdido)
    { id: "6a903775d336c90021d8d48d", para: "Aldesoldas", reverter: false },              // Gabriele (perdido)
    { id: "69efac9305feb20001fe5b54", para: "Ipanema Soldas (LT)", reverter: false }      // José Otávio (perdido)
];

(async () => {
    const opcoes = await l.getOpcoesRevendaRD();
    const backup = [];
    for (const a of ALVOS) {
        const d = await l.getDealById(a.id);
        const antes = { revenda: l.getCustomField(d, "REVENDA/LOJA"), pci: l.getCustomField(d, "PERFIL PCI"), etapa: d.deal_stage && d.deal_stage.name, dono: d.user && d.user.name, donoId: d.user && (d.user._id || d.user.id), valor: d.amount_total, win: d.win, atualizado: d.updated_at };
        backup.push({ id: a.id, nome: d.name, antes });
        const okNome = opcoes.some(o => o === a.para);
        console.log(`${a.reverter ? "REVERTER" : "renomear"} | ${d.name.slice(0, 38).padEnd(38)} | "${antes.revenda.slice(0, 30)}" -> "${a.para}"${okNome ? "" : " (!! NÃO existe na lista do RD)"} | ${antes.pci} ${antes.etapa} dono ${antes.dono} valor ${antes.valor} atualizado ${String(antes.atualizado).slice(0, 10)}`);
        if (!okNome) throw new Error("nome destino não existe na lista do RD: " + a.para);
    }
    if (!APLICAR) { console.log("\n(simulação — use --aplicar)"); process.exit(0); }

    fs.writeFileSync(`scripts/backups/corrigir-pci12-sem-vinculo-${Date.now()}.json`, JSON.stringify(backup, null, 1));
    for (const a of ALVOS) {
        const data = { custom_fields: { "revenda-loja": a.para } };
        if (a.reverter) {
            data.custom_fields["perfil-pci"] = "PCI 12";
            data.owner_id = C.RD_OWNERS["Revenda"];
            data.stage_id = C.RD_STAGE_LEAD;
        }
        await l.updateLead(a.id, { data });
        console.log("RD atualizado:", a.id, a.para, a.reverter ? "(voltou a PCI 12)" : "");
        if (!a.reverter) continue;

        await db.sequelize.query(
            `UPDATE bmax_pci12_tracking SET detectado_em = now(), email_24h_enviado_em = NULL, auto_12b_em = NULL, resolvido_em = NULL, revertido_em = NULL WHERE deal_id = :id`,
            { replacements: { id: a.id }, type: QueryTypes.UPDATE });
        const d = await l.getDealById(a.id);
        try {
            await l.createNote(a.id, "Correcao 28/10/2026: o card estava com um nome de revenda sem acesso ao Portal BMAX e o prazo de 48h uteis foi aplicado sem a revenda ver o lead. Prazo reiniciado: a revenda tem 48 horas uteis para escolher o caminho de venda.");
        } catch (e) { console.log("  (nota no card falhou:", e.message + ")"); }
        const rep = l.getCustomField(d, "REPRESENTANTE") || "";
        const { rdToEmail } = await l.getAliasMaps();
        const destinos = [...new Set([await getRevendaEmailByName(a.para), rdToEmail[rep] || await getRepresentativeEmailByName(rep)].filter(Boolean))];
        if (destinos.length) {
            await sendEmail(destinos, "BMAX - Lead aguardando definição de caminho de venda (prazo reiniciado)",
                `<p>Um lead atribuído à revenda <strong>${a.para}</strong> estava sem aparecer no Portal por um erro de cadastro do nome da revenda, já corrigido:</p>
                 <ul><li><strong>Cliente:</strong> ${d.name || "?????"}</li></ul>
                 <p>Acesse o <a href="https://bmax.boxersoldas.com.br">Portal BMAX</a> e selecione "Como deseja atender este lead?" no card correspondente.</p>
                 <p>O prazo de <strong>48 horas úteis</strong> (sábados e domingos não contam) foi reiniciado a partir de agora.</p>`);
            console.log("  e-mail enviado para:", destinos.join(", "));
        } else console.log("  (sem e-mail de revenda/representante cadastrado)");
    }
    process.exit(0);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
