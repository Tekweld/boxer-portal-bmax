const bcrypt = require("bcryptjs");
const { UniqueConstraintError } = require("sequelize");
const db = require("../database");
const { sendAccessCredentials } = require("../services/email.service");

const { User, Revenda, RevendaFilial, Representante, sequelize } = db;

function generateRandomPassword(length = 16) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%";
    let password = "";
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

const SB_SISTEMAS_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';

async function sbSistemas(path, method = 'GET', body = null) {
    const serviceKey = process.env.SUPABASE_SERVICE_KEY_SISTEMAS;
    if (!serviceKey) throw new Error("SUPABASE_SERVICE_KEY_SISTEMAS não configurada");

    const url = `${SB_SISTEMAS_URL}/rest/v1${path}`;
    const opts = {
        method,
        headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json"
        }
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.message || json?.error || `HTTP ${res.status}`);
    }
    return res.json().catch(() => ({}));
}

async function sbSistemasAuthInvite(email) {
    const serviceKey = process.env.SUPABASE_SERVICE_KEY_SISTEMAS;
    if (!serviceKey) throw new Error("SUPABASE_SERVICE_KEY_SISTEMAS não configurada");
    const res = await fetch(`${SB_SISTEMAS_URL}/auth/v1/invite`, {
        method: "POST",
        headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ email })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok && json?.error_code !== "email_exists") {
        throw new Error(json?.msg || json?.message || `Supabase Auth ${res.status}`);
    }
    return json;
}

function clean(value) {
    return (value ?? "").toString().trim();
}

function onlyDigits(value) {
    return clean(value).replace(/\D/g, "");
}

async function createUser(req, res) {
    try {
        const role = clean(req.body.role);
        const name = clean(req.body.name);
        const email = clean(req.body.email).toLowerCase();
        const password = clean(req.body.password);
        const telefone = clean(req.body.telefone);
        const cnpj = onlyDigits(req.body.cnpj);
        const cep = onlyDigits(req.body.cep);
        const cidade = clean(req.body.cidade);
        const estado = clean(req.body.estado).toUpperCase();
        const representante = clean(req.body.representante);
        const providedUsername = clean(req.body.username);

        if (!["adm", "representante", "revenda", "funcionario"].includes(role)) {
            return res.status(400).json({
                error: "role inválido"
            });
        }

        // Gera senha aleatória se não for fornecida (fluxo de email com credenciais)
        const finalPassword = password || generateRandomPassword();

        const username = providedUsername || (role === "revenda" ? email : name);

        if (!username) {
            return res.status(400).json({
                error: "username é obrigatório"
            });
        }

        if (role === "adm" && !name) {
            return res.status(400).json({
                error: "nome é obrigatório para administradores"
            });
        }

        if (role === "adm" && !email) {
            return res.status(400).json({
                error: "e-mail é obrigatório para administradores"
            });
        }

        if (role === "representante" && (!name || !email)) {
            return res.status(400).json({
                error: "nome e e-mail são obrigatórios para representantes"
            });
        }

        if (role === "revenda" && (!email || !name || !cnpj || !cep || !cidade || !estado)) {
            return res.status(400).json({
                error: "e-mail, cnpj, nome, cep, cidade e estado são obrigatórios para revenda"
            });
        }

        if (role === "funcionario" && (!name || !email)) {
            return res.status(400).json({
                error: "nome e e-mail são obrigatórios para funcionários"
            });
        }

        const hashedPassword = await bcrypt.hash(finalPassword, 10);

        const user = await sequelize.transaction(async (transaction) => {
            const createdUser = await User.create({
                username,
                password: hashedPassword,
                role
            }, { transaction });

            if (role === "representante") {
                await Representante.create({
                    user_id: createdUser.id,
                    email,
                    telefone
                }, { transaction });
            }

            if (role === "revenda") {
                await Revenda.create({
                    user_id: createdUser.id,
                    name,
                    email,
                    telefone,
                    representante_id: representante || null,
                    cnpj,
                    cep,
                    cidade,
                    estado
                }, { transaction });

                // Cria filial principal
                const filiais = req.body.filiais || [];
                if (filiais.length === 0) {
                    // Se nenhuma filial foi fornecida, cria uma com os dados principais
                    await RevendaFilial.create({
                        user_id: createdUser.id,
                        nome: name,
                        telefone,
                        email,
                        cep,
                        cidade,
                        estado,
                        principal: true
                    }, { transaction });
                } else {
                    // Cria as filiais fornecidas, marcando a primeira como principal
                    for (let i = 0; i < filiais.length; i++) {
                        const filial = filiais[i];
                        await RevendaFilial.create({
                            user_id: createdUser.id,
                            nome: clean(filial.nome),
                            telefone: clean(filial.telefone),
                            email: clean(filial.email),
                            cep: onlyDigits(filial.cep),
                            cidade: clean(filial.cidade),
                            estado: clean(filial.estado).toUpperCase(),
                            endereco: clean(filial.endereco),
                            numero: clean(filial.numero),
                            complemento: clean(filial.complemento),
                            principal: i === 0
                        }, { transaction });
                    }
                }
            }

            if (role === "funcionario") {
                // Funcionário não tem tabela especial, usa User normal
            }

            return createdUser;
        });

        // Salva na tabela canônica apropriada no Supabase
        if (role === "representante") {
            try {
                await sbSistemas('/comercial_representantes_bmax', 'POST', {
                    nome: name,
                    email: email || null,
                    telefone: telefone || null,
                    ativo: true
                });
            } catch (e) {
                console.error("Aviso: falha ao salvar representante em comercial_representantes_bmax:", e.message);
            }

            // Envia convite ao representante para acesso ao Motor (Supabase Auth)
            try {
                await sbSistemasAuthInvite(email);
            } catch (e) {
                console.error("Aviso: falha ao enviar convite do Motor para representante:", e.message);
            }
        }

        if (role === "revenda") {
            try {
                await sbSistemas('/comercial_revendas_bmax', 'POST', {
                    nome: name,
                    email: email || null,
                    telefone: telefone || null,
                    rep: representante || null,
                    cnpj: cnpj || null,
                    cep: cep || null,
                    cidade: cidade || null,
                    estado: estado || null,
                    ativo: true
                });
            } catch (e) {
                console.error("Aviso: falha ao salvar revenda em comercial_revendas_bmax:", e.message);
            }

            // Envia convite ao representante para acesso ao Motor (Supabase Auth)
            try {
                await sbSistemasAuthInvite(email);
            } catch (e) {
                console.error("Aviso: falha ao enviar convite do Motor para revenda:", e.message);
            }
        }

        if (role === "funcionario") {
            try {
                await sbSistemas('/comercial_funcionarios_bmax', 'POST', {
                    nome: name,
                    email: email || null,
                    ativo: true
                });
            } catch (e) {
                console.error("Aviso: falha ao salvar funcionário em comercial_funcionarios_bmax:", e.message);
            }

            // Envia convite ao funcionário para acesso ao Motor (Supabase Auth)
            try {
                await sbSistemasAuthInvite(email);
            } catch (e) {
                console.error("Aviso: falha ao enviar convite do Motor para funcionário:", e.message);
            }
        }

        if (role === "adm") {
            try {
                await sbSistemas('/comercial_admin_bmax', 'POST', {
                    nome: name,
                    email: email || null,
                    ativo: true
                });
            } catch (e) {
                console.error("Aviso: falha ao salvar admin em comercial_admin_bmax:", e.message);
            }

            // Envia convite ao admin para acesso ao Motor (Supabase Auth)
            try {
                await sbSistemasAuthInvite(email);
            } catch (e) {
                console.error("Aviso: falha ao enviar convite do Motor para admin:", e.message);
            }
        }

        // Envia email consolidado com credenciais para Portal e Motor
        if (email) {
            try {
                console.log(`📧 Enviando email para ${email}...`);
                const emailResult = await sendAccessCredentials(email, username, finalPassword, role);
                console.log(`📧 Resultado do envio: ${emailResult ? "✓ Sucesso" : "✗ Falhou"}`);
                if (!emailResult) {
                    console.error("⚠️ Email não foi enviado, mas usuário foi criado");
                }
            } catch (e) {
                console.error("❌ Erro ao enviar email de credenciais:", e.message);
            }
        } else {
            console.warn("⚠️ Email não fornecido, não será enviado");
        }

        return res.status(201).json({
            id: user.id,
            username: user.username,
            role: user.role
        });
    } catch (err) {
        console.error("Erro createUser:", err);

        if (err instanceof UniqueConstraintError) {
            return res.status(400).json({
                error: err.errors?.[0]?.message || "Já existe um cadastro com esses dados"
            });
        }

        if (err.name === "SequelizeValidationError" || err.name === "ValidationError") {
            return res.status(400).json({
                error: err.errors?.[0]?.message || "Dados inválidos"
            });
        }

        return res.status(500).json({
            error: err.message || "Erro ao criar usuário"
        });
    }
}

async function listUsers(req, res) {
    try {
        const users = await User.findAll({
            attributes: ["id", "username", "role"],
            order: [["role", "ASC"], ["username", "ASC"]]
        });

        const result = [];
        for (const u of users) {
            const entry = { id: u.id, username: u.username, role: u.role };

            if (u.role === "revenda") {
                const rev = await Revenda.findOne({ where: { user_id: u.id } });
                if (rev) {
                    entry.revenda = rev.name;
                    entry.cnpj = rev.cnpj;
                    entry.cidade = rev.cidade;
                    entry.estado = rev.estado;
                    entry.grupo = rev.grupo;
                }
            } else if (u.role === "representante") {
                const rep = await Representante.findOne({ where: { user_id: u.id } });
                if (rep) entry.email = rep.email;
            }

            result.push(entry);
        }

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function updateRevenda(req, res) {
    try {
        const { id } = req.params;
        const { grupo } = req.body;

        const rev = await Revenda.findOne({ where: { user_id: id } });
        if (!rev) return res.status(404).json({ error: "Revenda nao encontrada" });

        if (grupo !== undefined) rev.grupo = grupo || null;
        await rev.save();

        res.json({ ok: true, grupo: rev.grupo });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function listFiliais(req, res) {
    try {
        const { id } = req.params;

        const filiais = await RevendaFilial.findAll({
            where: { user_id: id },
            order: [["principal", "DESC"], ["id", "ASC"]]
        });

        res.json(filiais);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function createFilial(req, res) {
    try {
        const { id } = req.params;
        const { nome, telefone, email, cep, cidade, estado, endereco, numero, complemento } = req.body;

        if (!nome || !cep || !cidade || !estado) {
            return res.status(400).json({ error: "nome, cep, cidade e estado são obrigatórios" });
        }

        const revenda = await Revenda.findOne({ where: { user_id: id } });
        if (!revenda) return res.status(404).json({ error: "Revenda não encontrada" });

        const filial = await RevendaFilial.create({
            user_id: id,
            nome: clean(nome),
            telefone: clean(telefone),
            email: clean(email),
            cep: onlyDigits(cep),
            cidade: clean(cidade),
            estado: clean(estado).toUpperCase(),
            endereco: clean(endereco),
            numero: clean(numero),
            complemento: clean(complemento),
            principal: false
        });

        res.status(201).json(filial);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function updateFilial(req, res) {
    try {
        const { id, filial_id } = req.params;
        const { nome, telefone, email, cep, cidade, estado, endereco, numero, complemento, principal } = req.body;

        const filial = await RevendaFilial.findOne({ where: { id: filial_id, user_id: id } });
        if (!filial) return res.status(404).json({ error: "Filial não encontrada" });

        if (nome) filial.nome = clean(nome);
        if (telefone) filial.telefone = clean(telefone);
        if (email) filial.email = clean(email);
        if (cep) filial.cep = onlyDigits(cep);
        if (cidade) filial.cidade = clean(cidade);
        if (estado) filial.estado = clean(estado).toUpperCase();
        if (endereco !== undefined) filial.endereco = clean(endereco);
        if (numero !== undefined) filial.numero = clean(numero);
        if (complemento !== undefined) filial.complemento = clean(complemento);
        if (principal !== undefined) filial.principal = principal;

        await filial.save();
        res.json(filial);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

async function deleteFilial(req, res) {
    try {
        const { id, filial_id } = req.params;

        const filial = await RevendaFilial.findOne({ where: { id: filial_id, user_id: id } });
        if (!filial) return res.status(404).json({ error: "Filial não encontrada" });

        if (filial.principal) {
            return res.status(400).json({ error: "Não é possível deletar a filial principal" });
        }

        await filial.destroy();
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    createUser,
    listUsers,
    updateRevenda,
    listFiliais,
    createFilial,
    updateFilial,
    deleteFilial
};