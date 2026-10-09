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
            // Helmet, por padrão, injeta `script-src-attr 'none'` mesmo quando não
            // pedido explicitamente — isso bloqueia TODO onclick="" inline do site
            // inteiro (confirmado ao vivo: nem "+ Nova Revenda" abria). O front-end
            // inteiro (index.html/admin.js/leads.js) depende de onclick inline, então
            // isso precisa ficar liberado igual ao scriptSrc acima.
            scriptSrcAttr: ["'self'", "'unsafe-inline'"],
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

// Consulta de Lead (tela do BMax Motor) — sem JWT do Portal, porque quem
// chama é o Motor (site estático, só tem a chave anon do Supabase, não tem
// token do RD). Expõe nome/e-mail/telefone de contato de clientes — dado
// pessoal — então não pode depender só de CORS (CORS não protege contra
// chamada direta, só restringe o que um navegador honra). Exige que quem
// chamar mande a própria sessão Supabase Auth do Motor (mesmo projeto
// boxer-sistemas onde o Portal cria a conta do Motor — ver
// sbSistemasAuthInvite em users.controller.js); validamos contra
// /auth/v1/user antes de responder, então só usuário logado de fato no
// Motor acessa. Só lê o índice pré-computado pelo cron abaixo — nunca varre
// o RD na hora do clique (varrer os 5 funis ao vivo excede o timeout do
// Vercel).
app.get("/api/motor/consulta-lead", async (req, res) => {
    try {
        const token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
        if (!token) {
            return res.status(401).json({ error: "unauthorized" });
        }

        const { SB_SISTEMAS_URL } = require("./config/supabaseSistemas");
        const anonKey = process.env.SUPABASE_ANON_KEY_SISTEMAS;
        const authRes = await fetch(`${SB_SISTEMAS_URL}/auth/v1/user`, {
            headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
        });
        if (!authRes.ok) {
            return res.status(401).json({ error: "unauthorized" });
        }

        const { buscarLead } = require("./services/rd.leads.service");
        const resultado = await buscarLead(req.query.q);
        res.json(resultado);
    } catch (err) {
        logger.error({ message: "Erro na consulta de lead", error: err.message, stack: err.stack });
        res.status(500).json({ error: "Falha ao consultar RD Station" });
    }
});

// Gera o índice usado por /api/motor/consulta-lead. Roda 3x/dia (9h/14h/18h
// BRT, via 3 entradas de cron em vercel.json — cada uma dispara 1x/dia,
// respeitando o limite do plano Hobby da Vercel); varre os 5 funis do RD em
// paralelo por funil e guarda o resultado em cache.service.js (leads_cache).
app.get("/api/cron/sync-consulta-lead", async (req, res) => {
    const secret = req.headers["authorization"];
    // CRON_TRIGGER_KEY é uma segunda chave só pra disparo manual (o CRON_SECRET
    // é "Secret" no Vercel — não dá pra reler/copiar o valor já salvo).
    const valido = secret === `Bearer ${process.env.CRON_SECRET}` ||
        (process.env.CRON_TRIGGER_KEY && secret === `Bearer ${process.env.CRON_TRIGGER_KEY}`);
    if (!valido) {
        return res.status(401).json({ error: "unauthorized" });
    }
    try {
        const { buildConsultaLeadIndex } = require("./services/rd.leads.service");
        const total = await buildConsultaLeadIndex();
        res.json({ ok: true, total });
    } catch (err) {
        logger.error({ message: "Erro no cron sync-consulta-lead", error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

// Fecha a lacuna entre o número que já aparece automaticamente no card do lead
// (calculado na hora, sempre) e o saldo REAL/resgatável de cada agente
// (bmax_saldo) — que sem isso só era atualizado quando um admin clicava
// manualmente em "recalcular". Roda algumas vezes ao dia (várias entradas no
// vercel.json, mesmo truque do sync-consulta-lead pro limite do plano Hobby).
app.get("/api/cron/recalcular-comissoes", async (req, res) => {
    const secret = req.headers["authorization"];
    const valido = secret === `Bearer ${process.env.CRON_SECRET}` ||
        (process.env.CRON_TRIGGER_KEY && secret === `Bearer ${process.env.CRON_TRIGGER_KEY}`);
    if (!valido) {
        return res.status(401).json({ error: "unauthorized" });
    }
    try {
        const { recalcularComissoes } = require("./services/comissao.service");
        const resultado = await recalcularComissoes();
        res.json(resultado);
    } catch (err) {
        logger.error({ message: "Erro no cron recalcular-comissoes", error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
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
            // PATCH filtrado por chave não lança erro quando não acha nenhuma linha
            // (PostgREST devolve 200 com array vazio) — o fallback POST no .catch()
            // nunca disparava, e a linha simplesmente nunca era criada na primeira
            // vez. Upsert de verdade precisa de on_conflict + merge-duplicates (ver
            // regra já documentada: PostgREST upsert exige ?on_conflict=).
            await sbSistemasService(
                `/comercial_bmax_config?on_conflict=chave`,
                "POST",
                { chave, valor: JSON.stringify(valor) },
                { Prefer: "resolution=merge-duplicates,return=minimal" }
            );
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
            const { getLeads, getCustomField, updateLead, getAliasMaps } = require("./services/rd.leads.service");
            const { getRevendaEmailByName, getRepresentativeEmailByName } = require("./services/user.service");
            const { sendEmail } = require("./services/email.service");
            const { EMAIL_FALLBACK, RD_OWNERS } = require("./config/constants");
            const { registrarTroca } = require("./services/pci12Tracking.service");

            const { rdToEmail } = await getAliasMaps();
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

                // Troca o responsável pra André enquanto o PCI12 fica pendente — regra
                // definida por André (14/09/2026): o time de vendedores Boxer classifica
                // e some, sem acompanhar; centralizar em André até a revenda responder
                // (ou até expirar, ver cron pci12-followup) garante que alguém está de
                // fato de olho no lead nesse meio-tempo. Roda pra TODO pendente (inclusive
                // os que já tinham sido avisados antes dessa funcionalidade existir — ver
                // `jaAvisados` abaixo, que só controla o e-mail, não o rastreamento).
                // `registrarTroca` só retorna true no primeiro INSERT (ON CONFLICT DO
                // NOTHING) — evita trocar de novo o owner a cada rodada do cron.
                try {
                    // TODO PCI12 pendente entra no prazo de 48h — inclusive o que já tem o
                    // André como dono (antes só entrava quem tinha outro dono, e o prazo
                    // nunca contava pros demais: achado 08/10/2026). Sem dono anterior
                    // conhecido grava '' e o 12b automático usa a planilha por região.
                    const ownerAtualId = d.user?._id || d.user?.id || "";
                    const donoAndre = RD_OWNERS["Revenda"];
                    const jaEAndre = ownerAtualId === donoAndre;
                    const primeiraVez = await registrarTroca(dealId, jaEAndre ? "" : ownerAtualId, jaEAndre ? null : (d.user?.name || null));
                    if (primeiraVez && ownerAtualId && !jaEAndre) await updateLead(dealId, { data: { owner_id: donoAndre } });
                } catch (e) {
                    logger.error({ message: "Erro ao trocar responsável do lead PCI12 pendente", dealId, error: e.message });
                }

                if (jaAvisados[dealId]) continue;

                const revendaNome = getCustomField(d, "REVENDA/LOJA") || "";
                const representanteNome = getCustomField(d, "REPRESENTANTE") || "";
                try {
                    const emailRevenda = await getRevendaEmailByName(revendaNome);
                    // rdToEmail vem do cadastro (Supabase) e usa o nome como está no
                    // RD — mais confiável que bater username (hoje é e-mail) com nome.
                    const emailRepresentante = rdToEmail[representanteNome] || await getRepresentativeEmailByName(representanteNome);
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
                         <p>Acesse o <a href="https://bmax.boxersoldas.com.br">Portal BMAX</a> e selecione "Como deseja atender este lead?" no card correspondente.</p>
                         <p>Você tem até <strong>48 horas</strong> para responder — depois desse prazo o lead segue automaticamente como "Boxer vende" (você mantém a comissão) e o time Boxer assume o atendimento.</p>`
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

// Acompanha os leads PCI12 pendentes que tiveram o responsável trocado pra
// André (ver bloco acima, em sync-revenda-rep-rd): manda um lembrete 24h
// depois se ainda não resolveu, e devolve o responsável original às 48h se
// a revenda ainda não escolheu o caminho. Roda várias vezes ao dia (ver
// vercel.json) pra aproximar as janelas de 24h/48h — no plano Hobby da
// Vercel cada cron só roda 1x/dia, por isso são várias entradas com
// horários diferentes, igual o padrão já usado em recalcular-comissoes.
app.get("/api/cron/pci12-followup", async (req, res) => {
    const secret = req.headers["authorization"];
    if (secret !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "unauthorized" });
    }
    try {
        const { getDealById, getCustomField, updateLead, getAliasMaps } = require("./services/rd.leads.service");
        const { getRevendaEmailByName, getRepresentativeEmailByName } = require("./services/user.service");
        const { sendEmail } = require("./services/email.service");
        const { EMAIL_FALLBACK } = require("./config/constants");
        const { buscarPendentes, marcarEmail24hEnviado, marcarResolvido, marcarAuto12b } = require("./services/pci12Tracking.service");
        const { aplicarCaminhoVenda } = require("./services/caminhoVenda.service");

        // ?dry=1 só lista o que seria feito (nada é escrito no RD nem enviado por e-mail)
        const dryRun = req.query.dry === "1";
        const { rdToEmail } = await getAliasMaps();
        const pendentes = await buscarPendentes();
        const resultado = { dryRun, verificados: pendentes.length, lembretes24h: 0, aplicados12b: 0, aplicariam12b: [], resolvidosDetectados: 0, erros: 0 };

        for (const row of pendentes) {
            const dealId = row.deal_id;
            const horasDesdeDeteccao = (Date.now() - new Date(row.detectado_em).getTime()) / 3_600_000;

            let deal;
            try {
                deal = await getDealById(dealId);
            } catch (e) {
                logger.error({ message: "Erro ao buscar deal PCI12 no followup", dealId, error: e.message });
                continue;
            }

            const pciAtual = (getCustomField(deal, "PERFIL PCI") || "").trim().replace(/\s/g, "").toUpperCase();
            if (pciAtual !== "PCI12") {
                // Revenda já escolheu o caminho (ou o lead saiu do PCI12 por outro
                // motivo) — aplicarCaminhoVenda já cuidou do responsável certo,
                // só encerra o rastreamento aqui.
                await marcarResolvido(dealId);
                resultado.resolvidosDetectados++;
                continue;
            }

            if (!dryRun && horasDesdeDeteccao >= 24 && horasDesdeDeteccao < 48 && !row.email_24h_enviado_em) {
                const revendaNome = getCustomField(deal, "REVENDA/LOJA") || "";
                const representanteNome = getCustomField(deal, "REPRESENTANTE") || "";
                try {
                    const emailRevenda = await getRevendaEmailByName(revendaNome);
                    const emailRepresentante = rdToEmail[representanteNome] || await getRepresentativeEmailByName(representanteNome);
                    const destinatarios = [...new Set([emailRevenda, emailRepresentante].filter(Boolean))];
                    if (!destinatarios.length) destinatarios.push(EMAIL_FALLBACK);

                    await sendEmail(
                        destinatarios,
                        `BMAX - Lembrete: lead aguardando definição de caminho de venda`,
                        `<p>Este lead do RD Station, atribuído à revenda <strong>${revendaNome || "?????"}</strong>, ainda está aguardando a definição do caminho de venda há mais de 24 horas:</p>
                         <ul>
                            <li><strong>Cliente:</strong> ${deal.name || "?????"}</li>
                         </ul>
                         <p>Acesse o <a href="https://bmax.boxersoldas.com.br">Portal BMAX</a> e selecione "Como deseja atender este lead?" no card correspondente.</p>
                         <p>Faltam poucas horas para o prazo de 48h — depois disso o lead segue automaticamente como "Boxer vende" (você mantém a comissão) e o time Boxer assume o atendimento.</p>`
                    );
                    await marcarEmail24hEnviado(dealId);
                    resultado.lembretes24h++;
                } catch (e) {
                    logger.error({ message: "Erro ao enviar lembrete 24h de PCI12 pendente", dealId, error: e.message });
                }
            }

            // Regra (André, 08/10/2026): 48h sem a revenda escolher -> o sistema aplica o
            // PCI 12b (Boxer vende) e devolve o responsável anterior ao André. O card
            // continua aparecendo pra revenda (sem pedir ação) e o cashback segue o 12b.
            if (horasDesdeDeteccao >= 48) {
                const cidade = getCustomField(deal, "CIDADE") || "";
                const estado = getCustomField(deal, "ESTADO") || "";
                if (dryRun) {
                    resultado.aplicariam12b.push({ dealId, nome: deal.name, horas: Math.round(horasDesdeDeteccao), ownerAnterior: row.owner_original_nome || "(planilha por região)" });
                    continue;
                }
                try {
                    await aplicarCaminhoVenda(dealId, "BOX+REV>IND", cidade, estado, {
                        automatico: true, ownerOriginalId: row.owner_original_id, ownerOriginalNome: row.owner_original_nome
                    });
                    await marcarAuto12b(dealId);
                    resultado.aplicados12b++;
                } catch (e) {
                    if (e.status === 400 && /finalizado/i.test(e.message)) {
                        await marcarResolvido(dealId); // já vendido/perdido: não há caminho a aplicar
                        resultado.resolvidosDetectados++;
                    } else {
                        logger.error({ message: "Erro ao aplicar 12b automático (48h) no PCI12 pendente", dealId, error: e.message });
                        resultado.erros++;
                    }
                }
            }
        }

        res.json({ ok: true, ...resultado });
    } catch (err) {
        logger.error({ message: "Erro no cron pci12-followup", error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

// Garantia de coerência status x etapa (André, 09/10/2026): NENHUM lead com status final
// no RD (ganha/perdida = campo `win`) pode ficar numa etapa de andamento (Negociação etc.).
// Ganha -> etapa de venda do próprio funil; perdida -> etapa de perda do próprio funil.
// Mover a etapa preserva win, data de fechamento e valor (testado no RD). Ao entrar em
// Venda Efetivada o lead passa a ser considerado pelo cálculo de cashback (se visível).
// ?dry=1 só lista, sem escrever.
app.get("/api/cron/status-x-etapa", async (req, res) => {
    const secret = req.headers["authorization"];
    const valido = secret === `Bearer ${process.env.CRON_SECRET}` ||
        (process.env.CRON_TRIGGER_KEY && secret === `Bearer ${process.env.CRON_TRIGGER_KEY}`);
    if (!valido) return res.status(401).json({ error: "unauthorized" });

    try {
        const { fetchAllDealsAllPipelines, updateLead } = require("./services/rd.leads.service");
        const C = require("./config/constants");
        const dryRun = req.query.dry === "1";

        // Por funil: etapas FINAIS e pra onde mandar ganha/perdida.
        const regras = {
            [C.RD_PIPELINE_INDUSTRIA]: {
                finais: new Set([C.RD_STAGE_VENDA_EFETIVADA, C.RD_STAGE_ENTREGA_TECNICA, C.RD_STAGE_EXCLUIDO]),
                ganha: C.RD_STAGE_VENDA_EFETIVADA, perdida: C.RD_STAGE_EXCLUIDO
            },
            [C.RD_PIPELINE_BMAX_INTERNO]: {
                finais: new Set([C.RD_STAGE_VENDIDO, C.RD_STAGE_PERDIDO]),
                ganha: C.RD_STAGE_VENDIDO, perdida: C.RD_STAGE_PERDIDO
            }
        };

        const deals = await fetchAllDealsAllPipelines();
        const resultado = { dryRun, incoerentes: 0, corrigidos: 0, erros: 0, lista: [] };
        for (const d of deals) {
            const r = regras[d._pipelineId];
            if (!r || (d.win !== true && d.win !== false) || r.finais.has(d.deal_stage?.id)) continue;
            resultado.incoerentes++;
            const destino = d.win === true ? r.ganha : r.perdida;
            const item = { dealId: d.id || d._id, nome: (d.name || "").trim(), de: d.deal_stage?.name, win: d.win };
            if (dryRun) { resultado.lista.push(item); continue; }
            try {
                await updateLead(item.dealId, { data: { stage_id: destino } });
                resultado.corrigidos++;
                resultado.lista.push(item);
            } catch (e) {
                resultado.erros++;
                logger.error({ message: "Erro ao alinhar etapa ao status final (win)", dealId: item.dealId, error: e.message });
            }
        }
        if (!dryRun && resultado.corrigidos) { try { await require("./services/cache.service").invalidateLeadsCache(); } catch (_) {} }
        res.json({ ok: true, ...resultado });
    } catch (err) {
        logger.error({ message: "Erro no cron status-x-etapa", error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

// Prazo de 60 dias do PCI12a (André, 08/10/2026): contado desde que a revenda assumiu
// ("Eu assumo a venda"). Vencido sem venda nem perda, o lead — esteja no funil que
// estiver — vai pro funil BMAX, etapa "Prazo Vencido" (arquivado). Lead vendido ou
// perdido antes do prazo NUNCA é arquivado: fica na etapa correta. Depois de arquivado
// ele sai do painel e deixa de bloquear nova negociação com o mesmo CNPJ (a trava de
// duplicidade ignora a etapa Prazo Vencido). ?dry=1 só lista, sem escrever nada.
const PRAZO_PCI12A_DIAS = 60;
app.get("/api/cron/pci12a-prazo", async (req, res) => {
    const secret = req.headers["authorization"];
    const valido = secret === `Bearer ${process.env.CRON_SECRET}` ||
        (process.env.CRON_TRIGGER_KEY && secret === `Bearer ${process.env.CRON_TRIGGER_KEY}`);
    if (!valido) return res.status(401).json({ error: "unauthorized" });

    try {
        const { getLeads, getCustomField, updateLead, getDealById } = require("./services/rd.leads.service");
        const { buscarPrazos12a, registrarAssumido, marcarArquivado12a, buscarDataAssumidoNaAuditoria } = require("./services/pci12Tracking.service");
        const { RD_STAGE_PERDIDO, RD_STAGE_VENDA_EFETIVADA, RD_STAGE_VENDIDO, RD_STAGE_ENTREGA_TECNICA } = require("./config/constants");
        const dryRun = req.query.dry === "1";
        const finais = new Set([RD_STAGE_PERDIDO, RD_STAGE_VENDA_EFETIVADA, RD_STAGE_VENDIDO, RD_STAGE_ENTREGA_TECNICA]);

        const deals = await getLeads("admin", "adm");
        const em12a = deals.filter(d =>
            (getCustomField(d, "PERFIL PCI") || "").replace(/\s/g, "").toUpperCase() === "PCI12A" &&
            !finais.has(d.deal_stage?.id));

        const prazos = new Map((await buscarPrazos12a()).map(p => [p.deal_id, p]));
        const resultado = { dryRun, em12a: em12a.length, registrados: 0, arquivados: 0, aArquivar: [], erros: 0 };

        for (const d of em12a) {
            const dealId = d.id || d._id;
            let p = prazos.get(dealId);
            if (!p) {
                // 12a anterior a esta regra: usa a data da escolha no log de auditoria; sem
                // registro, começa a contar hoje (a revenda não é penalizada por falta de dado).
                const quando = await buscarDataAssumidoNaAuditoria(dealId);
                if (!dryRun) await registrarAssumido(dealId, quando);
                p = { deal_id: dealId, assumido_em: quando || new Date(), arquivado_em: null };
                resultado.registrados++;
            }
            if (p.arquivado_em) continue;
            const dias = (Date.now() - new Date(p.assumido_em).getTime()) / 86_400_000;
            if (dias < PRAZO_PCI12A_DIAS) continue;

            if (dryRun) { resultado.aArquivar.push({ dealId, nome: d.name, dias: Math.floor(dias) }); continue; }
            try {
                await updateLead(dealId, { data: { stage_id: RD_STAGE_PERDIDO } });
                // Confirma que o RD de fato moveu (etapa do funil BMAX) antes de dar como arquivado.
                const depois = await getDealById(dealId);
                if (depois?.deal_stage?.id !== RD_STAGE_PERDIDO) throw new Error("RD não confirmou a mudança para Prazo Vencido");
                await marcarArquivado12a(dealId);
                resultado.arquivados++;
            } catch (e) {
                resultado.erros++;
                logger.error({ message: "Erro ao arquivar PCI12a vencido (60 dias)", dealId, error: e.message });
            }
        }

        res.json({ ok: true, ...resultado });
    } catch (err) {
        logger.error({ message: "Erro no cron pci12a-prazo", error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message });
    }
});

app.use(errorMiddleware);

module.exports = app;
