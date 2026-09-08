const { getLeads, mapDealToCard, updateLead, getTask, updateTask, createTask, getLeadNotes, getCustomField } = require("../services/rd.leads.service");
const { sendEmail } = require("../services/email.service");
const { lerPlanilhaResponsavel } = require("../services/responsavel.service");
const { getRepresentativeEmailByName } = require("../services/user.service");
const { getCachedLeads, setCachedLeads, invalidateLeadsCache } = require("../services/cache.service");
const { logger } = require("../logger");
const {
    RD_STAGE_ASSUMIDO,
    RD_OWNERS,
    RD_OWNER_DEFAULT,
    PCI_POR_CAMINHO,
    EMAIL_FALLBACK,
    RD_STAGE_VENDIDO,
    RD_STAGE_PERDIDO
} = require("../config/constants");
const { lerPlanilhaCashback } = require("../services/cashback.service");
const { creditarCashback, getCreditosPorLeads } = require("../services/saldo.service");

function formatarHistoricoNotas(historico) {
    const notas = Array.isArray(historico?.annotations) ? historico.annotations : Array.isArray(historico?.data) ? historico.data : [];

    if (!notas.length) {
        return "<p><em>Sem histórico disponível para este lead.</em></p>";
    }

    const itens = notas.map((nota) => {
        const data = (nota.registered_at || nota.created_at)
            ? new Date(nota.registered_at || nota.created_at).toLocaleString("pt-BR")
            : "Data não informada";
        const descricao = nota.description || nota.text || "Sem descrição";

        return `
            <li style="margin-bottom:12px;">
                <div><strong>${data}</strong></div>
                <div>${descricao}</div>
            </li>
        `;
    }).join("");

    return `
        <div style="margin-top:16px;">
            <p style="margin:0 0 8px;"><strong>Histórico da Negociação</strong></p>
            <ul style="padding-left:18px; margin:0;">
                ${itens}
            </ul>
        </div>
    `;
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

        const novoPci = PCI_POR_CAMINHO[caminho];

        if (!novoPci) {
            return res.status(400).json({
                error: "Caminho inválido"
            });
        }

        const responsavel = await lerPlanilhaResponsavel(cidade, estado);

        if (!responsavel) {
            return res.status(400).json({
                error: `Responsável não encontrado para a cidade "${cidade}" e estado "${estado}"`
            });
        }

        const responsavelId = RD_OWNERS[responsavel];

        if (!responsavelId) {
            return res.status(400).json({
                error: `ID não encontrado para o responsável "${responsavel}"`
            });
        }

        const body = {
            data: {
                stage_id: RD_STAGE_ASSUMIDO,
                owner_id: `${responsavelId}`,
                custom_fields: {
                    "perfil-pci": `${novoPci}`
                }
            }
        };

        if (novoPci === "PCI 12b") {
            const taskData = {
                deal_id: dealId,
                name: "Revenda Autorizou",
                description:"Revenda Selecionou Caminho BOX+REV>IND - Boxer assume venda",
                created_by_id: RD_OWNERS["Revenda"],
                owner_ids: [
                    RD_OWNER_DEFAULT
                ],
                type: "task"
            };
            await createTask(taskData);
        }

        const result = await updateLead(dealId, body);
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

        const resultPci = getCustomField(result, "PERFIL PCI");
        if (resultPci === "PCI 12b") {
            let historico = await getLeadNotes(dealId);
            const { getAliasMaps } = require("../services/rd.leads.service");
            const { rdToUsername } = await getAliasMaps();
            let representanteNome = getCustomField(result, "REPRESENTANTE") || "";
            representanteNome = rdToUsername[representanteNome] || representanteNome;
            const emailRepresentante = await getRepresentativeEmailByName(representanteNome);
            const destinatarioEmail = emailRepresentante || EMAIL_FALLBACK;

            if (!emailRepresentante) {
                logger.warn({ message: "E-mail do representante não encontrado, usando destinatário padrão", representanteNome });
            }
            let cnpj = getCustomField(result, "CNPJ") || "";
            cnpj = cnpj.replace(/\D/g, "");
            if (cnpj.length !== 14) cnpj = "--------------";
            else cnpj = cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,"$1.$2.$3/$4-$5");
            try {
                await sendEmail(
                    destinatarioEmail,
                    `BMAX - Negociação Assumida (Boxer vende)`,
                    `<p>Uma negociação do BMAX foi assumida pela Boxer (caminho BOX+REV>IND):</p>
                    <ul>
                        <li><strong>Cliente:</strong> ${result?.name}</li>
                        <li><strong>CNPJ:</strong> ${cnpj}</li>
                        <li><strong>Cidade:</strong> ${getCustomField(result, "CIDADE")}</li>
                        <li><strong>Estado:</strong> ${getCustomField(result, "ESTADO")}</li>
                        <li><strong>Máquina:</strong> ${getCustomField(result, "MÁQUINA DE INTERESSE")}</li>
                        <li><strong>Preço Total:</strong> ${result?.amount_total || 0} R$</li>
                    </ul>
                    ${formatarHistoricoNotas(historico)}`
                );
            } catch (error) {
                logger.error({ message: "Falha ao enviar e-mail de notificação", error: error.message });
            }
        }

        return res.json(result);
    } catch (err) {
        logger.error({ message: "Erro ao atualizar PCI", error: err.message, stack: err.stack });

        return res.status(500).json({
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
    updateLeadResultado,
    formatarHistoricoNotas
};
