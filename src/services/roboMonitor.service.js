const { sequelize } = require("../database");
const { QueryTypes } = require("sequelize");
const { alertarAdminErro, sendEmail } = require("./email.service");
const { logger } = require("../logger");

// Monitor dos robôs (rotas /api/cron/*): grava cada execução (bmax_robo_execucoes) e AVISA O ADMIN POR E-MAIL quando um robô falha
// ou deixa de rodar. Antes um robô podia falhar ou ficar parado sem ninguém saber (ex.: o controle dos 60 dias do PCI12a, em que
// nada era arquivado e ninguém via). Na Vercel nada roda depois da resposta, por isso o registro é feito ANTES de responder.

// Robôs esperados e a idade máxima (horas) do último sucesso. Todos rodam ao menos 1x por dia.
const ESPERADOS = {
    "pci12a-prazo": 30, "pci12-followup": 30, "recalcular-comissoes": 30, "termos-prazos": 30,
    "expirar-cashback": 30, "sync-consulta-lead": 30, "sync-revenda-rep-rd": 30, "status-x-etapa": 30, "pcix-prazo": 30
};

// Crédito de comissão em volume anormal (incidente de 24/11/2026: a virada para o Pipefy duplicou 213 créditos, R$ 114 mil).
// Dias normais têm no máximo ~22 créditos; o limite avisa antes de alguém sacar sobre saldo inflado. Só vai para os ADMINS, por e-mail.
const LIM_CREDITOS_24H = 40, LIM_VALOR_24H = 25000, REAVISO_HORAS = 12;
async function emailsDosAdmins() {
    const rows = await sequelize.query(`SELECT username FROM "Users" WHERE role = 'adm' AND username LIKE '%@%'`, { type: QueryTypes.SELECT }).catch(() => []);
    return [...new Set([...rows.map(r => String(r.username).trim().toLowerCase()), process.env.EMAIL_FALLBACK && String(process.env.EMAIL_FALLBACK).trim().toLowerCase()].filter(e => e && e.includes("@")))];
}
async function verificarCreditosAnormais() {
    const porTipo = await sequelize.query(
        `SELECT tipo_agente, count(*)::int n, COALESCE(sum(valor),0)::float v FROM bmax_transacoes WHERE tipo = 'credito' AND criado_em > now() - interval '24 hours' GROUP BY 1`, { type: QueryTypes.SELECT });
    const n = porTipo.reduce((s, x) => s + x.n, 0), v = porTipo.reduce((s, x) => s + x.v, 0);
    if (n <= LIM_CREDITOS_24H && v <= LIM_VALOR_24H) return { anormal: false, creditos: n, valor: v };
    const recente = await sequelize.query(`SELECT 1 FROM bmax_robo_execucoes WHERE robo = 'alerta-creditos' AND alertado_em > now() - make_interval(hours => :h) LIMIT 1`, { replacements: { h: REAVISO_HORAS }, type: QueryTypes.SELECT });
    if (recente.length) return { anormal: true, creditos: n, valor: v, jaAvisado: true };
    const top = await sequelize.query(`SELECT tipo_agente, revenda, count(*)::int n, sum(valor)::float v FROM bmax_transacoes WHERE tipo = 'credito' AND criado_em > now() - interval '24 hours' GROUP BY 1,2 ORDER BY v DESC LIMIT 10`, { type: QueryTypes.SELECT });
    const brl = x => "R$ " + Number(x).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px">
        <h2 style="color:#e30613">⚠️ Volume anormal de créditos de comissão</h2>
        <p>Nas últimas 24 horas o Portal lançou <strong>${n} créditos</strong> (<strong>${brl(v)}</strong>). O normal é no máximo ~${LIM_CREDITOS_24H} créditos e ${brl(LIM_VALOR_24H)} por dia.</p>
        <p>Pode ser uma venda grande legítima, mas já aconteceu de o robô de comissões creditar a mesma venda duas vezes (mudança de id do card). <strong>Confira antes de aprovar saques.</strong></p>
        <ul>${porTipo.map(x => `<li>${x.tipo_agente}: ${x.n} créditos, ${brl(x.v)}</li>`).join("")}</ul>
        <p><strong>Maiores carteiras:</strong></p><ul>${top.map(x => `<li>${x.tipo_agente} · ${x.revenda}: ${x.n} créditos, ${brl(x.v)}</li>`).join("")}</ul>
        <p style="font-size:12px;color:#666">Aviso automático do Portal BMAX, enviado só aos administradores. Reaviso no máximo a cada ${REAVISO_HORAS}h.</p></div>`;
    const destinos = await emailsDosAdmins();
    const ok = destinos.length ? await sendEmail(destinos, "BMAX - ALERTA: volume anormal de créditos de comissão", html).catch(() => false) : false;
    await sequelize.query(`INSERT INTO bmax_robo_execucoes (robo, ok, erro, alertado_em) VALUES ('alerta-creditos', true, :msg, now())`, { replacements: { msg: `${n} créditos / ${brl(v)} em 24h; e-mail ${ok === false ? "NÃO enviado" : "enviado"}` }, type: QueryTypes.INSERT });
    return { anormal: true, creditos: n, valor: v, avisados: ok === false ? 0 : destinos.length };
}

function resultadoRuim(status, body) {
    if (status >= 400) return true;
    if (!body || typeof body !== "object") return false;
    for (const k of ["erros", "errors", "falhas"]) {
        const v = body[k];
        if ((typeof v === "number" && v > 0) || (Array.isArray(v) && v.length > 0)) return true;
    }
    return false;
}

async function registrar({ robo, duracaoMs, status, ok, body }) {
    const resumo = JSON.stringify(body || {}).slice(0, 1800);
    const erro = !ok ? String((body && (body.error || body.message)) || `status ${status}`).slice(0, 500) : null;
    await sequelize.query(
        `INSERT INTO bmax_robo_execucoes (robo, duracao_ms, status_http, ok, resumo, erro)
         VALUES (:robo, :duracaoMs, :status, :ok, CAST(:resumo AS jsonb), :erro)`,
        { replacements: { robo, duracaoMs, status, ok, resumo: resumo.startsWith("{") || resumo.startsWith("[") ? resumo : "{}", erro }, type: QueryTypes.INSERT }
    ).catch(async () => {
        // resumo truncado pode virar JSON inválido: grava sem ele
        await sequelize.query(
            `INSERT INTO bmax_robo_execucoes (robo, duracao_ms, status_http, ok, erro) VALUES (:robo, :duracaoMs, :status, :ok, :erro)`,
            { replacements: { robo, duracaoMs, status, ok, erro }, type: QueryTypes.INSERT }
        );
    });
    if (ok) {
        if (robo !== "vigia-robos") await verificarVigia().catch(() => {});
        if (["recalcular-comissoes", "cashback-nf", "vigia-robos"].includes(robo)) await verificarCreditosAnormais().catch(e => logger.error({ message: "verificarCreditosAnormais falhou", error: e.message }));
        return;
    }
    // Avisa na 1ª falha e repete no máximo 1x por dia enquanto continuar falhando
    const recente = await sequelize.query(
        `SELECT 1 FROM bmax_robo_execucoes WHERE robo = :robo AND alertado_em > now() - interval '24 hours' LIMIT 1`,
        { replacements: { robo }, type: QueryTypes.SELECT }
    );
    if (recente.length) return;
    await alertarAdminErro(`Robô "${robo}" falhou`, new Error(erro || "falha"), { status, "resumo da execução": resumo.slice(0, 400) });
    await sequelize.query(
        `UPDATE bmax_robo_execucoes SET alertado_em = now()
          WHERE id = (SELECT id FROM bmax_robo_execucoes WHERE robo = :robo ORDER BY iniciado_em DESC LIMIT 1)`,
        { replacements: { robo }, type: QueryTypes.UPDATE }
    );
}

// O vigia diário também precisa de vigilância: se ele mesmo parar (ex.: 401 do segredo), qualquer outro robô que rodar avisa.
async function verificarVigia() {
    const r = await sequelize.query(
        `SELECT MIN(iniciado_em) AS desde, MAX(iniciado_em) FILTER (WHERE robo = 'vigia-robos' AND ok) AS ultimo FROM bmax_robo_execucoes`,
        { type: QueryTypes.SELECT }
    );
    const desde = r[0] && r[0].desde ? new Date(r[0].desde).getTime() : null;
    const ultimo = r[0] && r[0].ultimo ? new Date(r[0].ultimo).getTime() : null;
    const LIM = 50 * 3600 * 1000;
    if (!desde || Date.now() - desde < LIM) return;               // histórico ainda curto
    if (ultimo && Date.now() - ultimo < LIM) return;              // vigia rodou há pouco
    const recente = await sequelize.query(
        `SELECT 1 FROM bmax_robo_execucoes WHERE robo = 'vigia-robos' AND alertado_em > now() - interval '24 hours' LIMIT 1`,
        { type: QueryTypes.SELECT }
    );
    if (recente.length) return;
    await alertarAdminErro("O vigia dos robôs não roda há mais de 50 horas", new Error("sem execução com sucesso do vigia-robos"), { "último sucesso do vigia": ultimo ? new Date(ultimo).toISOString() : "nunca (no histórico do monitor)" });
    await sequelize.query(
        `INSERT INTO bmax_robo_execucoes (robo, ok, erro, alertado_em) VALUES ('vigia-robos', false, 'sem executar há mais de 50h', now())`,
        { type: QueryTypes.INSERT }
    );
}

// Middleware para app.use("/api/cron", ...). Ignora simulações (?dry=1) e chamadas sem autorização (401/403).
function cronTracker(req, res, next) {
    const robo = String(req.path || "").replace(/^\//, "").split("/")[0];
    if (!robo || req.query.dry === "1") return next();
    // O agendador da Vercel se identifica como "vercel-cron/1.0". Se ELE for recusado (401/403), o CRON_SECRET da Vercel não confere
    // com o do servidor: o robô deixaria de rodar em silêncio — por isso conta como falha e avisa. Já 401/403 de outros chamadores
    // (tentativas sem segredo) continuam ignorados.
    const ehCronVercel = /vercel-cron/i.test(String(req.headers["user-agent"] || ""));
    const t0 = Date.now();
    const jsonOriginal = res.json.bind(res);
    res.json = (body) => {
        const status = res.statusCode || 200;
        const recusado = status === 401 || status === 403;
        if (recusado && !ehCronVercel) return jsonOriginal(body);
        if (recusado) body = { error: "autorização recusada: o CRON_SECRET que a Vercel envia não confere com o configurado no servidor" };
        const ok = !resultadoRuim(status, body);
        registrar({ robo, duracaoMs: Date.now() - t0, status, ok, body })
            .catch(e => logger.error({ message: "Falha ao registrar execução do robô", robo, error: e.message }))
            .finally(() => jsonOriginal(body));
        return res;
    };
    next();
}

// Vigia diário: avisa se algum robô esperado não teve sucesso dentro do prazo. Só começa a cobrar depois que o monitor tem
// pelo menos 30h de histórico (evita falso alarme logo após a implantação).
async function vigiar() {
    const todas = await sequelize.query(`SELECT MIN(iniciado_em) desde FROM bmax_robo_execucoes`, { type: QueryTypes.SELECT });
    const desde = todas[0] && todas[0].desde ? new Date(todas[0].desde) : null;
    if (!desde || Date.now() - desde.getTime() < 30 * 3600 * 1000) return { ok: true, aprendizado: true, problemas: [] };
    const linhas = await sequelize.query(
        `SELECT robo, MAX(iniciado_em) FILTER (WHERE ok) AS ultimo_ok, MAX(iniciado_em) AS ultimo FROM bmax_robo_execucoes GROUP BY robo`,
        { type: QueryTypes.SELECT }
    );
    const mapa = new Map(linhas.map(l => [l.robo, l]));
    const problemas = [];
    for (const [robo, horas] of Object.entries(ESPERADOS)) {
        const l = mapa.get(robo);
        const idadeH = l && l.ultimo_ok ? (Date.now() - new Date(l.ultimo_ok).getTime()) / 3600000 : null;
        if (idadeH === null || idadeH > horas) problemas.push({ robo, ultimo_sucesso: l && l.ultimo_ok ? new Date(l.ultimo_ok).toISOString() : "nunca (no histórico do monitor)", ultima_tentativa: l && l.ultimo ? new Date(l.ultimo).toISOString() : "nenhuma" });
    }
    if (problemas.length) {
        await alertarAdminErro("Robôs sem rodar com sucesso", new Error(`${problemas.length} robô(s) sem sucesso dentro do prazo`), Object.fromEntries(problemas.map(p => [p.robo, `último sucesso: ${p.ultimo_sucesso} · última tentativa: ${p.ultima_tentativa}`])));
    }
    return { ok: problemas.length === 0, problemas };
}

module.exports = { cronTracker, vigiar, verificarCreditosAnormais, ESPERADOS, LIM_CREDITOS_24H, LIM_VALOR_24H };
