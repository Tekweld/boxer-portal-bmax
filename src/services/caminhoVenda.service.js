const { updateLead, createTask, getLeadNotes, getCustomField, getAliasMaps } = require("./rd.leads.service");
const { lerPlanilhaResponsavel } = require("./responsavel.service");
const { getRepresentativeEmailByName } = require("./user.service");
const { sendEmail } = require("./email.service");
const { logger } = require("../logger");
const {
    RD_STAGE_ASSUMIDO,
    RD_OWNERS,
    RD_OWNER_DEFAULT,
    PCI_POR_CAMINHO,
    EMAIL_FALLBACK
} = require("../config/constants");

function erroValidacao(mensagem) {
    return Object.assign(new Error(mensagem), { status: 400 });
}

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

async function notificarNegociacaoAssumida(dealId, result) {
    const historico = await getLeadNotes(dealId);
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
    cnpj = cnpj.length === 14
        ? cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
        : "--------------";

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

async function aplicarCaminhoVenda(dealId, caminho, cidade, estado) {
    const novoPci = PCI_POR_CAMINHO[caminho];

    if (!novoPci) {
        throw erroValidacao("Caminho inválido");
    }

    const responsavel = await lerPlanilhaResponsavel(cidade, estado);

    if (!responsavel) {
        throw erroValidacao(`Responsável não encontrado para a cidade "${cidade}" e estado "${estado}"`);
    }

    const responsavelId = RD_OWNERS[responsavel];

    if (!responsavelId) {
        throw erroValidacao(`ID não encontrado para o responsável "${responsavel}"`);
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
        await createTask({
            deal_id: dealId,
            name: "Revenda Autorizou",
            description: "Revenda Selecionou Caminho BOX+REV>IND - Boxer assume venda",
            created_by_id: RD_OWNERS["Revenda"],
            owner_ids: [RD_OWNER_DEFAULT],
            type: "task"
        });
    }

    const result = await updateLead(dealId, body);

    const resultPci = getCustomField(result, "PERFIL PCI");
    if (resultPci === "PCI 12b") {
        await notificarNegociacaoAssumida(dealId, result);
    }

    return { novoPci, responsavel, result };
}

module.exports = { aplicarCaminhoVenda };
