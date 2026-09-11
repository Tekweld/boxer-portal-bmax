const helmet = require("helmet");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const authRoutes = require("./routes/auth.routes");
const usersRoutes = require("./routes/users.routes");
const leadsRoutes = require("./routes/leads.routes");
const negociacaoRoutes = require("./routes/negociacao.routes");
const configRoutes = require("./routes/config.routes");
const exportRoutes = require("./routes/export.routes");
const cashbackRoutes = require("./routes/cashback.routes");
const adminRoutes = require("./routes/admin.routes");
const auditRoutes = require("./routes/audit.routes");
const errorMiddleware = require("./middlewares/errorMiddleware");
const { logger } = require("./logger");

const ALLOWED_ORIGINS = [
    "https://bmax.boxersoldas.com.br",
    "https://boxer-portal-bmax.vercel.app",
    "https://bmax-motor.pages.dev",
    process.env.NODE_ENV !== "production" && "http://localhost:3000"
].filter(Boolean);

const app = express();

app.use(express.json());
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Origem não permitida"));
        }
    },
    credentials: true
}));
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            connectSrc: ["'self'"],
            imgSrc: ["'self'", "data:"],
        }
    }
}));

app.get("/api/ping", (req, res) => {
    res.json({ pong: true });
});

app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/leads", leadsRoutes);
app.use("/api/negociacoes", negociacaoRoutes);
app.use("/api/config", configRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/cashback", cashbackRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/audit", auditRoutes);

app.get("/api/health", (req, res) => {
    res.json({ status: "ok", service: "BMAX API" });
});

app.get("/api/cron/expirar-cashback", async (req, res) => {
    const secret = req.headers["authorization"];
    if (secret !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "unauthorized" });
    }
    try {
        const { processarExpirados, getExpirandoEm } = require("./services/saldo.service");
        const { sendEmail } = require("./services/email.service");
        const { sequelize } = require("./database");
        const { QueryTypes } = require("sequelize");

        const expirados = await processarExpirados();

        const em30 = await getExpirandoEm(30);
        const em15 = await getExpirandoEm(15);
        const aNotificar = [...em15, ...em30.filter(t => !em15.find(e => e.id === t.id))];

        for (const tx of aNotificar) {
            const diasRestantes = Math.ceil((new Date(tx.expira_em) - Date.now()) / (24 * 60 * 60 * 1000));
            const revendaUsers = await sequelize.query(
                `SELECT u.username FROM "Users" u JOIN "Revendas" r ON r.user_id = u.id WHERE r.nome = :nome LIMIT 1`,
                { replacements: { nome: tx.revenda }, type: QueryTypes.SELECT }
            );
            if (revendaUsers.length && revendaUsers[0].username.includes("@")) {
                try {
                    await sendEmail(
                        revendaUsers[0].username,
                        `BMAX - Cashback expirando em ${diasRestantes} dias`,
                        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
                            <div style="background:#1d327b;color:#fff;padding:20px;text-align:center;border-radius:12px 12px 0 0;">
                                <h2 style="margin:0;">BMAX - Aviso de Vencimento</h2>
                            </div>
                            <div style="padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
                                <p>Voce tem um credito de cashback que expira em <strong>${diasRestantes} dias</strong>:</p>
                                <table style="width:100%;font-size:14px;border-collapse:collapse;">
                                    <tr><td style="padding:8px 0;color:#666;">Valor</td><td style="padding:8px 0;font-weight:bold;color:#16a34a;">R$ ${Number(tx.valor).toFixed(2)}</td></tr>
                                    <tr><td style="padding:8px 0;color:#666;">Origem</td><td style="padding:8px 0;">${tx.descricao}</td></tr>
                                    <tr><td style="padding:8px 0;color:#666;">Expira em</td><td style="padding:8px 0;color:#e30613;font-weight:bold;">${new Date(tx.expira_em).toLocaleDateString("pt-BR")}</td></tr>
                                </table>
                                <p style="margin-top:16px;">Acesse o <a href="https://bmax.boxersoldas.com.br" style="color:#1d327b;font-weight:bold;">Portal BMAX</a> para solicitar o saque antes do vencimento.</p>
                            </div>
                        </div>`
                    );
                } catch (emailErr) {
                    logger.error({ message: "Erro ao enviar aviso de vencimento", error: emailErr.message });
                }
            }
        }

        res.json({ ok: true, expirados: expirados.length, notificados: aNotificar.length });
    } catch (err) {
        logger.error({ message: "Erro no cron expirar-cashback", error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

// Reconciliação periódica: o Motor (bmax-motor/index.html) escreve nomes de revenda
// direto no Supabase (chave anon), sem nunca passar pela API do Portal — então uma
// renomeação feita por lá não dispara syncRevendasToRD/renomearRevendaNoRD como
// acontece quando o rename é feito pela tela de admin do Portal. Este job detecta
// qualquer mudança de nome comparando com o último snapshot conhecido (venha de onde
// vier: Motor, edição direta no Supabase, ou até o próprio Portal) e propaga para o
// RD Station. Serve também de rede de segurança para representantes.
app.get("/api/cron/sync-revenda-rep-rd", async (req, res) => {
    const secret = req.headers["authorization"];
    if (secret !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "unauthorized" });
    }
    try {
        const { sbSistemasAnon, sbSistemasService } = require("./config/supabaseSistemas");
        const { syncRevendasToRD, renomearRevendaNoRD } = require("./services/rd.leads.service");

        async function getSnapshot(chave) {
            const rows = await sbSistemasAnon(`/comercial_bmax_config?chave=eq.${chave}&select=valor`);
            try { return JSON.parse(rows[0]?.valor || "{}"); } catch { return {}; }
        }
        async function saveSnapshot(chave, valor) {
            await sbSistemasService(`/comercial_bmax_config?chave=eq.${chave}`, "PATCH", { valor: JSON.stringify(valor) })
                .catch(() => sbSistemasService("/comercial_bmax_config", "POST", { chave, valor: JSON.stringify(valor) }));
        }

        const resultado = { revendas: [] };

        // Revendas
        const snapshotRevendas = await getSnapshot("revenda_rd_snapshot");
        const revendasAtuais = await sbSistemasAnon("/comercial_revendas_bmax?select=id,nome,ativo");
        const revendasMudadas = revendasAtuais.filter(r => snapshotRevendas[r.id] && snapshotRevendas[r.id] !== r.nome);

        if (revendasMudadas.length) {
            const nomesAtivos = revendasAtuais.filter(r => r.ativo).map(r => r.nome);
            await syncRevendasToRD(nomesAtivos).catch(e => logger.error({ message: "Erro sync revendas → RD (reconciliação)", error: e.message }));
            for (const r of revendasMudadas) {
                try {
                    const r1 = await renomearRevendaNoRD(snapshotRevendas[r.id], r.nome);
                    resultado.revendas.push({ id: r.id, de: snapshotRevendas[r.id], para: r.nome, ...r1 });
                } catch (e) {
                    logger.error({ message: "Erro ao renomear revenda no RD (reconciliação)", revendaId: r.id, error: e.message });
                    resultado.revendas.push({ id: r.id, de: snapshotRevendas[r.id], para: r.nome, error: e.message });
                }
            }
        }
        const novoSnapshotRevendas = Object.fromEntries(revendasAtuais.map(r => [r.id, r.nome]));
        await saveSnapshot("revenda_rd_snapshot", novoSnapshotRevendas);

        // Avisa por e-mail leads com PCI12 que chegaram direto no RD Station (fora do
        // Portal), já que nesse caso não existe nenhuma ação nossa disparando na hora
        // que o lead aparece. Roda nesse mesmo cron diário — plano Hobby da Vercel só
        // permite 1x/dia por job — comparando com um snapshot dos leads já avisados
        // para não reenviar e-mail toda vez que o job rodar.
        try {
            const { getLeads, getCustomField } = require("./services/rd.leads.service");
            const { getRevendaEmailByName, getRepresentativeEmailByName } = require("./services/user.service");
            const { sendEmail } = require("./services/email.service");
            const { EMAIL_FALLBACK } = require("./config/constants");

            const jaAvisados = await getSnapshot("pci12_leads_avisados");
            const todosDeals = await getLeads("admin", "adm");

            const pendentes = todosDeals.filter(d => {
                const pci = (getCustomField(d, "PERFIL PCI") || "").trim().replace(/\s/g, "");
                const revenda = getCustomField(d, "REVENDA/LOJA") || "";
                return pci === "PCI12" && revenda && revenda !== "?????" && revenda !== "Sem Revenda";
            });

            const novosSnapshot = {};
            for (const d of pendentes) {
                const dealId = d.id || d._id;
                novosSnapshot[dealId] = true;
                if (jaAvisados[dealId]) continue;

                const revendaNome = getCustomField(d, "REVENDA/LOJA") || "";
                const representanteNome = getCustomField(d, "REPRESENTANTE") || "";
                try {
                    const emailRevenda = await getRevendaEmailByName(revendaNome);
                    const emailRepresentante = await getRepresentativeEmailByName(representanteNome);
                    const destinatarios = [...new Set([emailRevenda, emailRepresentante].filter(Boolean))];
                    if (!destinatarios.length) destinatarios.push(EMAIL_FALLBACK);

                    if (!emailRevenda) {
                        logger.warn({ message: "E-mail da revenda não encontrado para aviso de PCI12 pendente", revendaNome });
                    }
                    if (!emailRepresentante) {
                        logger.warn({ message: "E-mail do representante não encontrado para aviso de PCI12 pendente", representanteNome });
                    }

                    await sendEmail(
                        destinatarios,
                        `BMAX - Lead aguardando definição de caminho de venda`,
                        `<p>Um lead do RD Station foi atribuído à revenda <strong>${revendaNome || "?????"}</strong> e precisa que o caminho de venda seja escolhido:</p>
                         <ul>
                            <li><strong>Cliente:</strong> ${d.name || "?????"}</li>
                         </ul>
                         <p>Acesse o <a href="https://bmax.boxersoldas.com.br">Portal BMAX</a> e selecione "Como deseja atender este lead?" no card correspondente.</p>`
                    );
                    resultado.pci12Avisados = (resultado.pci12Avisados || 0) + 1;
                } catch (e) {
                    logger.error({ message: "Erro ao avisar revenda/representante de lead PCI12 pendente", dealId, revendaNome, representanteNome, error: e.message });
                }
            }
            await saveSnapshot("pci12_leads_avisados", novosSnapshot);
        } catch (e) {
            logger.error({ message: "Erro na varredura de leads PCI12 pendentes (reconciliação)", error: e.message });
        }

        // Nota: não há reconciliação equivalente para representantes aqui — a tabela
        // comercial_representantes_bmax não tem PK estável além do próprio `nome`
        // (é a chave usada no rename), então não dá pra detectar renomeação por diff
        // de snapshot como fazemos para revenda (que tem `id` numérico). O único
        // caminho de rename de representante é a tela de admin do Portal, já coberto
        // pelo fix síncrono em admin.routes.js (PUT /representantes-bmax).

        res.json({ ok: true, ...resultado });
    } catch (err) {
        logger.error({ message: "Erro no cron sync-revenda-rep-rd", error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

app.use(errorMiddleware);

module.exports = app;
