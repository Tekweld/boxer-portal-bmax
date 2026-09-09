const { getLeads, mapDealToCard, updateLead, getTask, updateTask } = require("../services/rd.leads.service");
const { getCachedLeads, setCachedLeads, invalidateLeadsCache } = require("../services/cache.service");
const { logger } = require("../logger");
const { aplicarCaminhoVenda } = require("../services/caminhoVenda.service");
const { AuditLog } = require("../services/audit.service");
const {
    RD_STAGE_VENDIDO,
    RD_STAGE_PERDIDO
} = require("../config/constants");
const { lerPlanilhaCashback } = require("../services/cashback.service");
const { creditarCashback, getCreditosPorLeads } = require("../services/saldo.service");

async function listLeads(req, res) {
    try {
        const userIdentifier =
            req.user.role === "revenda"
                ? req.user.name
                : req.user.username;

        const cacheKey = `${req.user.role}:${userIdentifier}`;

        try {
            const cached = await getCachedLeads(cacheKey);
            if (cached) return res.json(cached);
        } catch (_) {}

        const leads = await getLeads(userIdentifier, req.user.role, req.user.grupo);

        const leadIds = leads.map(d => d.id || d._id).filter(Boolean);
        const creditosMap = await getCreditosPorLeads(leadIds);

        const cards = await Promise.all(
            leads.map(lead => mapDealToCard(lead, req.user.role, creditosMap))
        );

        try {
            await setCachedLeads(cacheKey, cards);
        } catch (_) {}

        return res.json(cards);

    } catch (err) {
        logger.error({ message: "Erro List Leads", error: err.message, stack: err.stack });

        return res.status(500).json({
            error: err.message || "Falha ao buscar leads do RD"
        });
    }
}

async function updateLeadPci(req, res) {
    try {
        if (req.user?.role !== "revenda") {
            return res.status(403).json({
                error: "Apenas usuários do tipo revenda podem definir o caminho de venda"
            });
        }

        const { dealId, caminho, cidade, estado } = req.body;

        if (!dealId || !caminho || !cidade || !estado) {
            return res.status(400).json({
                error: "dealId, caminho, cidade e estado são obrigatórios"
            });
        }

        const { novoPci, responsavel, result } = await aplicarCaminhoVenda(dealId, caminho, cidade, estado);

        await AuditLog(req, {
            action: "SELECT_CAMINHO_VENDA",
            entityType: "Lead",
            entityId: dealId,
            metadata: {
                caminho,
                novoPci,
                cidade,
                estado,
                responsavel,
                resultStage: `${novoPci}`
            }
        });

        try { await invalidateLeadsCache(); } catch (_) {}

        return res.json(result);
    } catch (err) {
        logger.error({ message: "Erro ao atualizar PCI", error: err.message, stack: err.stack });

        return res.status(err.status || 500).json({
            error: err.message || "Falha ao atualizar PCI"
        });
    }
}

async function updateLeadResultado(req, res) {
    try {
        if (req.user?.role !== "revenda") {
            return res.status(403).json({
                error: "Apenas usuários do tipo revenda podem atualizar o resultado da negociação"
            });
        }

        const { dealId, resultado, valor } = req.body;

        if (!dealId || !resultado) {
            return res.status(400).json({
                error: "dealId e resultado são obrigatórios"
            });
        }

        const resultadoNormalizado = String(resultado).toLowerCase();
        const stagePorResultado = {
            vendido: RD_STAGE_VENDIDO,
            perdido: RD_STAGE_PERDIDO
        };

        const stageId = stagePorResultado[resultadoNormalizado];

        if (!stageId) {
            return res.status(400).json({
                error: "Resultado inválido"
            });
        }

        const valorNumero = Number(String(valor ?? "").replace(",", "."));

        if (!Number.isFinite(valorNumero) || valorNumero < 0) {
            return res.status(400).json({
                error: "Informe um valor numérico válido"
            });
        }

        const body = {
            data: {
                stage_id: stageId,
                amount_total: valorNumero
            }
        };

        const result = await updateLead(dealId, body);
        await AuditLog(req, {
            action: "UPDATE_RESULTADO_LEAD",
            entityType: "Lead",
            entityId: dealId,
            metadata: {
                resultado: resultado,
                valor: valorNumero,
                stageId
            }
        });

        if (resultadoNormalizado === "vendido" && valorNumero > 0) {
            try {
                const revenda = req.user?.name;
                const pci = req.body.pci || "";
                const classePreco = req.body.classePreco || "";
                const comissao = parseFloat(await lerPlanilhaCashback(pci, "revenda", classePreco)) || 0;
                if (comissao > 0 && revenda) {
                    const cashbackValor = Number((valorNumero * comissao).toFixed(2));
                    await creditarCashback(revenda, cashbackValor, `Venda ${dealId} — ${pci} (${(comissao * 100).toFixed(1)}%)`, dealId);
                }
            } catch (cashErr) {
                logger.error({ message: "Erro ao creditar cashback", error: cashErr.message, stack: cashErr.stack });
            }
        }

        try { await invalidateLeadsCache(); } catch (_) {}

        return res.json(result);
    } catch (err) {
        logger.error({ message: "Erro ao atualizar resultado", error: err.message, stack: err.stack });

        return res.status(500).json({
            error: err.message || "Falha ao atualizar resultado"
        });
    }
}

module.exports = {
    listLeads,
    updateLeadPci,
    updateLeadResultado
};
