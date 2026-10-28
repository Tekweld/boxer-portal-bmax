const db = require("../database");
const { createLead, createTask, createNote, getLeadByCnpj, limparCacheVarreduraFunis, resolverRepresentanteDaRevenda } = require("./rd.leads.service");
const { validarParaAnexar, anexarENotificarRD } = require("./orcamento.service");
const { sendEmail } = require("./email.service");
const { getRepresentativeEmailByName, getRevendaEmailByName } = require("./user.service");
const { aplicarCaminhoVenda, encaminharLeadDaRevenda } = require("./caminhoVenda.service");
const { RD_OWNERS, RD_OWNER_DEFAULT, EMAIL_FALLBACK, PCI_POR_SEGMENTO } = require("../config/constants");
const { logger } = require("../logger");

const { Negociacao, User, Representante } = db;

async function createNegociacao(data) {

    const expires_at = new Date();
    expires_at.setDate(expires_at.getDate() + 60);

    if (!data.nome || !data.nome.trim()) {
        throw new Error("O campo 'Nome do Cliente' é obrigatório.");
    }
    if (!data.cnpj || !data.cnpj.trim()) {
        throw new Error("O campo 'CNPJ' é obrigatório.");
    }

    const cnpjToSearch = (data.cnpj || '').trim();

    const existingLead = await getLeadByCnpj(cnpjToSearch);
    if (existingLead) {
        const existName = existingLead.name || cnpjToSearch;
        throw new Error(`Já existe um Lead ativo com o CNPJ "${cnpjToSearch}" no RD Station (${existName}).`);
    }
    // Orçamentos anexados (até 3): valida ANTES de criar o card, pra um arquivo ruim não deixar lead pela metade.
    const orcamentos = await validarParaAnexar({ id: data.user_id }, data.orcamentos);
    // Orçamento é OBRIGATÓRIO (André, 15/10/2026) para qualquer perfil que registre negociação — imposto aqui
    // no servidor, não só na tela, para não dar pra pular chamando a API direto.
    if (!orcamentos.length) {
        throw new Error("Anexe pelo menos 1 orçamento (PDF, imagem, Word ou Excel) para registrar a negociação.");
    }

    // Lead trazido pela REVENDA (André, 28/10/2026): o PCI é o da regra do projeto pelo produto (Máquina 15, Laser 14,
    // Robô 13) e NUNCA vira 12a/12b — o caminho e "quem atende" só decidem para onde o card vai.
    if (data.role === "revenda") {
        const pciRevenda = PCI_POR_SEGMENTO[data.segmento];
        if (!pciRevenda) throw new Error("Selecione o segmento do produto (Máquinas, Laser ou Robô).");
        if (!["BOX>REV", "BOX+REV>IND"].includes(data.caminho)) throw new Error("Selecione o Caminho de Venda.");
        data.pci = pciRevenda;
        // Revenda vende -> ela mesma atende; Boxer vende -> precisa dizer quem atende o cliente
        if (data.caminho === "BOX>REV") data.atendimento = "revenda";
        if (!["revenda", "boxer"].includes(data.atendimento)) throw new Error("Informe quem atenderá o cliente: a revenda ou um vendedor da Boxer.");
        // Se a Boxer vai atender, já confere o vendedor da região ANTES de criar o card (não deixa lead pela metade)
        if (data.atendimento === "boxer") {
            const { lerPlanilhaResponsavel } = require("./responsavel.service");
            const resp = await lerPlanilhaResponsavel(data.cidade, data.estado);
            if (!resp || !RD_OWNERS[resp]) throw new Error(`Não encontramos o vendedor Boxer responsável pela cidade "${data.cidade}" / estado "${data.estado}". Escolha que a revenda atende ou fale com a Boxer.`);
        }
    }

    // Revenda não escolhe representante: preenche pelo cadastro da revenda (nome do RD) — antes o card nascia vazio
    if (!String(data.representante || "").trim()) {
        try { data.representante = await resolverRepresentanteDaRevenda(data.revenda); }
        catch (e) { logger.warn({ message: "Não foi possível resolver o representante da revenda", revenda: data.revenda, error: e.message }); }
    }

    const leadResponse = await createLead(data);
    limparCacheVarreduraFunis();
    const leadId = leadResponse.id || leadResponse._id || (leadResponse.data && leadResponse.data.id);

    const novaNegociacao = await Negociacao.create({
        user_id: data.user_id,
        cnpj: data.cnpj,
        nome: data.nome,
        cidade: data.cidade,
        cep: data.cep,
        maquina: data.maquinainteresse,
        arquivo: data.arquivo || null,
        revenda: data.revenda,
        representante: data.representante,
        expires_at: expires_at
    });

    const taskData = {
        deal_id: leadId,
        name: "Lead BMAX",
        created_by_id: RD_OWNERS["Revenda"],
        owner_ids: [
            RD_OWNER_DEFAULT
        ],
        type: "task",
        // Campo "Observações" do formulário — o RD não expôs (ou não achamos)
        // uma API de anotação de verdade no card; grava aqui, visível ao abrir
        // a tarefa "Lead BMAX" que já é criada pra toda negociação.
        notes: data.observacoes || undefined
    };

    await createTask(taskData);

    // Link(s) do orçamento na nota do card. Se o RD falhar, o arquivo já está vinculado e o cron
    // sync-revenda-rep-rd reenvia a nota — a negociação NÃO falha por causa disso.
    if (orcamentos.length) {
        try {
            await anexarENotificarRD(orcamentos, { negociacaoId: novaNegociacao.id, dealId: leadId, createNote });
        } catch (error) {
            logger.error({ message: "Falha ao registrar nota de orçamento no RD (o cron reenvia)", dealId: leadId, error: error.message });
        }
    }

    if (data.role === "revenda") {
        try {
            await encaminharLeadDaRevenda(leadId, { caminho: data.caminho, atendimento: data.atendimento, cidade: data.cidade, estado: data.estado, pci: data.pci });
        } catch (error) {
            logger.error({ message: "Falha ao encaminhar lead da revenda na criação da negociação", dealId: leadId, error: error.message });
        }
    } else if (data.caminho) {
        try {
            await aplicarCaminhoVenda(leadId, data.caminho, data.cidade, data.estado);
        } catch (error) {
            logger.error({ message: "Falha ao definir caminho de venda na criação da negociação", error: error.message });
        }
    } else {
        try {
            const emailRevenda = await getRevendaEmailByName(data.revenda);
            const destinatarioEmail = emailRevenda || EMAIL_FALLBACK;

            if (!emailRevenda) {
                logger.warn({ message: "E-mail da revenda não encontrado para aviso de caminho pendente, usando destinatário padrão", revendaNome: data.revenda });
            }

            await sendEmail(
                destinatarioEmail,
                `BMAX - Lead aguardando definição de caminho de venda`,
                `<p>Um novo lead foi registrado no Portal BMAX e precisa que você escolha o caminho de venda:</p>
                 <ul>
                    <li><strong>Cliente:</strong> ${novaNegociacao.nome}</li>
                    <li><strong>Máquina:</strong> ${novaNegociacao.maquina}</li>
                    <li><strong>Cidade:</strong> ${novaNegociacao.cidade}</li>
                 </ul>
                 <p>Acesse o <a href="https://bmax.boxersoldas.com.br">Portal BMAX</a> e selecione "Como deseja atender este lead?" no card correspondente.</p>`
            );
        } catch (error) {
            logger.error({ message: "Falha ao enviar e-mail de aviso de caminho pendente", error: error.message });
        }
    }

    try {
        let representanteNome = data.representante || "";
        const emailRepresentante = await getRepresentativeEmailByName(representanteNome);
        const destinatarioEmail = emailRepresentante || EMAIL_FALLBACK;

        if (!emailRepresentante) {
            logger.warn({ message: "E-mail do representante não encontrado, usando destinatário padrão", representanteNome });
        }

        await sendEmail(
            destinatarioEmail,
            `Nova Negociação BMAX: ${novaNegociacao.nome}`,
            `<p>Uma nova negociação foi registrada no Portal BMAX:</p>
             <ul>
                <li><strong>Cliente:</strong> ${novaNegociacao.nome}</li>
                <li><strong>Máquina:</strong> ${novaNegociacao.maquina}</li>
                <li><strong>Revenda:</strong> ${novaNegociacao.revenda}</li>
                <li><strong>Representante:</strong> ${novaNegociacao.representante}</li>
             </ul>`
        );
    } catch (error) {
        logger.error({ message: "Falha ao enviar e-mail de notificação", error: error.message });
    }

    return novaNegociacao;
}

async function listNegociacoes(user) {
    if (user.role === "adm") {
        return await Negociacao.findAll();
    }

    return await Negociacao.findAll({
        where: {
            user_id: user.id
        }
    });
}

module.exports = {
    createNegociacao,
    listNegociacoes
}
