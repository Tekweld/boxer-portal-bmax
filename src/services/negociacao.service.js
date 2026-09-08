const db = require("../database");
const { createLead, createTask, getLeadByCnpj } = require("./rd.leads.service");
const { sendEmail } = require("./email.service");
const { getRepresentativeEmailByName } = require("./user.service");
const { RD_OWNERS, RD_OWNER_DEFAULT, EMAIL_FALLBACK } = require("../config/constants");
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
    const leadResponse = await createLead(data);
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
        type: "task"
    };

    await createTask(taskData);

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
