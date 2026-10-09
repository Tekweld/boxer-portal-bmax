const { buildLeadsCards, updateLead, getTask, updateTask } = require("../services/rd.leads.service");
const { getCachedLeads, setCachedLeads, invalidateLeadsCache } = require("../services/cache.service");
const { logger } = require("../logger");
const { aplicarCaminhoVenda } = require("../services/caminhoVenda.service");
const { AuditLog } = require("../services/audit.service");
const {
    RD_STAGE_VENDIDO,
    RD_STAGE_PERDIDO
} = require("../config/constants");

// Registra (sem nunca logar o nome/telefone em si — só o fato do acesso e
// quais leads) toda vez que a resposta inclui contato de cliente (PCI12A).
// Dado pessoal sensível; isso dá rastreabilidade (accountability, LGPD
// Art. 37/46) de quem viu contato de cliente e quando, visível só pro admin
// via Audit Log. Roda tanto em cache hit quanto em resposta fresca, já que
// o dado é o mesmo em ambos os casos.
async function auditarAcessoContato(req, cards) {
    const leadsComContato = cards.filter(c => c.contatoNome || c.contatoTelefone);
    if (!leadsComContato.length) return;

    try {
        await AuditLog(req, {
            action: "VIEW_CONTATO_CLIENTE",
            entityType: "Lead",
            metadata: { dealIds: leadsComContato.map(c => c.id) }
        });
    } catch (e) {
        logger.error({ message: "Falha ao registrar acesso a contato de cliente", error: e.message });
    }
}

async function listLeads(req, res) {
    try {
        const userIdentifier =
            req.user.role === "revenda"
                ? req.user.name
                : req.user.username;

        const cacheKey = `${req.user.role}:${userIdentifier}`;

        try {
            const cached = await getCachedLeads(cacheKey);
            if (cached) {
                await auditarAcessoContato(req, cached);
                return res.json(cached);
            }
        } catch (_) {}

        const cards = await buildLeadsCards(req.user.role, userIdentifier, req.user.grupo);

        try {
            await setCachedLeads(cacheKey, cards);
        } catch (_) {}

        await auditarAcessoContato(req, cards);

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
        if (!["revenda", "representante", "adm"].includes(req.user?.role)) {
            return res.status(403).json({
                error: "Apenas revenda, representante ou admin podem definir o caminho de venda"
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

        // Esse endpoint só é chamado pela revenda, e só pra leads PCI12A (ver
        // condição do botão "Vendido" em public/js/leads.js) — é a revenda vendendo
        // do próprio estoque, sem envolvimento comercial do Boxer. Por regra
        // (planilha BMAX CRITERIOS), PCI12A nunca gera comissão pra ninguém: revenda,
        // representante e vendedor interno ficam de fora. Não há cálculo de comissão
        // aqui por design — só a atualização de estágio/valor no RD acima. O cálculo
        // de comissão de verdade (todos os outros PCIs) acontece via
        // /admin/comissoes/creditar-retroativo e /recalcular, lendo o deal direto do
        // RD depois que o time Boxer move o card pra "Venda Efetivada" no próprio RD.

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
