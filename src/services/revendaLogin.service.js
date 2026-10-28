// Cadastro de revenda + login juntos (André, 28/10/2026): o e-mail do cadastro passa a gerar o acesso no mesmo passo.
//  - usuário = e-mail em minúsculas; senha inicial = parte do e-mail antes do @ (padrão já usado nas reativações)
//  - Postgres: Users + Revendas (name = nome no RD, o que o login enxerga) + filial principal
//  - Supabase: comercial_revendas_bmax.user_id ligado ao login
//  - Motor: acesso (Supabase Auth) com a mesma senha
const bcrypt = require("bcryptjs");
const db = require("../database");
const { sbSistemasService: sv } = require("../config/supabaseSistemas");
const { logger } = require("../logger");

const digitos = s => String(s || "").replace(/\D/g, "");
const emailValido = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// valida TUDO antes de gravar qualquer coisa; devolve { erro } ou { dados } normalizados
async function validarNovoLogin({ email, cnpj, cep, cidade, estado }) {
    const mail = String(email || "").trim().toLowerCase();
    if (!emailValido(mail)) return { erro: "Para criar o login informe um e-mail válido." };
    const cnpjD = digitos(cnpj), cepD = digitos(cep);
    if (cnpjD.length !== 14) return { erro: "Para criar o login informe o CNPJ com 14 dígitos." };
    if (cepD.length !== 8) return { erro: "Para criar o login informe o CEP com 8 dígitos." };
    if (!String(cidade || "").trim() || !String(estado || "").trim()) return { erro: "Para criar o login informe cidade e estado." };
    if (await db.User.findOne({ where: { username: mail } })) return { erro: `Já existe um login com o e-mail ${mail}.` };
    const dono = await db.Revenda.findOne({ where: { cnpj: cnpjD } });
    if (dono) return { erro: `Já existe um login de revenda com este CNPJ (${dono.name}). Para dar outro acesso à mesma revenda use o modelo de revenda com código único (em implantação).` };
    return { dados: { mail, cnpjD, cepD, cidade: String(cidade).trim(), estado: String(estado).trim().toUpperCase() } };
}

async function criarLoginDeRevenda({ nomeRd, email, telefone, cnpj, cep, cidade, estado, grupo, cadastroId, enviarCredenciais = false }) {
    const v = await validarNovoLogin({ email, cnpj, cep, cidade, estado });
    if (v.erro) throw Object.assign(new Error(v.erro), { status: 400 });
    const { mail, cnpjD, cepD } = v.dados;
    const senhaInicial = mail.split("@")[0];
    const hash = await bcrypt.hash(senhaInicial, 10);

    const user = await db.sequelize.transaction(async (transaction) => {
        const u = await db.User.create({ username: mail, password: hash, role: "revenda" }, { transaction });
        await db.Revenda.create({
            user_id: u.id, name: nomeRd, email: mail, telefone: telefone || null, grupo: grupo || null,
            cnpj: cnpjD, cep: cepD, cidade: v.dados.cidade, estado: v.dados.estado
        }, { transaction });
        await db.RevendaFilial.create({
            user_id: u.id, nome: nomeRd, telefone: telefone || null, email: mail,
            cep: cepD, cidade: v.dados.cidade, estado: v.dados.estado, principal: true
        }, { transaction });
        return u;
    });

    if (cadastroId) {
        await sv(`/comercial_revendas_bmax?id=eq.${cadastroId}`, "PATCH", { user_id: user.id });
    }
    try {
        await require("../controllers/users.controller").sbSistemasAuthProvision(mail, senhaInicial);
    } catch (e) { logger.error({ message: "Falha ao criar acesso do Motor para a revenda nova", email: mail, error: e.message }); }
    if (enviarCredenciais) {
        try { await require("./email.service").sendAccessCredentials(mail, mail, senhaInicial, "revenda"); }
        catch (e) { logger.error({ message: "Falha ao enviar credenciais da revenda nova", email: mail, error: e.message }); }
    }
    return { userId: user.id, username: mail, senhaInicial };
}

module.exports = { validarNovoLogin, criarLoginDeRevenda };
