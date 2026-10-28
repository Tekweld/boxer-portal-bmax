const express = require("express");
const { authenticate, authorize } = require("../middlewares/auth");
const { sequelize } = require("../database");
const { QueryTypes } = require("sequelize");
const { getLeads, getCustomField, syncRevendasToRD, syncRepresentantesToRD, renomearRepresentanteNoRD, renomearRevendaNoRD, reatribuirRepresentanteDaRevendaNoRD, getOpcoesRevendaRD, getOpcoesRepresentanteRD, getAliasMaps } = require("../services/rd.leads.service");
const { User, Revenda, Representante } = require("../database");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { AuditLog } = require("../services/audit.service");
const { invalidateConfigCache } = require("./config.routes");
const multer = require("multer");
const XLSX = require("xlsx");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();

// Todas as rotas deste arquivo já exigem authenticate+authorize(["adm"]) —
// usar a chave anon do Supabase aqui só sujeita o Portal às GRANTs/RLS de
// `anon` à toa, sem ganho de segurança real. Achado 02/10/2026: GRANT SELECT
// pra anon em comercial_representantes_bmax/comercial_revendas_bmax estava
// instável (401 "permission denied" intermitente, mesma rota ora funcionava
// ora não) — a chave service_role (já usada por users.controller.js nas
// mesmas tabelas) ignora RLS/GRANT de anon e resolve de vez.
const { SB_SISTEMAS_URL, sbSistemasService } = require("../config/supabaseSistemas");
const { geocodeCep } = require("../services/geocode.service");
const { normalizarCelularBR } = require("../services/telefone.service");
const { montarResumoDiario } = require("../services/whatsappResumo.service");
const { REVENDA_SEM_CREDITO } = require("../config/constants");
const sbSistemas = sbSistemasService;
const { sensitiveActionRateLimit } = require("../middlewares/rateLimit");
const { logger } = require("../logger");
const { alertarAdminErro } = require("../services/email.service");

// Rotas de gestão (vínculo revenda/grupo, representante, reset de senha) falham
// silenciosamente pra quem tenta usar o Portal — a única forma de alguém saber
// é um "erro" na tela que pode passar despercebido. Alerta por e-mail pro admin
// (fire-and-forget, nunca bloqueia a resposta de erro original) sempre que uma
// dessas ações falhar de verdade no servidor.
function erroGestao(res, err, contexto, detalhes = {}) {
    logger.error({ message: `Erro em ${contexto}`, error: err.message, stack: err.stack, ...detalhes });
    alertarAdminErro(contexto, err, detalhes).catch(() => {});
    return res.status(500).json({ error: err.message });
}

async function fetchAllRevendasAtivas() {
    return await sbSistemas('/comercial_revendas_bmax?ativo=eq.true&select=nome,nome_rd&order=nome');
}

async function syncRevendasAfterChange() {
    try {
        const revendas = await fetchAllRevendasAtivas();
        // Usa nome_rd (nome real no picklist do RD) quando setado — ver comentário em matchRevendaRD.
        const nomes = revendas.map(r => (r.nome_rd && r.nome_rd.trim()) || r.nome);
        return await syncRevendasToRD(nomes);
    } catch (err) {
        logger.error({ message: "Erro sync revendas → RD", error: err.message });
        return { error: err.message };
    }
}

router.get("/revendas-rd", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { RD_CUSTOM_FIELDS } = require("../config/constants");
        const rdToken = process.env.RD_CRM_TOKEN;
        const cfRes = await fetch(`https://crm.rdstation.com/api/v1/custom_fields?token=${rdToken}`);
        const allFields = await cfRes.json();
        const revendaField = allFields.find(f => f.id === RD_CUSTOM_FIELDS.REVENDA_LOJA);
        const optsRD = (revendaField?.opts || []).map(o => o.trim()).filter(o => o && o !== "Sem Revenda");

        // ?simples=1: só os nomes da lista do RD (modal Editar Revenda) — pula a varredura de TODOS os
        // leads e os grupos, que era o que deixava o Editar lento (28/10/2026).
        if (req.query.simples === "1") {
            return res.json({ revendas: optsRD.sort().map(nome => ({ nome })), alertas: [] });
        }

        const allDeals = await getLeads("admin", "adm");
        const usedSet = new Set();
        const invalidSet = new Set();
        const optsSet = new Set(optsRD);
        for (const d of allDeals) {
            const rev = getCustomField(d, "REVENDA/LOJA");
            if (!rev || rev === "?????" || !rev.trim()) continue;
            const trimmed = rev.trim();
            usedSet.add(trimmed);
            if (!optsSet.has(trimmed)) invalidSet.add(trimmed);
        }

        const grupos = await sequelize.query(
            `SELECT revenda_rd, grupo, email_responsavel FROM bmax_grupos`,
            { type: QueryTypes.SELECT }
        );
        const grupoMap = {};
        for (const g of grupos) grupoMap[g.revenda_rd] = g;

        const result = optsRD.sort().map(nome => ({
            nome,
            grupo: grupoMap[nome]?.grupo || null,
            email_responsavel: grupoMap[nome]?.email_responsavel || null,
            leads: usedSet.has(nome) ? true : false
        }));

        const alertas = Array.from(invalidSet).sort().map(nome => ({
            nome,
            msg: "Lead preenchido com revenda que nao existe na lista do RD"
        }));

        res.json({ revendas: result, alertas });
    } catch (err) {
        logger.error({ message: "Erro revendas-rd", error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

router.get("/grupos", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const rows = await sequelize.query(
            `SELECT grupo, array_agg(revenda_rd ORDER BY revenda_rd) as revendas,
                    (array_agg(email_responsavel))[1] as email_responsavel
             FROM bmax_grupos WHERE grupo IS NOT NULL
             GROUP BY grupo ORDER BY grupo`,
            { type: QueryTypes.SELECT }
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/grupos", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { revenda_rd, grupo, email_responsavel } = req.body;
        if (!revenda_rd) return res.status(400).json({ error: "revenda_rd obrigatorio" });

        await sequelize.query(
            `INSERT INTO bmax_grupos (revenda_rd, grupo, email_responsavel)
             VALUES (:revenda_rd, :grupo, :email_responsavel)
             ON CONFLICT (revenda_rd) DO UPDATE SET grupo = :grupo, email_responsavel = :email_responsavel`,
            { replacements: { revenda_rd, grupo: grupo || null, email_responsavel: email_responsavel || null }, type: QueryTypes.INSERT }
        );

        if (grupo && email_responsavel) {
            const allEmails = await sequelize.query(
                `SELECT DISTINCT email_responsavel FROM bmax_grupos WHERE grupo = :grupo AND email_responsavel IS NOT NULL`,
                { replacements: { grupo }, type: QueryTypes.SELECT }
            );
            const emails = allEmails.map(r => r.email_responsavel);
            if (emails.length > 0) {
                await sequelize.query(
                    `UPDATE "Revendas" SET grupo = :grupo WHERE user_id IN (
                        SELECT id FROM "Users" WHERE username IN (:emails)
                    )`,
                    { replacements: { grupo, emails }, type: QueryTypes.UPDATE }
                );
            }
        }

        res.json({ ok: true });
    } catch (err) {
        return erroGestao(res, err, "vincular grupo de revenda", { revenda_rd: req.body?.revenda_rd });
    }
});

router.get("/users", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const users = await User.findAll({
            attributes: ["id", "username", "role"],
            order: [["role", "ASC"], ["username", "ASC"]]
        });

        let canonRepsMap = {};
        let canonRepsByEmail = {};
        try {
            const canon = await sbSistemas('/comercial_representantes_bmax?select=*&order=nome');
            canonRepsMap = Object.fromEntries(canon.map(r => [r.nome, r]));
            // Desde 11/09/2026 usuário novo nasce com e-mail como username, não mais
            // com o nome de exibição — sem este índice por e-mail, o match abaixo
            // (por `u.username`) nunca acerta pra ninguém cadastrado depois disso, e
            // cada representante com login passa a aparecer TAMBÉM como uma segunda
            // linha "sem login" (bug real: achado 14/09/2026, tela mostrando todo
            // representante duplicado).
            // Com e-mail repetido entre cadastros (duplicata), vence o ATIVO e o de nome
            // "real" (não o nome-e-mail) — antes quem vinha por último na ordenação ganhava
            // (caso Fernando, 08/10/2026: o duplicado "roubava" o vínculo do login).
            for (const r of canon.filter(x => x.email)) {
                const k = r.email.toLowerCase();
                const atual = canonRepsByEmail[k];
                const melhor = !atual
                    || (atual.ativo === false && r.ativo !== false)
                    || ((atual.nome || "").includes("@") && !(r.nome || "").includes("@") && !(atual.ativo !== false && r.ativo === false));
                if (melhor) canonRepsByEmail[k] = r;
            }
        } catch (e) { logger.error({ message: "Erro ao buscar representantes canônicos", error: e.message }); }

        const result = [];
        const nomesComLogin = new Set();
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
                    entry.telefone = rev.telefone || null;
                    entry.whatsapp = { ...normalizarCelularBR(rev.telefone), aceiteEm: rev.whatsapp_aceite_em || null };
                }
                // Cadastro canônico (comercial_revendas_bmax) vinculado a este login —
                // pode ser diferente da Revenda acima (login), ver rota vincular-usuario.
                const cadastroVinculado = await sbSistemas(`/comercial_revendas_bmax?user_id=eq.${u.id}&select=id,nome`);
                entry.revendaCadastroVinculada = cadastroVinculado?.[0] || null;
            } else if (u.role === "representante") {
                const rep = await Representante.findOne({ where: { user_id: u.id } });
                const canon = canonRepsByEmail[u.username.toLowerCase()] || canonRepsMap[u.username];
                entry.email = canon?.email || rep?.email || null;
                entry.telefone = canon?.telefone || null;
                entry.ativo = canon ? canon.ativo : true;
                entry.temLoginMotor = !!canon?.tem_login;
                // Marca pelo NOME canônico (não pelo username) — é essa chave que o
                // laço abaixo usa pra decidir se já tem login e não deve duplicar.
                nomesComLogin.add(canon ? canon.nome : u.username);
            }
            result.push(entry);
        }

        // Representantes cadastrados que ainda não têm login no Portal — aparecem
        // aqui também, pois a aba Usuários passou a ser a fonte única de gestão.
        for (const nome of Object.keys(canonRepsMap)) {
            if (nomesComLogin.has(nome)) continue;
            const r = canonRepsMap[nome];
            result.push({
                id: null, username: nome, role: "representante",
                email: r.email, telefone: r.telefone, ativo: r.ativo,
                temLoginMotor: !!r.tem_login, semLogin: true
            });
        }

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// WhatsApp do login de revenda (canal só de aviso): grava o celular normalizado e o aceite.
// Body: { telefone?: string, aceite?: boolean }. Aceite = a revenda autorizou receber avisos.
router.patch("/users/:id/whatsapp", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const rev = await Revenda.findOne({ where: { user_id: req.params.id } });
        if (!rev) return res.status(404).json({ error: "Login de revenda não encontrado" });
        const { telefone, aceite } = req.body;
        const antes = { telefone: rev.telefone, aceite: !!rev.whatsapp_aceite_em };
        if (telefone !== undefined) {
            const tel = normalizarCelularBR(telefone);
            if (String(telefone).trim() === "") rev.telefone = null;
            else if (!tel.valido) return res.status(400).json({ error: `Celular inválido: ${tel.motivo}` });
            else rev.telefone = tel.nacional;
        }
        if (aceite === true && !rev.whatsapp_aceite_em) {
            if (!normalizarCelularBR(rev.telefone).valido) return res.status(400).json({ error: "Cadastre um celular válido antes de registrar o aceite" });
            rev.whatsapp_aceite_em = new Date();
        }
        if (aceite === false) rev.whatsapp_aceite_em = null;
        await rev.save();
        await AuditLog(req, { action: "UPDATE_WHATSAPP_REVENDA", entityType: "User", entityId: String(req.params.id), metadata: { antes, depois: { telefone: rev.telefone, aceite: !!rev.whatsapp_aceite_em } } });
        res.json({ ok: true, telefone: rev.telefone, whatsapp: { ...normalizarCelularBR(rev.telefone), aceiteEm: rev.whatsapp_aceite_em } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Prévia do que seria enviado por WhatsApp hoje (NÃO envia nada) — ver whatsappResumo.service.js
router.get("/whatsapp/previa", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        res.json(await montarResumoDiario());
    } catch (err) {
        logger.error({ message: "Erro ao montar prévia do WhatsApp", error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

// Troca (ou limpa, com nome:null) o nome de revenda que um login enxerga — é esse
// nome (Revendas.name, Postgres) que decide quais leads aparecem pra ele, comparado
// direto com REVENDA/LOJA no RD (ver rd.leads.service.js:getLeads). Existe hoje só
// na criação do login (Novo Usuário); esta rota fecha a lacuna de poder trocar
// depois — tanto pra mover um login pra outra revenda quanto pra ligar um segundo
// login à mesma revenda que outro já atende. Mesma trava de segurança usada em
// vincular-usuario/PATCH revendas-bmax/:id: só aceita um nome que existe de
// verdade no picklist ao vivo do RD, pra não deixar o login "sem leads" por um
// nome que nunca vai bater com nenhum deal.
router.patch("/users/:id/revenda", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { id } = req.params;
        const { nome } = req.body;

        const user = await User.findByPk(id);
        if (!user || user.role !== "revenda") return res.status(400).json({ error: "Usuário inválido — precisa ser um login de revenda" });

        if (nome) {
            const opcoesRD = await getOpcoesRevendaRD();
            if (!opcoesRD.includes(nome)) {
                return res.status(400).json({ error: `"${nome}" não existe no picklist do RD — escolha um nome da lista ou cadastre a revenda primeiro.` });
            }
        }

        // Todo login revenda já nasce com uma linha em Revendas (cnpj/cep/cidade/estado
        // obrigatórios no model) — não criamos uma aqui pra não violar essas colunas.
        const rev = await Revenda.findOne({ where: { user_id: user.id } });
        if (!rev) return res.status(400).json({ error: "Este login não tem um registro de revenda associado — contate o suporte." });
        await rev.update({ name: nome || null });

        res.json({ ok: true, revenda: { user_id: user.id, name: rev.name } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Lista todos os logins (Revendas.name) que hoje enxergam os leads de um cadastro —
// pode ser mais de um (vários usuários/e-mails pra mesma revenda). Separado de
// "Usuário Vinculado" (comercial_revendas_bmax.user_id), que é só o dono do
// cadastro/bookkeeping (email/telefone/CNPJ) e é sempre 1:1 por natureza.
router.get("/revendas-bmax/:id/usuarios-vinculados", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { id } = req.params;
        const row = await sbSistemas(`/comercial_revendas_bmax?id=eq.${id}&select=nome,nome_rd`);
        const nomeRd = (row[0]?.nome_rd || row[0]?.nome || "").trim();
        if (!nomeRd) return res.json([]);

        const revendas = await Revenda.findAll({ where: { name: nomeRd } });
        const userIds = revendas.map(r => r.user_id).filter(Boolean);
        const users = userIds.length ? await User.findAll({ where: { id: userIds }, attributes: ["id", "username"] }) : [];
        const usernameMap = Object.fromEntries(users.map(u => [u.id, u.username]));

        res.json(revendas.map(r => ({ user_id: r.user_id, username: usernameMap[r.user_id] || null })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete("/users/:id", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { id } = req.params;
        const user = await User.findByPk(id);
        if (!user) return res.status(404).json({ error: "Usuario nao encontrado" });
        if (user.id === req.user.id) return res.status(400).json({ error: "Nao pode excluir a si mesmo" });

        const wasRepresentante = user.role === "representante";
        const nome = user.username;
        await user.destroy();

        if (wasRepresentante) {
            await sbSistemas(`/comercial_representantes_bmax?nome=eq.${encodeURIComponent(nome)}`, 'PATCH', { tem_login: false }).catch(() => {});
        }

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch("/users/:id/grupo", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { id } = req.params;
        const { grupo } = req.body;
        const rev = await Revenda.findOne({ where: { user_id: id } });
        if (!rev) return res.status(404).json({ error: "Revenda nao encontrada" });

        rev.grupo = grupo || null;
        await rev.save();
        res.json({ ok: true, grupo: rev.grupo });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Charset sem caracteres ambíguos (sem 0/O, 1/I/l) — senha gerada precisa ser
// lida/digitada por telefone/WhatsApp sem confusão.
const SENHA_GERADA_CHARSET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
function gerarSenhaAleatoria(tamanho = 10) {
    const bytes = crypto.randomBytes(tamanho);
    let senha = "";
    for (let i = 0; i < tamanho; i++) senha += SENHA_GERADA_CHARSET[bytes[i] % SENHA_GERADA_CHARSET.length];
    return senha;
}

router.patch("/users/:id/reset-password", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { id } = req.params;
        const { password, gerar } = req.body;

        let novaSenha;
        if (gerar) {
            novaSenha = gerarSenhaAleatoria();
        } else {
            if (!password || password.length < 6) return res.status(400).json({ error: "Senha deve ter no minimo 6 caracteres" });
            novaSenha = password;
        }

        const user = await User.findByPk(id);
        if (!user) return res.status(404).json({ error: "Usuario nao encontrado" });

        // Sobrescreve o hash antigo — a senha anterior deixa de funcionar
        // imediatamente, não existe "acumular" credenciais válidas.
        user.password = await bcrypt.hash(novaSenha, 10);
        await user.save();

        await AuditLog(req, {
            action: "PASSWORD_RESET",
            entityType: "User",
            entityId: user.id,
            metadata: { username: user.username, role: user.role, gerarAutomatico: !!gerar }
        }).catch(() => {});

        // A senha em texto puro só existe nesta resposta — depois do save,
        // só o hash bcrypt (irreversível) fica gravado.
        res.json({ ok: true, ...(gerar ? { password: novaSenha } : {}) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── CRUD Revendas BMax (Supabase boxer-sistemas) ───────────

router.get("/revendas-bmax", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const rows = await sbSistemas('/comercial_revendas_bmax?select=id,nome,cidade,estado,classe,ativo,rep,grupo,telefone,email,cnpj,cep,user_id,nome_rd&order=nome');

        // Achado 23/09/2026: o cadastro da revenda (aqui) e o login dela (tabela
        // Revenda do Postgres, criado em createUser) sempre foram duas fontes
        // independentes — sem vínculo, campos como email/telefone ficavam em
        // branco quando o cadastro nasceu só pela aba Gestão (sem login), e não
        // tinha como um admin corrigir isso na tela sem editar o registro errado.
        // `user_id` guarda o id do login vinculado; aqui resolve o e-mail dele pra
        // mostrar na lista/modal, sem duplicar o dado.
        const userIds = rows.filter(r => r.user_id).map(r => r.user_id);
        let usuariosPorId = {};
        if (userIds.length) {
            const users = await User.findAll({ where: { id: userIds }, attributes: ["id", "username"] });
            usuariosPorId = Object.fromEntries(users.map(u => [u.id, u.username]));
        }
        const comVinculo = rows.map(r => ({ ...r, usuarioVinculado: r.user_id ? (usuariosPorId[r.user_id] || null) : null }));

        res.json(comVinculo);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Lista logins role=revenda que ainda não estão vinculados a nenhum cadastro
// em comercial_revendas_bmax — alimenta o dropdown "Vincular Usuário".
router.get("/revendas-bmax/usuarios-disponiveis", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const vinculados = await sbSistemas('/comercial_revendas_bmax?user_id=not.is.null&select=user_id');
        const idsVinculados = new Set((vinculados || []).map(v => v.user_id));

        const usersRevenda = await User.findAll({ where: { role: "revenda" }, attributes: ["id", "username"], order: [["username", "ASC"]] });
        const disponiveis = [];
        for (const u of usersRevenda) {
            if (idsVinculados.has(u.id)) continue;
            const rev = await Revenda.findOne({ where: { user_id: u.id } });
            disponiveis.push({ id: u.id, username: u.username, nomeCadastroLogin: rev?.name || null, email: rev?.email || null, telefone: rev?.telefone || null });
        }
        res.json(disponiveis);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch("/revendas-bmax/:id/vincular-usuario", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { id } = req.params;
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ error: "user_id é obrigatório" });

        const user = await User.findByPk(user_id);
        if (!user || user.role !== "revenda") return res.status(400).json({ error: "Usuário inválido — precisa ser um login de revenda" });

        const jaVinculado = await sbSistemas(`/comercial_revendas_bmax?user_id=eq.${user_id}&select=id,nome`);
        if ((jaVinculado || []).some(r => String(r.id) !== String(id))) {
            return res.status(400).json({ error: `Esse login já está vinculado à revenda "${jaVinculado[0].nome}"` });
        }

        const atual = await sbSistemas(`/comercial_revendas_bmax?id=eq.${id}&select=email,telefone,nome,nome_rd`);
        const rev = await Revenda.findOne({ where: { user_id } });
        // Só preenche o que está vazio — nunca sobrescreve um dado já cadastrado
        // manualmente em Gestão, mesmo que o login tenha outro valor.
        const updates = { user_id };
        if (!atual[0]?.email && rev?.email) updates.email = rev.email;
        if (!atual[0]?.telefone && rev?.telefone) updates.telefone = rev.telefone;

        const row = await sbSistemasService(`/comercial_revendas_bmax?id=eq.${id}`, 'PATCH', updates);
        invalidateConfigCache();

        // Mesmo motivo do rename (ver PATCH /:id): o login precisa carregar o nome que
        // realmente bate com o RD, senão o vínculo "amarra" mas a revenda continua sem
        // ver os próprios leads. Vincular é o outro momento (além de renomear) em que
        // esse valor pode ficar desalinhado. Mesma blindagem: só copia pro login se o
        // nome já existir de verdade no picklist do RD — não arriscar quebrar um login
        // que já está funcionando (ex.: as 19 revendas vinculadas em 24/09/2026, cujo
        // nome de cadastro é bem diferente do nome usado no RD).
        const nomeParaLogin = atual[0]?.nome_rd || atual[0]?.nome;
        let loginRenomeado = false;
        if (nomeParaLogin && rev && rev.name !== nomeParaLogin) {
            try {
                const opcoesRD = await getOpcoesRevendaRD();
                if (opcoesRD.includes(nomeParaLogin)) {
                    await rev.update({ name: nomeParaLogin });
                    loginRenomeado = true;
                } else {
                    logger.error({ message: "Rename do login NÃO aplicado ao vincular — nome do cadastro não bate com nenhuma opção viva do RD", nomeTentado: nomeParaLogin, user_id, nomeAtualDoLogin: rev.name });
                }
            } catch (e) {
                logger.error({ message: "Erro ao sincronizar Revenda.name (login) após vincular", error: e.message, user_id });
            }
        }

        res.json({ ok: true, revenda: row[0] || row, loginRenomeado });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch("/revendas-bmax/:id/desvincular-usuario", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { id } = req.params;
        const row = await sbSistemasService(`/comercial_revendas_bmax?id=eq.${id}`, 'PATCH', { user_id: null });
        invalidateConfigCache();
        res.json({ ok: true, revenda: row[0] || row });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Auditoria do espelhamento Portal → Motor: o Motor lê SÓ comercial_revendas_bmax
// (ativo + lat/lng), então toda revenda ativa precisa ter coordenada, e todo login
// de revenda (Postgres) precisa apontar pra um cadastro ativo.
router.get("/revendas-bmax/espelhamento", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const cadastros = await sbSistemas('/comercial_revendas_bmax?select=id,nome,nome_rd,cep,cidade,estado,lat,lng,cnpj,user_id,ativo&ativo=eq.true&limit=1000');
        const semCoordenada = cadastros.filter(r => r.lat == null || r.lng == null)
            .map(r => ({ id: r.id, nome: r.nome, cep: r.cep, cidade: r.cidade, estado: r.estado }));
        const semCep = cadastros.filter(r => !r.cep).map(r => ({ id: r.id, nome: r.nome }));
        const semCnpj = cadastros.filter(r => !r.cnpj).map(r => ({ id: r.id, nome: r.nome }));

        const nomesAtivos = new Set(cadastros.flatMap(r => [r.nome, r.nome_rd].filter(Boolean)));
        const logins = await Revenda.findAll({ attributes: ["user_id", "name"] });
        const loginsSemCadastro = [...new Set(logins.map(l => l.name).filter(n => n && !REVENDA_SEM_CREDITO.includes(n) && !nomesAtivos.has(n)))];

        res.json({
            totalAtivas: cadastros.length,
            semCoordenada, semCep, semCnpj, loginsSemCadastro,
            ok: !semCoordenada.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Calcula lat/lng das revendas ativas que ainda não têm (CEP → BrasilAPI → cidade/UF).
// Lote curto por chamada (Nominatim limita ~1 req/s e a função serverless tem teto de 60s).
router.post("/revendas-bmax/geocodificar-pendentes", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const pendentes = await sbSistemas('/comercial_revendas_bmax?select=id,nome,cep,cidade,estado&ativo=eq.true&or=(lat.is.null,lng.is.null)&limit=1000');
        const lote = pendentes.slice(0, 15);
        const resolvidas = [], falharam = [];
        for (const r of lote) {
            const geo = await geocodeCep(r.cep, { cidade: r.cidade, estado: r.estado });
            if (geo.lat !== null && geo.lng !== null) {
                await sbSistemas(`/comercial_revendas_bmax?id=eq.${r.id}`, 'PATCH', { lat: geo.lat, lng: geo.lng });
                resolvidas.push(r.nome);
            } else {
                falharam.push(r.nome);
            }
        }
        if (resolvidas.length) invalidateConfigCache();
        res.json({ resolvidas, falharam, restantes: Math.max(pendentes.length - lote.length, 0) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Nome no RD = chave única que liga RD, Portal e Motor (André, 28/10/2026): nunca duas revendas ATIVAS com o mesmo.
async function nomeRdEmUso(nomeRd, ignorarId) {
    const alvo = String(nomeRd || "").trim().toLowerCase();
    const rows = await sbSistemas('/comercial_revendas_bmax?ativo=eq.true&select=id,nome,nome_rd');
    return (rows || []).find(r => String(r.id) !== String(ignorarId || "") && String(r.nome_rd || r.nome || "").trim().toLowerCase() === alvo) || null;
}

router.post("/revendas-bmax", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { nome, cidade, estado, classe, rep, grupo, cep, telefone, email, cnpj } = req.body;
        if (!nome || !nome.trim()) return res.status(400).json({ error: "Nome é obrigatório" });

        // nome no RD sempre preenchido (padrão = nome) e único entre as ativas
        const nomeRdFinal = String(req.body.nome_rd || nome).trim();
        const duplicada = await nomeRdEmUso(nomeRdFinal);
        if (duplicada) return res.status(400).json({ error: `Já existe uma revenda ativa chamada "${nomeRdFinal}". O nome no RD é único: edite a existente ou escolha outro nome.` });

        // login junto: valida TUDO antes de gravar o cadastro (não deixa cadastro pela metade)
        const criarLogin = req.body.criar_login === true;
        if (criarLogin) {
            const v = await require("../services/revendaLogin.service").validarNovoLogin({ email, cnpj, cep, cidade, estado });
            if (v.erro) return res.status(400).json({ error: v.erro });
        }

        let lat = null, lng = null, cidadeFinal = cidade || null, estadoFinal = estado || null;
        if (cep) {
            const geo = await geocodeCep(cep, { cidade, estado });
            lat = geo.lat; lng = geo.lng;
            cidadeFinal = cidadeFinal || geo.cidade || null;
            estadoFinal = estadoFinal || geo.estado || null;
        }

        const row = await sbSistemasService('/comercial_revendas_bmax', 'POST', {
            nome: nome.trim(), nome_rd: nomeRdFinal, cidade: cidadeFinal, estado: estadoFinal,
            classe: classe || null, rep: rep || null, grupo: grupo || null, ativo: true,
            cep: cep || null, telefone: telefone || null, email: email || null, cnpj: cnpj || null,
            lat, lng
        });
        invalidateConfigCache();
        const sync = await syncRevendasAfterChange();

        let login = null;
        if (criarLogin) {
            const novo = Array.isArray(row) ? row[0] : row;
            login = await require("../services/revendaLogin.service").criarLoginDeRevenda({
                nomeRd: nomeRdFinal, email, telefone, cnpj, cep, cidade: cidadeFinal, estado: estadoFinal, grupo,
                cadastroId: novo && novo.id, enviarCredenciais: req.body.enviar_credenciais === true
            });
        }
        res.json({ revenda: row[0] || row, sync, geocoded: lat !== null, login });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch("/revendas-bmax/:id", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { id } = req.params;
        const updates = {};
        for (const key of ['nome', 'nome_rd', 'cidade', 'estado', 'classe', 'rep', 'grupo', 'ativo', 'telefone', 'email', 'cnpj', 'cep']) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }
        if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Nenhum campo para atualizar" });

        // nome no RD único entre as revendas ativas (só confere quando o nome/ativação muda)
        if ('nome' in updates || 'nome_rd' in updates || updates.ativo === true) {
            const atualNome = await sbSistemas(`/comercial_revendas_bmax?id=eq.${id}&select=nome,nome_rd,ativo`);
            const a = atualNome[0] || {};
            const ficaAtiva = 'ativo' in updates ? updates.ativo !== false : a.ativo !== false;
            const nomeRdNovo = String(('nome_rd' in updates ? updates.nome_rd : a.nome_rd) || ('nome' in updates ? updates.nome : a.nome) || "").trim();
            if (ficaAtiva && nomeRdNovo) {
                const dup = await nomeRdEmUso(nomeRdNovo, id);
                if (dup) return res.status(400).json({ error: `Já existe outra revenda ativa chamada "${nomeRdNovo}". O nome no RD é único (liga RD, Portal e Motor): ajuste o nome ou desative a outra.` });
            }
        }

        let nomeAntigo = null;
        let repAntigo = null;
        let nomeRdAntigo = null;
        if ('nome' in updates || 'rep' in updates || 'nome_rd' in updates) {
            const atual = await sbSistemas(`/comercial_revendas_bmax?id=eq.${id}&select=nome,rep,nome_rd`);
            nomeAntigo = atual[0]?.nome || null;
            repAntigo = atual[0]?.rep || null;
            nomeRdAntigo = atual[0]?.nome_rd || null;
        }

        // Recalcula lat/lng sempre que o CEP muda — sem isso o Motor nunca acha essa
        // revenda dentro do raio, mesmo com o cadastro correto (achado 2026-09-11).
        if ('cep' in updates && updates.cep) {
            const geo = await geocodeCep(updates.cep, { cidade: updates.cidade, estado: updates.estado });
            updates.lat = geo.lat;
            updates.lng = geo.lng;
        }

        updates.editado_em = new Date().toISOString();
        updates.editado_por = req.user.username || req.user.email || 'admin';

        const row = await sbSistemasService(`/comercial_revendas_bmax?id=eq.${id}`, 'PATCH', updates);
        invalidateConfigCache();
        // Achado 24/09/2026: nome_rd ficava de fora daqui — editar só o "Nome no RD
        // CRM" nunca disparava a sincronização, então a opção nova nunca nascia no
        // RD de verdade (o campo existia só de fachada). nome_rd tem que disparar
        // sync igual a nome.
        const needsSync = 'nome' in updates || 'nome_rd' in updates || 'ativo' in updates;
        // Ordem obrigatória: sincronizar o picklist do RD (que já inclui o nome novo,
        // pois vem da lista de revendas ativas pós-PATCH) ANTES de reescrever os deals —
        // o campo REVENDA/LOJA no RD é um picklist estrito e descarta valores fora da
        // lista de opções (mesmo bug corrigido em renomearRepresentanteNoRD).
        const sync = needsSync ? await syncRevendasAfterChange() : null;

        // Nome que os deals dessa revenda carregam DE VERDADE no RD hoje: nome_rd antigo,
        // senão o nome de cadastro antigo (ver comentário em matchRevendaRD).
        const nomeRdAntesDoPatch = nomeRdAntigo || nomeAntigo;
        const nomeRdDepoisDoPatch = ('nome_rd' in updates ? updates.nome_rd : nomeRdAntigo) || updates.nome || nomeAntigo;

        // Orçamento de tempo pras varreduras de deals no RD (rename + reatribuir podem
        // cair na mesma requisição) — reparte o que sobra até perto do limite de 60s da
        // função (vercel.json), deixando folga pro resto da rota. Revenda com poucos
        // leads termina tranquilo dentro disso; revenda com muitos leads é cortada e
        // devolve um cursor pro front continuar sozinho (ver /revendas-bmax/continuar-rd).
        const inicioVarreduraRD = Date.now();
        const ORCAMENTO_VARREDURA_RD_MS = 40000;
        const continuacoesPendentes = [];

        let renomeRD = null;
        const houveRenameRd = nomeRdAntesDoPatch && nomeRdDepoisDoPatch && nomeRdAntesDoPatch !== nomeRdDepoisDoPatch;
        if (houveRenameRd) {
            try {
                renomeRD = await renomearRevendaNoRD(nomeRdAntesDoPatch, nomeRdDepoisDoPatch, { maxMs: ORCAMENTO_VARREDURA_RD_MS });
                if (renomeRD.done === false) {
                    continuacoesPendentes.push({ tipo: "nome-revenda", nomeAntigo: nomeRdAntesDoPatch, nomeNovo: nomeRdDepoisDoPatch, cursor: renomeRD.cursor });
                }
            } catch (e) {
                logger.error({ message: "Erro ao renomear revenda no RD", error: e.message });
                renomeRD = { error: e.message };
            }
        }

        let reatribuicaoRD = null;
        const houveTrocaDeRep = 'rep' in updates && (updates.rep || null) !== (repAntigo || null);
        if (houveTrocaDeRep) {
            // Nome atual da revenda no RD é sempre o pós-rename — o filtro por
            // REVENDA/LOJA precisa bater com o nome vigente nos deals agora.
            const nomeVigenteNoRD = nomeRdDepoisDoPatch || row[0]?.nome;
            const restante = Math.max(ORCAMENTO_VARREDURA_RD_MS - (Date.now() - inicioVarreduraRD), 5000);
            try {
                reatribuicaoRD = await reatribuirRepresentanteDaRevendaNoRD(nomeVigenteNoRD, updates.rep, { maxMs: restante });
                if (reatribuicaoRD.done === false) {
                    continuacoesPendentes.push({ tipo: "rep-revenda", revendaNome: nomeVigenteNoRD, novoRep: updates.rep, cursor: reatribuicaoRD.cursor });
                }
            } catch (e) {
                logger.error({ message: "Erro ao reatribuir representante da revenda no RD", error: e.message });
                reatribuicaoRD = { error: e.message };
            }
        }

        // Fecha o 3º elo (achado 24/09/2026): quem decide os leads que uma revenda vê
        // não é este cadastro, é Revenda.name no Postgres (comparado direto com
        // REVENDA/LOJA no RD — ver leads.controller.js). Sem isto, renomear aqui e no
        // RD deixava o login para trás com o nome antigo, e a revenda parava de ver
        // os próprios leads silenciosamente. Só roda se já existe login vinculado.
        let loginRenomeado = false;
        if (houveRenameRd) {
            const userIdVinculado = row[0]?.user_id ?? (await sbSistemas(`/comercial_revendas_bmax?id=eq.${id}&select=user_id`))[0]?.user_id;
            if (userIdVinculado) {
                try {
                    const opcoesRD = await getOpcoesRevendaRD();
                    if (opcoesRD.includes(nomeRdDepoisDoPatch)) {
                        await Revenda.update({ name: nomeRdDepoisDoPatch }, { where: { user_id: userIdVinculado } });
                        loginRenomeado = true;
                    } else {
                        logger.error({ message: "Rename do login NÃO aplicado — nome não bate com nenhuma opção viva do RD (evita quebrar visibilidade de leads)", nomeTentado: nomeRdDepoisDoPatch, userIdVinculado });
                    }
                } catch (e) {
                    logger.error({ message: "Erro ao sincronizar Revenda.name (login) após rename", error: e.message, userIdVinculado });
                }
            }
        }

        res.json({ revenda: row[0] || row, sync, renomeRD, reatribuicaoRD, loginRenomeado, continuacoesPendentes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Continua uma varredura de deals no RD que foi cortada por orçamento de tempo
// (ver ORCAMENTO_VARREDURA_RD_MS acima) — o front chama em loop, passando de volta
// o cursor recebido, até a resposta trazer done:true. Cada chamada fica bem abaixo
// do limite de 60s da função, então funciona pra qualquer volume de leads.
router.post("/revendas-bmax/continuar-rd", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { tipo, cursor } = req.body;
        const opts = { cursor, maxMs: 45000 };
        let resultado;
        if (tipo === "nome-revenda") {
            resultado = await renomearRevendaNoRD(req.body.nomeAntigo, req.body.nomeNovo, opts);
        } else if (tipo === "rep-revenda") {
            resultado = await reatribuirRepresentanteDaRevendaNoRD(req.body.revendaNome, req.body.novoRep, opts);
        } else if (tipo === "nome-representante") {
            resultado = await renomearRepresentanteNoRD(req.body.nomeAntigo, req.body.nomeNovo, opts);
        } else {
            return res.status(400).json({ error: "tipo inválido" });
        }
        res.json(resultado);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/sync-revendas-rd", authenticate, authorize(["adm"]), sensitiveActionRateLimit, async (req, res) => {
    try {
        const result = await syncRevendasAfterChange();
        if (result.error) return res.status(500).json({ error: result.error });
        res.json({ ok: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/sync-reps-rd", authenticate, authorize(["adm"]), sensitiveActionRateLimit, async (req, res) => {
    try {
        const reps = await sbSistemas('/comercial_representantes_bmax?select=nome,ativo');
        const nomesAtivos = reps.filter(r => r.ativo).map(r => r.nome);
        const result = await syncRepresentantesToRD(nomesAtivos);
        if (result.error) return res.status(500).json({ error: result.error });
        res.json({ ok: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── CRUD Representantes (comercial_representantes_bmax — fonte única) ────

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

router.get("/representantes-bmax", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const reps = await sbSistemas('/comercial_representantes_bmax?select=*&order=nome');
        res.json(reps);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put("/representantes-bmax", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { representantes, alvoNome, alvoNomeAntigo, senha, convidarMotor } = req.body;
        if (!Array.isArray(representantes)) return res.status(400).json({ error: "Array de representantes esperado" });

        let renomeRD = null;
        let sync = null;
        const continuacoesPendentes = [];
        const nomesAtivos = representantes.filter(r => r.ativo).map(r => r.nome);

        // Renomear é uma operação diferente de editar: precisa mudar a chave primária
        // (nome) do registro existente — e o username de login, se houver — em vez de
        // criar um registro novo e deixar o antigo (com login/e-mail) órfão. Também
        // corrige o nome em todas as negociações já existentes no RD (histórico
        // completo), para o representante não perder visibilidade/comissão sobre
        // leads antigos.
        if (alvoNomeAntigo && alvoNome && alvoNomeAntigo !== alvoNome) {
            const jaExiste = await sbSistemas(`/comercial_representantes_bmax?nome=eq.${encodeURIComponent(alvoNome)}&select=nome`);
            if (jaExiste.length) return res.status(400).json({ error: `Já existe um representante chamado "${alvoNome}".` });

            await sbSistemas(`/comercial_representantes_bmax?nome=eq.${encodeURIComponent(alvoNomeAntigo)}`, 'PATCH', {
                nome: alvoNome, atualizado_em: new Date().toISOString()
            });

            const userAntigo = await User.findOne({ where: { username: alvoNomeAntigo, role: "representante" } });
            if (userAntigo) {
                userAntigo.username = alvoNome;
                await userAntigo.save();
            }

            const alvoRenomeado = representantes.find(r => r.nome === alvoNome);
            if (alvoRenomeado?.email) {
                await sbSistemas(`/comercial_bmax_admins?email=eq.${encodeURIComponent(alvoRenomeado.email)}`, 'PATCH', { nome: alvoNome })
                    .catch(() => {}); // best-effort: atualiza display name se ele tiver acesso ao Motor
            }

            // Importante: o campo REPRESENTANTE no RD é um picklist estrito (allow_new:false) —
            // o RD rejeita silenciosamente qualquer valor de deal que não esteja na lista de
            // opções. Por isso o picklist tem que ser atualizado com o nome novo ANTES de
            // tentar reescrever os deals, senão a escrita não persiste (bug encontrado em
            // 2026-09-04: a ordem estava invertida e o rename nunca fazia efeito de verdade).
            try {
                sync = await syncRepresentantesToRD(nomesAtivos);
            } catch (e) { logger.error({ message: "Erro sync reps → RD", error: e.message }); sync = { error: e.message }; }

            try {
                renomeRD = await renomearRepresentanteNoRD(alvoNomeAntigo, alvoNome, { maxMs: 40000 });
                if (renomeRD.done === false) {
                    continuacoesPendentes.push({ tipo: "nome-representante", nomeAntigo: alvoNomeAntigo, nomeNovo: alvoNome, cursor: renomeRD.cursor });
                }
            } catch (e) {
                logger.error({ message: "Erro ao renomear representante no RD", error: e.message });
                renomeRD = { error: e.message };
            }
        }

        for (const r of representantes) {
            if (!r.nome || !r.nome.trim()) continue;
            // PATCH filtrado por nome não lança erro quando não acha nenhuma linha
            // (PostgREST devolve 200 com array vazio) — o fallback POST no .catch()
            // nunca disparava pra representante genuinamente novo, então "criar"
            // podia devolver sucesso sem gravar nada. Upsert de verdade precisa de
            // on_conflict + merge-duplicates (mesma regra já documentada e já usada
            // em saveSnapshot).
            await sbSistemas(
                `/comercial_representantes_bmax?on_conflict=nome`,
                'POST',
                {
                    nome: r.nome.trim(),
                    email: r.email || null,
                    telefone: r.telefone || null,
                    ativo: !!r.ativo,
                    atualizado_em: new Date().toISOString()
                },
                { Prefer: 'resolution=merge-duplicates,return=minimal' }
            );
        }

        // Espelha na chave legada que o bmax-motor ainda lê diretamente (comercial_bmax_config),
        // para não depender de alterar o index.html do Motor nesta consolidação.
        try {
            const todos = await sbSistemas('/comercial_representantes_bmax?select=nome,ativo&order=nome');
            const legado = todos.map(r => ({ nome: r.nome, ativo: r.ativo }));
            // Mesma regra de upsert de sempre — PATCH filtrado não lança erro em zero
            // match, então o fallback POST no .catch() nunca disparava se a chave
            // ainda não existisse (ver saveSnapshot em app.js e o fix acima nesse
            // mesmo arquivo).
            await sbSistemas(
                `/comercial_bmax_config?on_conflict=chave`,
                'POST',
                { chave: 'representantes_bmax', valor: JSON.stringify(legado) },
                { Prefer: 'resolution=merge-duplicates,return=minimal' }
            );
        } catch (e) { logger.error({ message: "Erro ao espelhar representantes para comercial_bmax_config", error: e.message }); }

        const alvo = alvoNome ? representantes.find(r => r.nome === alvoNome) : null;
        let acesso = null;

        if (alvo && senha) {
            if (senha.length < 6) return res.status(400).json({ error: "Senha deve ter no mínimo 6 caracteres" });
            if (!alvo.email) return res.status(400).json({ error: "E-mail é obrigatório para criar acesso ao Portal" });

            const hashedPassword = await bcrypt.hash(senha, 10);
            const existingUser = await User.findOne({ where: { username: alvo.nome } });

            if (existingUser) {
                existingUser.password = hashedPassword;
                await existingUser.save();
                await Representante.upsert({ user_id: existingUser.id, email: alvo.email });
            } else {
                await sequelize.transaction(async (transaction) => {
                    const createdUser = await User.create({ username: alvo.nome, password: hashedPassword, role: "representante" }, { transaction });
                    await Representante.create({ user_id: createdUser.id, email: alvo.email }, { transaction });
                });
            }
            await sbSistemas(`/comercial_representantes_bmax?nome=eq.${encodeURIComponent(alvo.nome)}`, 'PATCH', { tem_login: true });
            acesso = { portal: "ok" };
        }

        if (alvo && convidarMotor) {
            if (!alvo.email) return res.status(400).json({ error: "E-mail é obrigatório para convidar ao Motor" });
            try {
                await sbSistemasAuthInvite(alvo.email);
                await sbSistemas('/comercial_bmax_admins', 'POST', { email: alvo.email, nome: alvo.nome, perfil: 'representante', ativo: true })
                    .catch(() => sbSistemas(`/comercial_bmax_admins?email=eq.${encodeURIComponent(alvo.email)}`, 'PATCH', { nome: alvo.nome, perfil: 'representante', ativo: true }));
                acesso = { ...acesso, motor: "convite enviado" };
            } catch (e) {
                acesso = { ...acesso, motor: `erro: ${e.message}` };
            }
        }

        invalidateConfigCache();
        // Se não houve rename, ainda precisamos sincronizar o picklist (ativo/inativo pode ter mudado).
        if (!(alvoNomeAntigo && alvoNome && alvoNomeAntigo !== alvoNome)) {
            try {
                sync = await syncRepresentantesToRD(nomesAtivos);
            } catch (e) { logger.error({ message: "Erro sync reps → RD", error: e.message }); sync = { error: e.message }; }
        }
        res.json({ ok: true, count: representantes.length, sync, acesso, renomeRD, continuacoesPendentes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Conferência dos vínculos de representante: cadastro (Supabase) × login (Portal) ×
// picklist do RD × leads. A cadeia é: deal.REPRESENTANTE (texto do RD) == cadastro.nome
// ou cadastro.rd_alias; o login liga ao cadastro pelo E-MAIL. Qualquer ponto que
// quebre deixa o painel do representante vazio/incompleto — aqui tudo é listado.
router.get("/representantes-bmax/vinculos", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const norm = s => String(s || "").trim().toLowerCase();
        const [cad, revs, users, opts, deals, maps] = await Promise.all([
            sbSistemas('/comercial_representantes_bmax?select=id,nome,email,rd_alias,ativo&limit=500'),
            sbSistemas('/comercial_revendas_bmax?select=nome,nome_rd,rep&ativo=eq.true&limit=1000'),
            User.findAll({ where: { role: "representante" }, attributes: ["id", "username"] }),
            getOpcoesRepresentanteRD(),
            getLeads("admin", "adm"),
            getAliasMaps()
        ]);
        const problemas = [];
        const optsSet = new Set(opts.map(norm));
        const cadAtivos = cad.filter(c => c.ativo !== false);

        // 1) cadastro duplicado por e-mail
        const porEmail = {};
        cad.filter(c => c.email).forEach(c => (porEmail[norm(c.email)] = porEmail[norm(c.email)] || []).push(c));
        Object.entries(porEmail).filter(([, v]) => v.length > 1).forEach(([email, v]) =>
            problemas.push({ nivel: "erro", tipo: "cadastro_duplicado", texto: `E-mail ${email} tem ${v.length} cadastros: ${v.map(c => `"${c.nome}"${c.ativo === false ? " (inativo)" : ""}`).join(", ")}` }));

        // 2) login sem cadastro
        for (const u of users) {
            const achou = cad.some(c => norm(c.email) === norm(u.username) || norm(c.nome) === norm(u.username));
            if (!achou) problemas.push({ nivel: "erro", tipo: "login_sem_cadastro", texto: `Login ${u.username} não tem cadastro de representante (e-mail diferente do cadastro?)` });
        }
        // 3) cadastro ativo sem login (informativo)
        for (const c of cadAtivos) {
            const temLogin = users.some(u => norm(u.username) === norm(c.email) || norm(u.username) === norm(c.nome));
            if (!temLogin) problemas.push({ nivel: "info", tipo: "cadastro_sem_login", texto: `${c.nome} (${c.email || "sem e-mail"}) tem cadastro mas não tem login no Portal` });
        }
        // 4) nome que o RD usa não existe no picklist
        for (const c of cadAtivos) {
            const nomes = [c.nome, c.rd_alias].filter(Boolean);
            if (!nomes.some(n => optsSet.has(norm(n)))) problemas.push({ nivel: "erro", tipo: "fora_do_picklist", texto: `${c.nome}: nem "${nomes.join('" nem "')}" existe no campo REPRESENTANTE do RD — não dá para atribuir leads a ele` });
        }
        // 5/6) valores de REPRESENTANTE nos leads
        const conhecidos = new Set(cadAtivos.flatMap(c => [c.nome, c.rd_alias]).filter(Boolean).map(norm));
        const contagem = {};
        deals.forEach(d => { const r = getCustomField(d, "REPRESENTANTE") || ""; contagem[r] = (contagem[r] || 0) + 1; });
        const ignorar = new Set(["", "n/d", "sem representante"]);
        Object.entries(contagem).filter(([r]) => !ignorar.has(norm(r)) && !conhecidos.has(norm(r))).forEach(([r, n]) =>
            problemas.push({ nivel: "aviso", tipo: "rep_no_rd_sem_cadastro", texto: `"${r}" aparece em ${n} lead(s) no RD mas não é nome nem alias de nenhum representante cadastrado` }));
        for (const c of cadAtivos.filter(c => c.rd_alias && norm(c.rd_alias) !== norm(c.nome))) {
            const a = contagem[c.nome] || 0, b = contagem[c.rd_alias] || 0;
            if (a && b) problemas.push({ nivel: "aviso", tipo: "dois_nomes_no_rd", texto: `${c.nome} aparece no RD com DOIS nomes: "${c.nome}" (${a} leads) e "${c.rd_alias}" (${b} leads) — o painel dele já mostra os dois, mas vale padronizar no RD` });
        }
        const semRep = (contagem[""] || 0) + (contagem["N/D"] || 0) + (contagem["Sem Representante"] || 0);
        if (semRep) problemas.push({ nivel: "info", tipo: "leads_sem_representante", texto: `${semRep} lead(s) sem representante no RD (vazio, N/D ou "Sem Representante")` });
        // 7) cadastro de revenda aponta pra representante inexistente
        revs.filter(r => r.rep && !conhecidos.has(norm(r.rep))).forEach(r =>
            problemas.push({ nivel: "aviso", tipo: "revenda_rep_desconhecido", texto: `Revenda "${r.nome_rd || r.nome}" tem representante "${r.rep}", que não é nome nem alias de nenhum representante cadastrado` }));

        const resumo = users.map(u => {
            const nomes = new Set([u.username, maps.usernameToRd[u.username], ...(maps.loginToNomes[u.username] || []), ...(maps.loginToNomes[norm(u.username)] || [])].filter(Boolean));
            const meus = deals.filter(d => nomes.has(getCustomField(d, "REPRESENTANTE")));
            return { login: u.username, nomeNoRD: maps.usernameToRd[u.username] || null, leads: meus.length, revendas: [...new Set(meus.map(d => getCustomField(d, "REVENDA/LOJA")).filter(r => r && r !== "Sem Revenda"))].length };
        });
        res.json({ ok: !problemas.some(p => p.nivel === "erro"), resumo, problemas });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete("/representantes-bmax/:nome", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const nome = req.params.nome;
        const existingUser = await User.findOne({ where: { username: nome, role: "representante" } });
        if (existingUser) {
            // Exceção: cadastro DUPLICADO (outro cadastro com o mesmo e-mail) pode ser
            // excluído mesmo quando o nome dele coincide com o username do login — é o
            // caso do duplicado nome=e-mail; o cadastro real continua ligado ao login.
            const linhas = await sbSistemas(`/comercial_representantes_bmax?nome=eq.${encodeURIComponent(nome)}&select=id,email`);
            const email = (linhas?.[0]?.email || "").toLowerCase();
            const outros = email
                ? await sbSistemas(`/comercial_representantes_bmax?email=ilike.${encodeURIComponent(email)}&select=id,nome`)
                : [];
            const temOutroCadastro = (outros || []).some(o => o.nome !== nome);
            if (!temOutroCadastro) {
                return res.status(400).json({ error: "Este representante tem login ativo no Portal — exclua o login primeiro (botão \"Excluir login\")." });
            }
        }
        await sbSistemas(`/comercial_representantes_bmax?nome=eq.${encodeURIComponent(nome)}`, 'DELETE');
        invalidateConfigCache();
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cobertura Geográfica (comercial_bmax_cobertura) ───────

async function fetchAllCobertura(select = 'ibge_codigo,cidade,estado,ddd,mesorregiao,rep_bmax') {
    const all = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
        const rows = await sbSistemas(`/comercial_bmax_cobertura?select=${select}&order=estado,cidade&limit=${PAGE}&offset=${offset}`);
        all.push(...rows);
        if (rows.length < PAGE) break;
        offset += PAGE;
    }
    return all;
}

router.get("/cobertura", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const rows = await fetchAllCobertura();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/cobertura/resumo", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const rows = await fetchAllCobertura('rep_bmax,estado');
        const resumo = {};
        for (const r of rows) {
            const rep = r.rep_bmax || "(Sem rep)";
            if (!resumo[rep]) resumo[rep] = { total: 0, estados: new Set() };
            resumo[rep].total++;
            if (r.estado) resumo[rep].estados.add(r.estado);
        }
        const result = Object.entries(resumo).map(([rep, d]) => ({
            rep, total: d.total, estados: [...d.estados].sort().join(", ")
        })).sort((a, b) => b.total - a.total);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch("/cobertura/:ibge", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { ibge } = req.params;
        const { rep_bmax } = req.body;
        const row = await sbSistemasService(`/comercial_bmax_cobertura?ibge_codigo=eq.${ibge}`, 'PATCH', {
            rep_bmax: rep_bmax || null
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/cobertura", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { ibge_codigo, cidade, estado, ddd, mesorregiao, rep_bmax } = req.body;
        if (!ibge_codigo || !cidade || !estado) return res.status(400).json({ error: "ibge_codigo, cidade e estado sao obrigatorios" });
        const row = await sbSistemasService('/comercial_bmax_cobertura', 'POST', {
            ibge_codigo, cidade: cidade.trim(), estado: estado.trim().toUpperCase(),
            ddd: ddd ? parseInt(ddd) : null, mesorregiao: mesorregiao || null,
            rep_bmax: rep_bmax || null, ativo: true
        });
        res.json({ ok: true, row: row[0] || row });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/cobertura/upload", authenticate, authorize(["adm"]), upload.single("file"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });
        const wb = XLSX.read(req.file.buffer, { type: "buffer" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        if (!rows.length) return res.status(400).json({ error: "Planilha vazia" });

        const colMap = {};
        const firstRow = rows[0];
        const keys = Object.keys(firstRow);
        for (const k of keys) {
            const kl = k.toLowerCase().trim();
            if (kl.includes("ibge") || kl === "codigo" || kl === "código") colMap.ibge_codigo = k;
            else if (kl.includes("cidade") || kl === "municipio" || kl === "município") colMap.cidade = k;
            else if (kl.includes("estado") || kl === "uf") colMap.estado = k;
            else if (kl.includes("ddd")) colMap.ddd = k;
            else if (kl.includes("meso")) colMap.mesorregiao = k;
            else if (kl.includes("rep")) colMap.rep_bmax = k;
        }
        if (!colMap.ibge_codigo) return res.status(400).json({ error: "Coluna IBGE nao encontrada. Use 'ibge_codigo', 'ibge' ou 'codigo' como header." });
        if (!colMap.cidade) return res.status(400).json({ error: "Coluna cidade nao encontrada." });
        if (!colMap.estado) return res.status(400).json({ error: "Coluna estado/UF nao encontrada." });

        const batch = [];
        let skipped = 0;
        for (const r of rows) {
            const ibge = String(r[colMap.ibge_codigo] || "").trim();
            const cidade = String(r[colMap.cidade] || "").trim();
            const estado = String(r[colMap.estado] || "").trim().toUpperCase();
            if (!ibge || !cidade || !estado) { skipped++; continue; }
            batch.push({
                ibge_codigo: ibge,
                cidade,
                estado,
                ddd: colMap.ddd ? (parseInt(r[colMap.ddd]) || null) : null,
                mesorregiao: colMap.mesorregiao ? (String(r[colMap.mesorregiao] || "").trim() || null) : null,
                rep_bmax: colMap.rep_bmax ? (String(r[colMap.rep_bmax] || "").trim() || null) : null,
                ativo: true
            });
        }

        if (!batch.length) return res.status(400).json({ error: "Nenhuma linha valida na planilha" });

        const CHUNK = 500;
        let upserted = 0;
        for (let i = 0; i < batch.length; i += CHUNK) {
            const chunk = batch.slice(i, i + CHUNK);
            await sbSistemasService('/comercial_bmax_cobertura', 'POST', chunk, { Prefer: 'resolution=merge-duplicates,return=minimal' });
            upserted += chunk.length;
        }
        res.json({ ok: true, upserted, skipped });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/cobertura/download", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const rows = await fetchAllCobertura();
        const ws = XLSX.utils.json_to_sheet(rows, { header: ["ibge_codigo", "cidade", "estado", "ddd", "mesorregiao", "rep_bmax"] });
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Cobertura");
        const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
        res.setHeader("Content-Disposition", "attachment; filename=cobertura_bmax.xlsx");
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.send(Buffer.from(buf));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Vendedores BMax (comercial_bmax_vendedores) ───────────
// Migrado do BMax Motor — antes só existia lá (client-side, causava bugs de
// RLS). Área de atuação = campo `ddds`.

router.get("/vendedores-bmax", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const rows = await sbSistemas('/comercial_bmax_vendedores?select=id,nome,tipo,cor,ddds,fallback,ativo&order=tipo,nome');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/vendedores-bmax", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { nome, tipo, cor, ddds, fallback } = req.body;
        if (!nome || !nome.trim()) return res.status(400).json({ error: "Nome é obrigatório" });
        if (!["VI", "VT1", "VT2"].includes(tipo)) return res.status(400).json({ error: "Tipo inválido" });
        const row = await sbSistemasService('/comercial_bmax_vendedores', 'POST', {
            nome: nome.trim(), tipo, cor: cor || '#60a5fa',
            ddds: Array.isArray(ddds) ? ddds : null,
            fallback: !!fallback, ativo: true
        });
        res.json(row[0] || row);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch("/vendedores-bmax/:id", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { id } = req.params;
        const updates = {};
        for (const key of ['nome', 'tipo', 'cor', 'ddds', 'fallback', 'ativo']) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }
        if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Nenhum campo para atualizar" });
        const row = await sbSistemasService(`/comercial_bmax_vendedores?id=eq.${id}`, 'PATCH', updates);
        res.json(row[0] || row);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete("/vendedores-bmax/:id", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        await sbSistemasService(`/comercial_bmax_vendedores?id=eq.${req.params.id}`, 'DELETE');
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Lista mestre "Representantes BMax" (dropdown de cobertura) ─
// Migrado do BMax Motor — comercial_bmax_config, chave 'representantes_bmax'.
// Não confundir com comercial_representantes_bmax (representante do RD Station).

router.get("/rep-bmax-list", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const rows = await sbSistemas("/comercial_bmax_config?chave=eq.representantes_bmax&select=valor");
        let lista = [];
        if (rows[0]?.valor) {
            try { lista = JSON.parse(rows[0].valor); } catch { lista = []; }
        }
        res.json(lista);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put("/rep-bmax-list", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const lista = req.body.lista;
        if (!Array.isArray(lista)) return res.status(400).json({ error: "lista deve ser um array" });
        // `resolution=merge-duplicates` sozinho não faz upsert de verdade — precisa
        // do `on_conflict=chave` (mesmo bug já corrigido em /comissao-config acima).
        await sbSistemasService('/comercial_bmax_config?on_conflict=chave', 'POST',
            { chave: 'representantes_bmax', valor: JSON.stringify(lista) },
            { Prefer: 'resolution=merge-duplicates,return=minimal' });
        res.json({ ok: true, total: lista.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Matriz de Comissão / Parâmetros de Classificação PCI ──
// Migrado do BMax Motor — comercial_bmax_config, chaves usadas pelo cálculo
// de PCI e comissão (raio, faturamento de corte, vínculo, percentuais).

const COMISSAO_KEYS = [
    'raio_km', 'nf_threshold', 'vinculo_dias',
    'rep_pct_r1', 'rep_pct_r3a', 'rep_pct_r3b', 'rep_pct_r5', 'vi_pct',
    'comissao_tabela', 'comissao_complementos'
];

router.get("/comissao-config", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const rows = await sbSistemas(`/comercial_bmax_config?chave=in.(${COMISSAO_KEYS.join(',')})&select=chave,valor`);
        const config = {};
        for (const r of rows) config[r.chave] = r.valor;
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put("/comissao-config", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const entries = Object.entries(req.body).filter(([k]) => COMISSAO_KEYS.includes(k));
        if (!entries.length) return res.status(400).json({ error: "Nenhum parâmetro válido enviado" });
        for (const [chave, valor] of entries) {
            // `resolution=merge-duplicates` sozinho não faz upsert de verdade — o
            // PostgREST precisa saber qual coluna é o conflito (`on_conflict`), senão
            // tenta INSERT puro e quebra com 23505 pra toda chave que já existe (bug
            // real, pré-existente: achado ao vivo tentando salvar a matriz de comissão).
            await sbSistemasService('/comercial_bmax_config?on_conflict=chave', 'POST',
                { chave, valor: String(valor) },
                { Prefer: 'resolution=merge-duplicates,return=minimal' });
        }
        res.json({ ok: true, updated: entries.map(([k]) => k) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Extrato de comissão/cashback por agente (Revenda / Representante / Vendedor Interno) ──

const { listarAgentes, getExtratoPorAgente, getExtratoTipoAgente, anexarNomeLead } = require("../services/saldo.service");

const TIPOS_AGENTE = {
    revenda: "Revenda",
    representante: "Representante",
    vendedor_interno: "Vendedor Interno/Técnico"
};

router.get("/comissoes/agentes", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const tipo = req.query.tipo;
        if (!TIPOS_AGENTE[tipo]) return res.status(400).json({ error: "tipo inválido" });
        const agentes = await listarAgentes(tipo);
        res.json(agentes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/comissoes/extrato", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { tipo, nome, mes } = req.query;
        if (!TIPOS_AGENTE[tipo]) return res.status(400).json({ error: "tipo inválido" });
        if (!nome) return res.status(400).json({ error: "nome é obrigatório" });
        const extrato = await anexarNomeLead(await getExtratoPorAgente(tipo, nome, mes || null));
        res.json(extrato);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function nomeAbaExcel(nome) {
    // Limite de 31 caracteres e sem os caracteres que o Excel proíbe em nome de aba
    return String(nome || "Sem nome").replace(/[\\/*?:[\]]/g, "").slice(0, 31) || "Agente";
}

// Recupera PCI de créditos gravados antes da migration que criou a coluna
// `pci` em bmax_transacoes — só existe embutido em texto livre em `descricao`.
function extrairPciDoTexto(descricao) {
    const m = (descricao || "").match(/—\s*(PCI\s?[\dA-Za-z]+)/i);
    return m ? m[1].replace(/\s/g, "").toUpperCase() : "";
}

router.get("/comissoes/exportar", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { tipo, mes } = req.query;
        const tipos = tipo && TIPOS_AGENTE[tipo] ? [tipo] : Object.keys(TIPOS_AGENTE);

        // Nome do lead e Classe de Preço não ficam salvos em bmax_transacoes (só o
        // lead_id) — busca uma vez (lista já cacheada por getLeads) e monta um mapa
        // pra enriquecer as linhas do Excel, igual pros 3 tipos de agente.
        const allDeals = await getLeads("admin", "adm");
        const dealMap = new Map(allDeals.map(d => [d.id || d._id, d]));

        const wb = XLSX.utils.book_new();
        const resumo = [];

        for (const t of tipos) {
            const linhas = await getExtratoTipoAgente(t, mes || null);
            const porAgente = {};
            for (const l of linhas) {
                if (!porAgente[l.nome]) porAgente[l.nome] = [];
                porAgente[l.nome].push(l);
            }

            for (const [nome, txs] of Object.entries(porAgente)) {
                const totalCredito = txs.filter(x => x.tipo === "credito").reduce((s, x) => s + Number(x.valor), 0);
                const totalDebito = txs.filter(x => x.tipo === "debito").reduce((s, x) => s + Number(x.valor), 0);
                resumo.push({
                    Tipo: TIPOS_AGENTE[t], Nome: nome,
                    "Total Créditos": Number(totalCredito.toFixed(2)),
                    "Total Débitos": Number(totalDebito.toFixed(2)),
                    "Saldo Líquido": Number((totalCredito - totalDebito).toFixed(2))
                });

                const linhasAba = txs.map(x => {
                    const deal = x.lead_id ? dealMap.get(x.lead_id) : null;
                    const classePreco = deal ? (getCustomField(deal, "CLASSE DE PREÇO") || "") : "";
                    // Data de fechamento da venda (RD `closed_at`), não a data em que o
                    // crédito foi lançado no sistema (`criado_em`) — um recálculo/ajuste
                    // pode acontecer dias ou semanas depois da venda em si, e a análise
                    // deve seguir quando o negócio fechou, não quando o robô rodou.
                    // Cai pra `criado_em` só quando o deal não é encontrado no RD (raro:
                    // deal excluído) — sem isso a linha ficaria sem data nenhuma.
                    const dataRef = deal?.closed_at || x.criado_em;
                    return {
                        "Data Fechamento": dataRef ? new Date(dataRef).toLocaleDateString("pt-BR") : "",
                        Tipo: x.tipo === "credito" ? "Crédito" : "Débito",
                        "Cashback Creditado (R$)": Number(x.valor),
                        "Valor Total da Venda (R$)": deal ? Number(deal.amount_total || 0) : "",
                        PCI: x.pci || extrairPciDoTexto(x.descricao),
                        "Classe de Preço": classePreco,
                        Revenda: deal ? (getCustomField(deal, "REVENDA/LOJA") || "") : "",
                        "Lead (RD)": x.lead_id || "",
                        "Nome do Lead": deal ? (deal.name || "") : "",
                        Descrição: x.descricao || "",
                        "Saldo Após": x.saldo_apos !== null && x.saldo_apos !== undefined ? Number(x.saldo_apos) : ""
                    };
                });
                const ws = XLSX.utils.json_to_sheet(linhasAba);
                XLSX.utils.book_append_sheet(wb, ws, nomeAbaExcel(`${nome}`));
            }
        }

        const wsResumo = XLSX.utils.json_to_sheet(resumo);
        XLSX.utils.book_append_sheet(wb, wsResumo, "Resumo");
        // Reordena pra Resumo ficar sempre a primeira aba
        wb.SheetNames = ["Resumo", ...wb.SheetNames.filter(n => n !== "Resumo")];

        const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
        const sufixo = mes ? `_${mes}` : "";
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="extrato_comissoes${sufixo}.xlsx"`);
        res.send(buffer);
    } catch (err) {
        logger.error({ message: "Erro ao exportar extrato de comissões", error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
