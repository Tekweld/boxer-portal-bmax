const { buildLeadsCards, updateLead, getTask, updateTask, createNote } = require("../services/rd.leads.service");
const { getCachedLeads, setCachedLeads, invalidateLeadsCache } = require("../services/cache.service");
const { logger } = require("../logger");
const { aplicarCaminhoVenda } = require("../services/caminhoVenda.service");
const { AuditLog } = require("../services/audit.service");
const andamento = require("../services/negociacaoStatus.service");
const pciX = require("../services/pciX.service");
const { nomeUnico } = require("../services/codigoUnico.service");
const {
    RD_STAGE_VENDIDO,
    RD_STAGE_PERDIDO_REVENDA
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

// Último andamento da negociação + situação do prazo do PCI X (fora do cache dos cards, para refletir na hora). Falha aqui nunca derruba a lista.
async function anexarAndamento(cards) {
    try {
        const abertos = cards.filter(c => !c.fechado);
        const ids = abertos.map(c => String(c.id));
        const [mapa, prazos] = await Promise.all([andamento.ultimosPorDeal(ids), pciX.situacaoPorDeal(abertos.filter(c => pciX.ehPciX(c.pci)).map(c => String(c.id)))]);
        // Cashback e filtros são do GRUPO: cada card leva o nome do grupo da loja (ou o da própria revenda, se não tem grupo)
        const grupoDe = new Map();
        for (const nome of new Set(cards.map(c => c.revenda).filter(Boolean))) grupoDe.set(nome, await nomeUnico(nome, "revenda"));
        return cards.map(c => {
            const a = mapa.get(String(c.id)); const p = prazos.get(String(c.id));
            const revendaGrupo = grupoDe.get(c.revenda) || c.revenda;
            return { ...c, revendaGrupo, ...(a ? { andamento: { tipo: a.tipo, status: a.status, motivo: a.motivo, observacao: a.observacao, usuario: a.usuario, em: a.criado_em } } : {}), ...(p ? { pcix: p } : {}) };
        });
    } catch (e) { logger.warn({ message: "anexarAndamento falhou", error: e.message }); return cards; }
}

// Quem pode mexer no andamento/resultado: a revenda no que ela atende (PCI12a ou PCI X); o admin só no PCI X (venda da revenda sem comissão).
async function leadPermitido(req, dealId) {
    const role = req.user.role;
    const ident = role === "revenda" ? req.user.name : req.user.username;
    let cards = null;
    try { cards = await getCachedLeads(`${role}:${ident}`); } catch (_) {}
    if (!cards) cards = await buildLeadsCards(role === "revenda" ? "revenda" : "adm", ident, req.user.grupo);
    const lead = cards.find(c => String(c.id) === String(dealId));
    if (!lead) return null;
    const pci = String(lead.pci || "").replace(/\s/g, "").toUpperCase();
    if (role === "revenda") return ["PCI12A", "PCIX"].includes(pci) ? lead : null;
    return pci === "PCIX" ? lead : null;
}
const nomeRevendaDe = (req, lead) => req.user.role === "revenda" ? req.user.name : (lead?.revenda || "");

async function registrarAndamento(req, res) {
    try {
        const { dealId, tipo, status, motivo, observacao } = req.body || {};
        if (!dealId) return res.status(400).json({ error: "dealId é obrigatório" });
        const lead = await leadPermitido(req, dealId);
        if (!lead) return res.status(403).json({ error: "Lead não encontrado ou sem permissão" });
        if ((tipo || "status") === "venda") return res.status(400).json({ error: "Tipo inválido" });
        const r = await andamento.registrar({ dealId, tipo: tipo || "status", status, motivo, observacao, pci: lead.pci, revenda: nomeRevendaDe(req, lead), usuario: req.user.username, leadNome: lead.nome }, createNote);
        await AuditLog(req, { action: "ANDAMENTO_LEAD", entityType: "Lead", entityId: dealId, metadata: { tipo: tipo || "status", status, motivo } });
        return res.json({ ok: true, ...r });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message || "Falha ao registrar andamento" });
    }
}

async function listarAndamento(req, res) {
    try {
        if (req.user.role === "revenda" && !(await leadPermitido(req, req.params.dealId))) return res.status(403).json({ error: "Lead não encontrado para esta revenda" });
        return res.json({ historico: await andamento.historico(req.params.dealId), status: andamento.STATUS, motivos: andamento.MOTIVOS_PERDA });
    } catch (err) { return res.status(500).json({ error: err.message }); }
}

async function relatorioPerdas(req, res) {
    try { return res.json(await andamento.relatorioPerdas({ de: req.query.de, ate: req.query.ate })); }
    catch (err) { return res.status(500).json({ error: err.message }); }
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
                return res.json(await anexarAndamento(cached));
            }
        } catch (_) {}

        const cards = await buildLeadsCards(req.user.role, userIdentifier, req.user.grupo);

        try {
            await setCachedLeads(cacheKey, cards);
        } catch (_) {}

        await auditarAcessoContato(req, cards);

        return res.json(await anexarAndamento(cards));

    } catch (err) {
        logger.error({ message: "Erro List Leads", error: err.message, stack: err.stack });

        return res.status(500).json({
            error: err.message || "Falha ao buscar leads do RD"
        });
    }
}

async function updateLeadPci(req, res) {
    try {
        if (!["revenda", "representante", "adm", "funcionario"].includes(req.user?.role)) {
            return res.status(403).json({
                error: "Apenas revenda, representante, funcionário ou admin podem definir o caminho de venda"
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
        if (!["revenda", "adm"].includes(req.user?.role)) {
            return res.status(403).json({
                error: "Apenas revenda (ou admin, nos leads PCI X) podem atualizar o resultado da negociação"
            });
        }

        const { dealId, resultado, valor } = req.body;
        const leadAlvo = dealId ? await leadPermitido(req, dealId) : null;
        if (dealId && !leadAlvo) return res.status(403).json({ error: "Lead não encontrado ou sem permissão para este resultado" });
        const ehX = pciX.ehPciX(leadAlvo?.pci);

        if (!dealId || !resultado) {
            return res.status(400).json({
                error: "dealId e resultado são obrigatórios"
            });
        }

        const resultadoNormalizado = String(resultado).toLowerCase();
        const stagePorResultado = {
            vendido: RD_STAGE_VENDIDO,
            perdido: RD_STAGE_PERDIDO_REVENDA
        };

        const stageId = stagePorResultado[resultadoNormalizado];

        if (!stageId) {
            return res.status(400).json({
                error: "Resultado inválido"
            });
        }

        const ehPerda = resultadoNormalizado === "perdido";
        if (ehPerda) {
            const erroMotivo = andamento.validar({ tipo: "perda", motivo: req.body.motivo, observacao: req.body.observacao });
            if (erroMotivo) return res.status(400).json({ error: erroMotivo });
        }
        const valorNumero = Number(String(valor ?? "").replace(",", "."));

        if (!ehPerda && (!Number.isFinite(valorNumero) || valorNumero < 0)) {
            return res.status(400).json({
                error: "Informe um valor numérico válido"
            });
        }

        // Perdido não mexe no valor do card; vendido grava o valor da venda
        const body = { data: ehPerda ? { stage_id: stageId } : { stage_id: stageId, amount_total: valorNumero } };

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

        if (ehPerda) {
            // Motivo da perda vai para o histórico e para a ANOTAÇÃO do card (nunca bloqueia o resultado já aplicado)
            try {
                await andamento.registrar({ dealId, tipo: "perda", motivo: req.body.motivo, observacao: req.body.observacao, pci: leadAlvo?.pci, revenda: nomeRevendaDe(req, leadAlvo), usuario: req.user.username, leadNome: leadAlvo?.nome }, createNote);
            } catch (e) { logger.error({ message: "Perda aplicada, mas o motivo não foi gravado", dealId, error: e.message }); }
        }
        if (ehX) {
            try {
                if (!ehPerda) await andamento.registrar({ dealId, tipo: "venda", observacao: `Valor R$ ${valorNumero}`, pci: leadAlvo.pci, revenda: nomeRevendaDe(req, leadAlvo), usuario: req.user.username, leadNome: leadAlvo.nome }, createNote);
                await pciX.encerrar(dealId);
            } catch (e) { logger.error({ message: "PCI X finalizado, mas o registro do desfecho falhou", dealId, error: e.message }); }
        }
        try { await invalidateLeadsCache(); } catch (_) {}
        // Desfecho gravado no Portal (controle do PCI12a) — não faz nada se o lead não é 12a
        try { await require("../services/pci12Desfecho.service").registrarResultado12a(dealId, resultadoNormalizado, "portal"); }
        catch (e) { logger.error({ message: "Falha ao gravar desfecho do 12a", dealId, error: e.message }); }

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
    updateLeadResultado,
    registrarAndamento,
    listarAndamento,
    relatorioPerdas
};
