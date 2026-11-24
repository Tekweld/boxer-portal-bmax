const express = require("express");
const { authenticate, authorize } = require("../middlewares/auth");
const { getSaldo, getSaldoGrupo, getExtrato, getExtratoGrupo, getCreditosProximosVencimento, getCreditosProximosVencimentoGrupo, processarExpirados, getExpirandoEm, creditarCashback, debitarCashback, getSaldoRep, getExtratoRep, getCreditosExpirandoRep, getRepRevendas, listarAgentes, getExtratoPorAgente, getExtratoTipoAgente } = require("../services/saldo.service");
const { solicitarSaque, aprovarSaque, recusarSaque, listarSaques } = require("../services/saque.service");
const { sendEmail } = require("../services/email.service");
const { getRepresentativeEmailByName } = require("../services/user.service");
const { getLeads, mapDealToCard, getCustomField } = require("../services/rd.leads.service");
const { calcularComissoes } = require("../services/cashback.service");
const { recalcularComissoes, auditarComissoes } = require("../services/comissao.service");
const { anexarNomeLead, getGrupoRevendas } = require("../services/saldo.service");
const { QueryTypes } = require("sequelize");
const { sequelize } = require("../database");
const { sensitiveActionRateLimit } = require("../middlewares/rateLimit");
const { logger } = require("../logger");
const { REVENDA_SEM_CREDITO } = require("../config/constants");

const router = express.Router();

// Admin não tem carteira própria, mas pode consultar (somente leitura) a de uma
// revenda via ?revenda=NOME — mesma visão que o login da revenda enxerga,
// incluindo o agrupamento por grupo (bmax_grupos) quando a revenda pertence a um.
async function revendaConsultadaPeloAdmin(req) {
    const nome = typeof req.query.revenda === "string" ? req.query.revenda.trim() : "";
    if (!nome) return null;
    const rows = await sequelize.query(
        `SELECT grupo FROM bmax_grupos WHERE revenda_rd = :nome LIMIT 1`,
        { replacements: { nome }, type: QueryTypes.SELECT }
    );
    return { revenda: nome, grupo: rows.length ? rows[0].grupo : null };
}

router.get("/saldo", authenticate, authorize(["revenda", "representante", "adm"]), async (req, res) => {
    try {
        if (req.user.role === "representante") {
            const saldo = await getSaldoRep(req.user.username);
            return res.json({ revenda: req.user.username, saldo });
        }
        if (req.user.role === "adm") {
            const alvo = await revendaConsultadaPeloAdmin(req);
            if (!alvo) return res.json({ revenda: null, saldo: 0 });
            return res.json({ revenda: alvo.revenda, saldo: await getSaldoGrupo(alvo.revenda, alvo.grupo) });
        }
        const revenda = req.user.name;
        const grupo = req.user.grupo || null;
        const saldo = await getSaldoGrupo(revenda, grupo);
        res.json({ revenda, saldo });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/extrato", authenticate, authorize(["revenda", "representante", "adm"]), async (req, res) => {
    try {
        if (req.user.role === "representante") {
            const saldo = await getSaldoRep(req.user.username);
            const transacoes = await anexarNomeLead(await getExtratoRep(req.user.username));
            return res.json({ revenda: req.user.username, saldo, transacoes });
        }
        if (req.user.role === "adm") {
            const alvo = await revendaConsultadaPeloAdmin(req);
            if (!alvo) return res.json({ revenda: null, saldo: 0, transacoes: [] });
            const saldo = await getSaldoGrupo(alvo.revenda, alvo.grupo);
            const transacoes = await anexarNomeLead(await getExtratoGrupo(alvo.revenda, alvo.grupo));
            return res.json({ revenda: alvo.revenda, saldo, transacoes });
        }
        const revenda = req.user.name;
        const grupo = req.user.grupo || null;
        const saldo = await getSaldoGrupo(revenda, grupo);
        const transacoes = await anexarNomeLead(await getExtratoGrupo(revenda, grupo));
        res.json({ revenda, saldo, transacoes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/saques", authenticate, async (req, res) => {
    try {
        let repRevendas = null;
        if (req.user.role === "representante") {
            repRevendas = await getRepRevendas(req.user.username);
        }
        let saques = await listarSaques(req.user.name, req.user.username, req.user.role, repRevendas);
        if (req.user.role === "adm") {
            const alvo = await revendaConsultadaPeloAdmin(req);
            if (alvo) {
                const nomes = alvo.grupo
                    ? new Set(await getGrupoRevendas(alvo.grupo))
                    : new Set([alvo.revenda]);
                saques = saques.filter(s => nomes.has(s.revenda));
            }
        }
        res.json(saques);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/saques", authenticate, authorize(["revenda"]), sensitiveActionRateLimit, async (req, res) => {
    try {
        const { valor, tipo_uso } = req.body;
        if (!valor || !tipo_uso) return res.status(400).json({ error: "valor e tipo_uso obrigatorios" });

        let representante = null;
        try {
            const { QueryTypes } = require("sequelize");
            const allDeals = await getLeads("admin", "adm");
            const revName = req.user.name;
            for (const d of allDeals) {
                const rev = getCustomField(d, "REVENDA/LOJA");
                if (rev === revName) {
                    const rep = getCustomField(d, "REPRESENTANTE");
                    if (rep && rep !== "?????" && rep !== "N/D" && rep.trim()) { representante = rep.trim(); break; }
                }
            }
        } catch (e) { logger.error({ message: "Erro ao buscar representante do saque", error: e.message }); }

        const result = await solicitarSaque(req.user.name, representante, Number(valor), tipo_uso, req.user.grupo || null);
        res.json({ ok: true, saque: result });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post("/saques/:id/aprovar", authenticate, authorize(["representante", "adm"]), sensitiveActionRateLimit, async (req, res) => {
    try {
        const saque = await aprovarSaque(req.params.id, req.user.username);

        try {
            const tipoLabel = saque.tipo_uso === "desconto" ? "Desconto (max 5% do pedido)" : "Bonificacao (max 10% do pedido)";
            const chequeHtml = `
                <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:2px solid #1d327b;border-radius:12px;overflow:hidden;">
                    <div style="background:#1d327b;color:#fff;padding:20px;text-align:center;">
                        <h2 style="margin:0;">BMAX - Cheque Cashback</h2>
                    </div>
                    <div style="padding:24px;">
                        <table style="width:100%;font-size:14px;border-collapse:collapse;">
                            <tr><td style="padding:8px 0;color:#666;">Codigo</td><td style="padding:8px 0;font-weight:bold;font-size:18px;color:#1d327b;">${saque.codigo_cheque}</td></tr>
                            <tr><td style="padding:8px 0;color:#666;">Valor</td><td style="padding:8px 0;font-weight:bold;font-size:20px;color:#16a34a;">R$ ${Number(saque.valor).toFixed(2)}</td></tr>
                            <tr><td style="padding:8px 0;color:#666;">Tipo de Uso</td><td style="padding:8px 0;font-weight:bold;">${tipoLabel}</td></tr>
                            <tr><td style="padding:8px 0;color:#666;">Revenda</td><td style="padding:8px 0;">${saque.revenda}</td></tr>
                            <tr><td style="padding:8px 0;color:#666;">Validade</td><td style="padding:8px 0;color:#e30613;font-weight:bold;">30 dias (ate ${new Date(saque.expira_em).toLocaleDateString("pt-BR")})</td></tr>
                        </table>
                        <hr style="margin:16px 0;border:none;border-top:1px solid #eee;">
                        <p style="font-size:12px;color:#888;margin:0;">Insira o codigo <strong>${saque.codigo_cheque}</strong> no campo Observacao do pedido no ZEN.</p>
                    </div>
                </div>`;

            const emailRep = await getRepresentativeEmailByName(req.user.username);
            if (emailRep) await sendEmail(emailRep, `BMAX Cheque Aprovado: ${saque.codigo_cheque}`, chequeHtml);

            const { sequelize } = require("../database");
            const { QueryTypes } = require("sequelize");
            const revendaUsers = await sequelize.query(
                `SELECT u.username FROM "Users" u JOIN "Revendas" r ON r.user_id = u.id WHERE r.nome = :nome LIMIT 1`,
                { replacements: { nome: saque.revenda }, type: QueryTypes.SELECT }
            );
            if (revendaUsers.length) {
                const revendaEmail = revendaUsers[0].username;
                if (revendaEmail.includes("@")) {
                    await sendEmail(revendaEmail, `BMAX Cheque Cashback: ${saque.codigo_cheque}`, chequeHtml);
                }
            }
        } catch (emailErr) {
            logger.error({ message: "Erro ao enviar email do cheque", error: emailErr.message });
        }

        res.json({ ok: true, codigo_cheque: saque.codigo_cheque });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post("/saques/:id/recusar", authenticate, authorize(["representante", "adm"]), async (req, res) => {
    try {
        await recusarSaque(req.params.id, req.user.username, req.body.motivo);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.get("/expirando", authenticate, authorize(["revenda", "representante", "adm"]), async (req, res) => {
    try {
        if (req.user.role === "representante") {
            const creditos = await anexarNomeLead(await getCreditosExpirandoRep(req.user.username));
            return res.json(creditos);
        }
        const revenda = req.user.role === "revenda" ? req.user.name : req.query.revenda;
        if (!revenda) return res.json([]); // admin sem revenda selecionada
        let grupo = req.user.role === "revenda" ? req.user.grupo : null;
        if (req.user.role === "adm") grupo = (await revendaConsultadaPeloAdmin(req)).grupo;
        const creditos = await anexarNomeLead(await getCreditosProximosVencimentoGrupo(revenda, grupo));
        res.json(creditos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/creditar-retroativo", authenticate, authorize(["adm"]), sensitiveActionRateLimit, async (req, res) => {
    try {
        const { RD_STAGES, RD_STAGE_VENDIDO, RD_STAGE_VENDA_EFETIVADA, RD_STAGE_ENTREGA_TECNICA } = require("../config/constants");
        const { QueryTypes } = require("sequelize");

        const allDeals = await getLeads("admin", "adm");

        const vendaStages = new Set([RD_STAGE_VENDIDO, RD_STAGE_VENDA_EFETIVADA, RD_STAGE_ENTREGA_TECNICA]);
        const elegíveis = allDeals.filter(d => {
            const stageId = d.deal_stage ? d.deal_stage.id : null;
            return vendaStages.has(stageId) && Number(d.amount_total || 0) > 0;
        });

        // Checagem por (lead_id, tipo_agente) — não por lead_id sozinho — pra um deal já
        // creditado pra revenda antes dessa mudança poder ainda receber, retroativamente,
        // o crédito de representante/vendedor interno que nunca existiu.
        const existentes = await sequelize.query(
            `SELECT DISTINCT lead_id, tipo_agente FROM bmax_transacoes WHERE tipo = 'credito' AND lead_id IS NOT NULL`,
            { type: QueryTypes.SELECT }
        );
        const jaCreditado = new Set(existentes.map(r => `${r.lead_id}::${r.tipo_agente}`));

        let creditados = 0;
        let erros = 0;
        let faltandoDado = 0;
        const detalhes = [];

        for (const deal of elegíveis) {
            const dealId = deal.id || deal._id;

            const revenda = getCustomField(deal, "REVENDA/LOJA") || "";
            const representante = getCustomField(deal, "REPRESENTANTE") || "";
            const responsavelRd = (deal.user && deal.user.name) || "";
            const pci = getCustomField(deal, "PERFIL PCI") || "";
            const classePreco = (getCustomField(deal, "CLASSE DE PREÇO") || "").replace(/\D/g, "");
            const valor = Number(deal.amount_total || 0);

            try {
                const comissoes = await calcularComissoes({ valorTotal: valor, pci, classePreco, representante, responsavelRd });
                if (comissoes.faltando) { faltandoDado++; continue; }

                let algumCredito = false;
                if (comissoes.revenda && revenda && !REVENDA_SEM_CREDITO.includes(revenda) && !jaCreditado.has(`${dealId}::revenda`)) {
                    await creditarCashback(revenda, comissoes.revenda.valor, `Venda ${dealId} — ${pci} (${(comissoes.revenda.comissaoPct * 100).toFixed(1)}%)`, dealId, "revenda", { pci, classePreco, comissaoPct: comissoes.revenda.comissaoPct });
                    detalhes.push({ dealId, tipoAgente: "revenda", nome: revenda, valor: comissoes.revenda.valor });
                    algumCredito = true;
                }
                if (comissoes.representante && !jaCreditado.has(`${dealId}::representante`)) {
                    const tag = comissoes.representante.excecao ? " (exceção)" : "";
                    await creditarCashback(comissoes.representante.nome, comissoes.representante.valor, `Venda ${dealId} — ${pci}${tag} (${(comissoes.representante.comissaoPct * 100).toFixed(1)}%)`, dealId, "representante", { pci, classePreco, comissaoPct: comissoes.representante.comissaoPct });
                    detalhes.push({ dealId, tipoAgente: "representante", nome: comissoes.representante.nome, valor: comissoes.representante.valor });
                    algumCredito = true;
                }
                if (comissoes.vendedorInterno && !jaCreditado.has(`${dealId}::vendedor_interno`)) {
                    await creditarCashback(comissoes.vendedorInterno.nome, comissoes.vendedorInterno.valor, `Venda ${dealId} — ${pci} (${(comissoes.vendedorInterno.comissaoPct * 100).toFixed(1)}%)`, dealId, "vendedor_interno", { pci, classePreco, comissaoPct: comissoes.vendedorInterno.comissaoPct });
                    detalhes.push({ dealId, tipoAgente: "vendedor_interno", nome: comissoes.vendedorInterno.nome, valor: comissoes.vendedorInterno.valor });
                    algumCredito = true;
                }
                if (algumCredito) creditados++;
            } catch (err) {
                erros++;
                logger.error({ message: "Erro creditando deal", dealId, error: err.message });
            }
        }

        res.json({ ok: true, total_elegiveis: elegíveis.length, creditados, faltando_dado: faltandoDado, erros, detalhes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/recalcular", authenticate, authorize(["adm"]), sensitiveActionRateLimit, async (req, res) => {
    try {
        const resultado = await recalcularComissoes();
        res.json(resultado);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Só leitura — não credita, não debita, não altera nada. Compara o PCI/Classe
// de Preço gravados em cada crédito já lançado contra o que está no RD hoje,
// pra achar em segundos deals com dado apagado/trocado depois do fato.
router.get("/auditoria", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const resultado = await auditarComissoes();
        res.json(resultado);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/processar-expirados", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const expirados = await processarExpirados();

        const em30 = await getExpirandoEm(30);
        const em15 = await getExpirandoEm(15);

        const { sequelize } = require("../database");
        const { QueryTypes } = require("sequelize");

        for (const tx of [...em30, ...em15]) {
            const diasRestantes = Math.ceil((new Date(tx.expira_em) - Date.now()) / (24 * 60 * 60 * 1000));
            const revendaUsers = await sequelize.query(
                `SELECT u.username FROM "Users" u JOIN "Revendas" r ON r.user_id = u.id WHERE r.nome = :nome LIMIT 1`,
                { replacements: { nome: tx.revenda }, type: QueryTypes.SELECT }
            );
            if (revendaUsers.length && revendaUsers[0].username.includes("@")) {
                try {
                    await sendEmail(
                        revendaUsers[0].username,
                        `BMAX - Cashback expirando em ${diasRestantes} dias`,
                        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
                            <div style="background:#1d327b;color:#fff;padding:20px;text-align:center;border-radius:12px 12px 0 0;">
                                <h2 style="margin:0;">BMAX - Aviso de Vencimento</h2>
                            </div>
                            <div style="padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
                                <p>Voce tem um credito de cashback que expira em <strong>${diasRestantes} dias</strong>:</p>
                                <table style="width:100%;font-size:14px;border-collapse:collapse;">
                                    <tr><td style="padding:8px 0;color:#666;">Valor</td><td style="padding:8px 0;font-weight:bold;color:#16a34a;">R$ ${Number(tx.valor).toFixed(2)}</td></tr>
                                    <tr><td style="padding:8px 0;color:#666;">Origem</td><td style="padding:8px 0;">${tx.descricao}</td></tr>
                                    <tr><td style="padding:8px 0;color:#666;">Expira em</td><td style="padding:8px 0;color:#e30613;font-weight:bold;">${new Date(tx.expira_em).toLocaleDateString("pt-BR")}</td></tr>
                                </table>
                                <p style="margin-top:16px;">Acesse o <a href="https://bmax.boxersoldas.com.br" style="color:#1d327b;font-weight:bold;">Portal BMAX</a> para solicitar o saque antes do vencimento.</p>
                            </div>
                        </div>`
                    );
                } catch (emailErr) {
                    logger.error({ message: "Erro ao enviar aviso de vencimento", error: emailErr.message });
                }
            }
        }

        res.json({ ok: true, expirados: expirados.length, avisos30d: em30.length, avisos15d: em15.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
