const { updateLead, createTask, getLeadNotes, getCustomField, getAliasMaps, getContatoPrincipal, getDealById } = require("./rd.leads.service");
const { lerPlanilhaResponsavel } = require("./responsavel.service");
const { getRepresentativeEmailByName, getRevendaEmailByName } = require("./user.service");
const { sendEmail } = require("./email.service");
const { marcarResolvido, buscarOwnerOriginal, registrarAssumido } = require("./pci12Tracking.service");
const { logger } = require("../logger");
const {
    RD_STAGE_NEGOCIACAO,
    RD_STAGE_VENDA_EFETIVADA,
    RD_STAGE_VENDIDO,
    RD_STAGE_ENTREGA_TECNICA,
    RD_STAGE_PERDIDO,
    RD_STAGE_EXCLUIDO,
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
    // GET /annotations está devolvendo 404 na API V1 do RD (confirmado
    // 17/09/2026 — não é só a escrita que não existe, a leitura também
    // parou de funcionar). Isso travava a função inteira antes de chegar
    // no envio do e-mail (nada estava com try/catch aqui) — o histórico é
    // só um complemento no corpo do e-mail, não pode quebrar o essencial.
    let historico = null;
    try {
        historico = await getLeadNotes(dealId);
    } catch (e) {
        logger.error({ message: "Erro ao buscar histórico de anotações (não bloqueia o e-mail)", dealId, error: e.message });
    }
    const rdNameOriginal = getCustomField(result, "REPRESENTANTE") || "";
    const { rdToUsername, rdToEmail } = await getAliasMaps();
    const representanteNome = rdToUsername[rdNameOriginal] || rdNameOriginal;
    // rdToUsername devolve o nome canônico, não o username de login (que hoje é
    // e-mail) — getRepresentativeEmailByName busca por username exato e falha
    // pra quem já migrou. rdToEmail vem direto do cadastro (Supabase), mais
    // confiável; getRepresentativeEmailByName fica só de fallback.
    const emailRepresentante = rdToEmail[rdNameOriginal] || await getRepresentativeEmailByName(representanteNome);
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

// Revenda escolheu "eu assumo a venda" (BOX>REV, PCI12A) — ninguém era
// avisado nesse caminho antes (só o BOX+REV>IND tinha e-mail). Avisa revenda
// e representante, já com nome/telefone do contato pra eles conseguirem
// ligar pro cliente direto (mesma regra de privacidade do drawer no front:
// esse dado só é buscado/exposto quando o caminho já é PCI12A).
async function notificarRevendaAssumiu(dealId, result) {
    const revendaNome = getCustomField(result, "REVENDA/LOJA") || "";
    const rdNameOriginal = getCustomField(result, "REPRESENTANTE") || "";

    try {
        // Mesmo problema de notificarNegociacaoAssumida: rdToUsername devolve
        // o nome canônico, não o username de login (hoje é e-mail) — usar o
        // e-mail já cadastrado (rdToEmail) evita depender de bater username
        // com nome exato, que falha pra quem já migrou pro login por e-mail.
        const { rdToUsername, rdToEmail } = await getAliasMaps();
        const representanteNome = rdToUsername[rdNameOriginal] || rdNameOriginal;

        const emailRevenda = await getRevendaEmailByName(revendaNome);
        const emailRepresentante = rdToEmail[rdNameOriginal] || await getRepresentativeEmailByName(representanteNome);
        const destinatarios = [...new Set([emailRevenda, emailRepresentante].filter(Boolean))];
        if (!destinatarios.length) destinatarios.push(EMAIL_FALLBACK);

        if (!emailRevenda) {
            logger.warn({ message: "E-mail da revenda não encontrado para aviso de PCI12A assumido", revendaNome });
        }
        if (!emailRepresentante) {
            logger.warn({ message: "E-mail do representante não encontrado para aviso de PCI12A assumido", representanteNome });
        }

        const orgId = result.organization?._id || result.organization?.id || null;
        const contato = await getContatoPrincipal(orgId, dealId, result);

        await sendEmail(
            destinatarios,
            `BMAX - Voce assumiu a venda (contate o cliente)`,
            `<p>Você escolheu atender este lead diretamente (caminho BOX>REV):</p>
             <ul>
                <li><strong>Cliente:</strong> ${result?.name || "?????"}</li>
                <li><strong>Cidade:</strong> ${getCustomField(result, "CIDADE") || "?????"}</li>
                <li><strong>Estado:</strong> ${getCustomField(result, "ESTADO") || "?????"}</li>
                <li><strong>Máquina:</strong> ${getCustomField(result, "MÁQUINA DE INTERESSE") || "?????"}</li>
                <li><strong>Valor:</strong> R$ ${result?.amount_total || 0}</li>
                ${contato?.nome ? `<li><strong>Contato:</strong> ${contato.nome}</li>` : ""}
                ${contato?.telefone ? `<li><strong>Telefone:</strong> ${contato.telefone}</li>` : ""}
             </ul>
             <p>Entre em contato com o cliente o quanto antes. Os mesmos dados de contato também aparecem no Portal, no detalhe deste lead.</p>`
        );
    } catch (error) {
        logger.error({ message: "Falha ao enviar e-mail de revenda assumiu (PCI12A)", dealId, error: error.message });
    }
}

// opts.automatico = true: chamado pelo cron ao expirar o prazo de 48h do PCI12 (André,
// 08/10/2026) — aplica o 12b devolvendo o responsável ANTERIOR ao André
// (opts.ownerOriginalId); sem dono anterior conhecido, cai na planilha por região; sem
// ninguém, o responsável atual é mantido (o 12b vale mesmo assim).
async function aplicarCaminhoVenda(dealId, caminho, cidade, estado, opts = {}) {
    const novoPci = PCI_POR_CAMINHO[caminho];

    if (!novoPci) {
        throw erroValidacao("Caminho inválido");
    }

    // Regra (André, 08/10/2026): lead que já foi vendido (ou perdido) NUNCA pede
    // caminho de venda — não há mais o que decidir, e aplicar o caminho puxaria
    // a negociação de volta pra etapa Negociação, desfazendo a venda no RD.
    // Barra aqui (API) além de esconder o seletor no card (leads.js).
    const dealAtual = await getDealById(dealId);
    const etapaAtual = dealAtual?.deal_stage?.id;
    // Também barra lead com status final no RD (win = ganha/perdida) ainda numa etapa de
    // andamento: aplicar o caminho o puxaria de volta pra Negociação — era assim que
    // vendas já ganhas voltavam pra Negociação (achado 09/10/2026, 15 leads).
    const fechadoNoRd = dealAtual?.win === true || dealAtual?.win === false;
    if (fechadoNoRd || [RD_STAGE_VENDA_EFETIVADA, RD_STAGE_VENDIDO, RD_STAGE_ENTREGA_TECNICA, RD_STAGE_PERDIDO, RD_STAGE_EXCLUIDO].includes(etapaAtual)) {
        throw erroValidacao("Este lead já foi finalizado (vendido ou perdido) — não é possível definir caminho de venda.");
    }

    let stageId, responsavelId, responsavel;

    if (novoPci === "PCI 12a") {
        // Revenda assume a venda (BOX>REV) — regra confirmada por André
        // (16-17/09/2026): NÃO muda de funil (permanece em Indústria
        // Interno), mas vai pra etapa Negociação (mesma etapa do caminho
        // BOX+REV>IND, só não muda de pipeline) — responsável continua
        // sendo André (mesma pessoa da troca automática enquanto o PCI12
        // ficava pendente), PCI vira 12a, e cria uma anotação no RD
        // documentando que a revenda vai atender direto.
        stageId = RD_STAGE_NEGOCIACAO;
        responsavelId = RD_OWNERS["Revenda"];
        responsavel = "Revenda (André)";
    } else {
        // Boxer vende (BOX+REV>IND) — o lead volta pra Negociação (funil
        // Indústria Interno) e o responsável deixa de ser o André: vira o
        // vendedor da região (planilha por cidade/estado) ou, se a planilha
        // não encontrar ninguém, quem era o responsável antes da troca
        // automática (nunca fica com o André).
        stageId = RD_STAGE_NEGOCIACAO;
        const donoAndre = RD_OWNERS["Revenda"];

        if (opts.automatico && opts.ownerOriginalId && opts.ownerOriginalId !== donoAndre) {
            responsavelId = opts.ownerOriginalId;
            responsavel = opts.ownerOriginalNome || responsavelId;
        }
        if (!responsavelId) {
            responsavel = await lerPlanilhaResponsavel(cidade, estado);
            responsavelId = responsavel ? RD_OWNERS[responsavel] : null;
        }
        if (!responsavelId) {
            const original = await buscarOwnerOriginal(dealId);
            if (original?.owner_original_id && original.owner_original_id !== donoAndre) {
                responsavelId = original.owner_original_id;
                responsavel = original.owner_original_nome || responsavelId;
            }
        }

        if (!responsavelId && !opts.automatico) {
            throw erroValidacao(`Responsável não encontrado para a cidade "${cidade}" e estado "${estado}"`);
        }
    }

    const body = {
        data: {
            ...(responsavelId ? { owner_id: `${responsavelId}` } : {}),
            custom_fields: {
                "perfil-pci": `${novoPci}`,
                // RD exige "Segmento de Produto" preenchido pra aceitar a etapa
                // Negociação (descoberto 17/09/2026 — deal sem esse campo
                // travava com 422 "deal_required_custom_fields"). PCI12 (12a e
                // 12b) é sempre classificado como Máquinas na Política Comercial
                // (nunca Robô/Laser), então é seguro preencher direto aqui.
                "seguimento-do-produto": "Máquinas"
            }
        }
    };
    // stage_id só entra no body quando o caminho de fato precisa mudar de
    // etapa (BOX+REV>IND volta pra Negociação). BOX>REV não muda de etapa
    // nem de funil — omitir a chave inteira faz o updateLead não tocar
    // nesse campo no RD (ver rd.leads.service.js:updateLead).
    if (stageId) {
        body.data.stage_id = stageId;
    }

    if (novoPci === "PCI 12b") {
        await createTask({
            deal_id: dealId,
            name: opts.automatico ? "Prazo de 48h expirou" : "Revenda Autorizou",
            notes: opts.automatico
                ? "A revenda não escolheu o caminho de venda em 48 horas úteis - aplicado automaticamente BOX+REV>IND (Boxer vende, revenda mantém a comissão)."
                : "Revenda Selecionou Caminho BOX+REV>IND - Boxer assume venda",
            owner_id: RD_OWNER_DEFAULT,
            type: "task"
        });
    } else if (novoPci === "PCI 12a") {
        await createTask({
            deal_id: dealId,
            name: "Revenda Assumiu o Atendimento",
            notes: "Revenda selecionou o caminho BOX>REV - a revenda seguirá o atendimento diretamente com o cliente.",
            owner_id: RD_OWNERS["Revenda"],
            type: "task"
        });
    }

    const result = await updateLead(dealId, body);

    // Caminho definido — encerra o rastreamento da troca automática de
    // responsável (ver bloco PCI12 em sync-revenda-rep-rd / cron
    // pci12-followup). updateLead acima já sobrescreveu owner_id com o
    // responsável correto pra esse caminho, então não há nada pra reverter
    // aqui — só marcar resolvido pra o cron de followup não mexer mais nele.
    try { await marcarResolvido(dealId); } catch (e) {
        logger.error({ message: "Erro ao marcar PCI12 tracking como resolvido", dealId, error: e.message });
    }

    // PCI12a: começa a contar o prazo de 60 dias (cron pci12a-prazo).
    if (novoPci === "PCI 12a") {
        try { await registrarAssumido(dealId); } catch (e) {
            logger.error({ message: "Erro ao registrar início do prazo de 60 dias do PCI12a", dealId, error: e.message });
        }
    }

    const resultPci = getCustomField(result, "PERFIL PCI");
    if (resultPci === "PCI 12b") {
        await notificarNegociacaoAssumida(dealId, result);
    } else if (resultPci === "PCI 12a") {
        await notificarRevendaAssumiu(dealId, result);
    }

    return { novoPci, responsavel, result };
}

// Lead TRAZIDO PELA REVENDA na Nova Negociação (André, 28/10/2026). O PCI já nasce correto (13/14/15 pelo produto)
// e NUNCA muda aqui — as duas perguntas só decidem PARA ONDE o card vai:
//   caminho:      BOX>REV (revenda vende) | BOX+REV>IND (Boxer vende e paga comissão à revenda)
//   atendimento:  "revenda" -> o card NÃO vai para vendedor da Boxer (fica no funil BMAX, dono "Revenda");
//                 "boxer"   -> vai para Negociação (Indústria) com o vendedor responsável da região.
async function encaminharLeadDaRevenda(dealId, { caminho, atendimento, cidade, estado, pci }) {
    const descCaminho = caminho === "BOX+REV>IND" ? "Boxer vende e a revenda ganha comissao" : "Revenda vende";
    if (atendimento === "revenda") {
        await createTask({
            deal_id: dealId,
            name: "Revenda conduz o atendimento",
            notes: `Lead trazido pela revenda (${pci}). A REVENDA atende o cliente - vendedor Boxer nao deve contatar o cliente. Caminho: ${descCaminho}.`,
            owner_id: RD_OWNERS["Revenda"],
            type: "task"
        });
        return { atendimento };
    }

    const responsavel = await lerPlanilhaResponsavel(cidade, estado);
    const responsavelId = responsavel ? RD_OWNERS[responsavel] : null;
    if (!responsavelId) throw erroValidacao(`Responsável não encontrado para a cidade "${cidade}" e estado "${estado}"`);
    await updateLead(dealId, { data: { owner_id: `${responsavelId}`, stage_id: RD_STAGE_NEGOCIACAO } });
    await createTask({
        deal_id: dealId,
        name: "Revenda Autorizou",
        notes: `Lead trazido pela revenda (${pci}). A revenda pediu que a BOXER atenda o cliente. Caminho: ${descCaminho}.`,
        owner_id: RD_OWNER_DEFAULT,
        type: "task"
    });
    return { atendimento, responsavel };
}

module.exports = { aplicarCaminhoVenda, encaminharLeadDaRevenda };
