const express = require("express");
const { authenticate, authorize } = require("../middlewares/auth");
const { sequelize } = require("../database");
const { QueryTypes } = require("sequelize");
const { getLeads, getCustomField, syncRevendasToRD, syncRepresentantesToRD, renomearRepresentanteNoRD } = require("../services/rd.leads.service");
const { User, Revenda, Representante } = require("../database");
const bcrypt = require("bcryptjs");
const { invalidateConfigCache } = require("./config.routes");
const multer = require("multer");
const XLSX = require("xlsx");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();

const { SB_SISTEMAS_URL, sbSistemasAnon: sbSistemas } = require("../config/supabaseSistemas");
const { sensitiveActionRateLimit } = require("../middlewares/rateLimit");

async function fetchAllRevendasAtivas() {
    return await sbSistemas('/comercial_revendas_bmax?ativo=eq.true&select=nome&order=nome');
}

async function syncRevendasAfterChange() {
    try {
        const revendas = await fetchAllRevendasAtivas();
        const nomes = revendas.map(r => r.nome);
        return await syncRevendasToRD(nomes);
    } catch (err) {
        console.error("Erro sync revendas → RD:", err);
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
        console.error("Erro revendas-rd:", err);
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
        res.status(500).json({ error: err.message });
    }
});

router.get("/users", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const users = await User.findAll({
            attributes: ["id", "username", "role"],
            order: [["role", "ASC"], ["username", "ASC"]]
        });

        let canonRepsMap = {};
        try {
            const canon = await sbSistemas('/comercial_representantes_bmax?select=*&order=nome');
            canonRepsMap = Object.fromEntries(canon.map(r => [r.nome, r]));
        } catch (e) { console.error("Erro ao buscar representantes canônicos:", e); }

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
                }
            } else if (u.role === "representante") {
                const rep = await Representante.findOne({ where: { user_id: u.id } });
                const canon = canonRepsMap[u.username];
                entry.email = canon?.email || rep?.email || null;
                entry.telefone = canon?.telefone || null;
                entry.ativo = canon ? canon.ativo : true;
                entry.temLoginMotor = !!canon?.tem_login;
                nomesComLogin.add(u.username);
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

router.patch("/users/:id/reset-password", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;
        if (!password || password.length < 6) return res.status(400).json({ error: "Senha deve ter no minimo 6 caracteres" });

        const user = await User.findByPk(id);
        if (!user) return res.status(404).json({ error: "Usuario nao encontrado" });

        user.password = await bcrypt.hash(password, 10);
        await user.save();
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── CRUD Revendas BMax (Supabase boxer-sistemas) ───────────

router.get("/revendas-bmax", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const rows = await sbSistemas('/comercial_revendas_bmax?select=id,nome,cidade,estado,classe,ativo,rep,grupo,telefone,email,cnpj,cep&order=nome');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/revendas-bmax", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { nome, cidade, estado, classe, rep, grupo } = req.body;
        if (!nome || !nome.trim()) return res.status(400).json({ error: "Nome é obrigatório" });
        const row = await sbSistemas('/comercial_revendas_bmax', 'POST', {
            nome: nome.trim(), cidade: cidade || null, estado: estado || null,
            classe: classe || null, rep: rep || null, grupo: grupo || null, ativo: true
        });
        invalidateConfigCache();
        const sync = await syncRevendasAfterChange();
        res.json({ revenda: row[0] || row, sync });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch("/revendas-bmax/:id", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const { id } = req.params;
        const updates = {};
        for (const key of ['nome', 'cidade', 'estado', 'classe', 'rep', 'grupo', 'ativo', 'telefone', 'email', 'cnpj', 'cep']) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }
        if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Nenhum campo para atualizar" });
        updates.editado_em = new Date().toISOString();
        updates.editado_por = req.user.username || req.user.email || 'admin';

        const row = await sbSistemas(`/comercial_revendas_bmax?id=eq.${id}`, 'PATCH', updates);
        invalidateConfigCache();
        const needsSync = 'nome' in updates || 'ativo' in updates;
        const sync = needsSync ? await syncRevendasAfterChange() : null;
        res.json({ revenda: row[0] || row, sync });
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

            try {
                renomeRD = await renomearRepresentanteNoRD(alvoNomeAntigo, alvoNome);
            } catch (e) {
                console.error("Erro ao renomear representante no RD:", e);
                renomeRD = { error: e.message };
            }
        }

        for (const r of representantes) {
            if (!r.nome || !r.nome.trim()) continue;
            await sbSistemas(`/comercial_representantes_bmax?nome=eq.${encodeURIComponent(r.nome)}`, 'PATCH', {
                email: r.email || null,
                telefone: r.telefone || null,
                ativo: !!r.ativo,
                atualizado_em: new Date().toISOString()
            }).catch(async () => {
                // não existia ainda (representante novo) → insere
                await sbSistemas('/comercial_representantes_bmax', 'POST', {
                    nome: r.nome.trim(), email: r.email || null, telefone: r.telefone || null, ativo: !!r.ativo
                });
            });
        }

        // Espelha na chave legada que o bmax-motor ainda lê diretamente (comercial_bmax_config),
        // para não depender de alterar o index.html do Motor nesta consolidação.
        try {
            const todos = await sbSistemas('/comercial_representantes_bmax?select=nome,ativo&order=nome');
            const legado = todos.map(r => ({ nome: r.nome, ativo: r.ativo }));
            await sbSistemas('/comercial_bmax_config?chave=eq.representantes_bmax', 'PATCH', { valor: JSON.stringify(legado) })
                .catch(() => sbSistemas('/comercial_bmax_config', 'POST', { chave: 'representantes_bmax', valor: JSON.stringify(legado) }));
        } catch (e) { console.error("Erro ao espelhar representantes para comercial_bmax_config:", e); }

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
        let sync = null;
        try {
            const nomesAtivos = representantes.filter(r => r.ativo).map(r => r.nome);
            sync = await syncRepresentantesToRD(nomesAtivos);
        } catch (e) { console.error("Erro sync reps → RD:", e); sync = { error: e.message }; }
        res.json({ ok: true, count: representantes.length, sync, acesso, renomeRD });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete("/representantes-bmax/:nome", authenticate, authorize(["adm"]), async (req, res) => {
    try {
        const nome = req.params.nome;
        const existingUser = await User.findOne({ where: { username: nome, role: "representante" } });
        if (existingUser) {
            return res.status(400).json({ error: "Este representante tem login ativo no Portal — exclua o login primeiro (botão \"Excluir login\")." });
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
        const row = await sbSistemas(`/comercial_bmax_cobertura?ibge_codigo=eq.${ibge}`, 'PATCH', {
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
        const row = await sbSistemas('/comercial_bmax_cobertura', 'POST', {
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
            await sbSistemas('/comercial_bmax_cobertura', 'POST', chunk, { Prefer: 'resolution=merge-duplicates,return=minimal' });
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

module.exports = router;
