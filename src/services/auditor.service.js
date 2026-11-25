const { sequelize } = require("../database");
const { QueryTypes } = require("sequelize");
const { sendEmail } = require("./email.service");
const { ESPERADOS, LIM_CREDITOS_24H, LIM_VALOR_24H } = require("./roboMonitor.service");
const { logger } = require("../logger");

// AUDITOR DIÁRIO (25/11/2026). Regra do André: o auditor SÓ AVISA, nunca corrige nada. As checagens apenas leem; a única coisa que
// ele grava são as duas tabelas dele (bmax_auditoria_achados e bmax_auditoria_execucoes). O e-mail vai só para EMAIL_AUDITOR e só
// quando há achado novo ou um achado antigo que venceu o lembrete semanal. Um achado continua "aberto" até uma rodada não o
// encontrar mais; checagem que falhou ao rodar NUNCA marca seus achados como resolvidos.

const REAVISO_DIAS = 7;
const TOLERANCIA_SALDO = 0.01;
const ROTULO_GRUPO = { dinheiro: "Dinheiro (razão e créditos)", cards: "Cards e ids", prazos: "Prazos", pessoas: "Cadastro e pessoas", robos: "Robôs" };

const brl = x => "R$ " + Number(x).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hojeBRT = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

// ─── Checagens (cada uma devolve uma lista de achados; só lê) ─────────────────────────────────────────────

// Saldo guardado (bmax_saldo) x soma dos lançamentos (bmax_transacoes). Fonte única do saldo = razão (regra de 25/11).
async function checarSaldoVsRazao() {
    const linhas = await sequelize.query(
        `SELECT COALESCE(s.tipo_agente, t.tipo_agente) AS tipo_agente, COALESCE(s.revenda, t.revenda) AS nome,
                s.saldo::float AS saldo, COALESCE(t.soma, 0)::float AS soma, (s.id IS NULL) AS sem_carteira
           FROM bmax_saldo s
           FULL OUTER JOIN (
                SELECT tipo_agente, revenda, SUM(CASE WHEN tipo = 'credito' THEN valor ELSE -valor END) AS soma
                  FROM bmax_transacoes GROUP BY tipo_agente, revenda
           ) t ON t.tipo_agente = s.tipo_agente AND t.revenda = s.revenda`,
        { type: QueryTypes.SELECT }
    );
    const achados = [];
    for (const l of linhas) {
        const saldo = l.sem_carteira ? 0 : Number(l.saldo || 0);
        const dif = Number((saldo - l.soma).toFixed(2));
        if (Math.abs(dif) < TOLERANCIA_SALDO) continue;
        achados.push({
            chave: `saldo_vs_razao:${l.tipo_agente}:${l.nome}`,
            grupo: "dinheiro", checagem: "saldo_vs_razao",
            severidade: Math.abs(dif) >= 100 ? "alta" : "media",
            titulo: l.sem_carteira
                ? `Há lançamentos sem carteira de saldo: ${l.tipo_agente} "${l.nome}" (soma dos lançamentos ${brl(l.soma)})`
                : `Saldo da carteira ${l.tipo_agente} "${l.nome}" difere da soma dos lançamentos em ${brl(dif)}`,
            detalhe: { tipo_agente: l.tipo_agente, carteira: l.nome, saldo_guardado: saldo, soma_dos_lancamentos: l.soma, diferenca: dif },
            acao: "NÃO corrigir o saldo ainda. Primeiro conferir no Extrato de Comissões se o erro está nos lançamentos (duplicidade, crédito sem débito, estorno).",
        });
    }
    return achados;
}

// Volume de créditos em 24h acima do limite do monitor dos robôs (incidente de 24/11). Só lê; não envia o e-mail do monitor.
async function checarCreditosAnormais() {
    const porTipo = await sequelize.query(
        `SELECT tipo_agente, count(*)::int n, COALESCE(sum(valor),0)::float v FROM bmax_transacoes
          WHERE tipo = 'credito' AND criado_em > now() - interval '24 hours' GROUP BY 1`, { type: QueryTypes.SELECT });
    const n = porTipo.reduce((s, x) => s + x.n, 0), v = porTipo.reduce((s, x) => s + x.v, 0);
    if (n <= LIM_CREDITOS_24H && v <= LIM_VALOR_24H) return [];
    return [{
        chave: `creditos_anormais:${hojeBRT()}`,
        grupo: "dinheiro", checagem: "creditos_anormais", severidade: "alta",
        titulo: `Volume anormal de créditos nas últimas 24h: ${n} créditos, ${brl(v)} (normal: até ${LIM_CREDITOS_24H} e ${brl(LIM_VALOR_24H)})`,
        detalhe: { creditos: n, valor: v, por_tipo: porTipo },
        acao: "Conferir se é venda grande legítima ou crédito duplicado (já aconteceu na virada para o Pipefy) antes de aprovar qualquer saque.",
    }];
}

// Robô esperado sem sucesso dentro do prazo, ou cuja última execução falhou. Mesma regra do vigia, sem enviar e-mail.
async function checarRobos() {
    const hist = await sequelize.query(`SELECT MIN(iniciado_em) AS desde FROM bmax_robo_execucoes`, { type: QueryTypes.SELECT });
    const desde = hist[0] && hist[0].desde ? new Date(hist[0].desde) : null;
    if (!desde || Date.now() - desde.getTime() < 30 * 3600 * 1000) return [];   // histórico curto: o vigia também espera
    const linhas = await sequelize.query(
        `SELECT robo, MAX(iniciado_em) FILTER (WHERE ok) AS ultimo_ok, MAX(iniciado_em) AS ultimo FROM bmax_robo_execucoes GROUP BY robo`, { type: QueryTypes.SELECT });
    const mapa = new Map(linhas.map(l => [l.robo, l]));
    const ultimas = await sequelize.query(
        `SELECT DISTINCT ON (robo) robo, ok, erro, iniciado_em FROM bmax_robo_execucoes WHERE robo <> 'alerta-creditos' ORDER BY robo, iniciado_em DESC`, { type: QueryTypes.SELECT });
    const achados = [];
    for (const [robo, horas] of Object.entries(ESPERADOS)) {
        const l = mapa.get(robo);
        const idadeH = l && l.ultimo_ok ? (Date.now() - new Date(l.ultimo_ok).getTime()) / 3600000 : null;
        if (idadeH === null || idadeH > horas) {
            achados.push({
                chave: `robo_sem_sucesso:${robo}`, grupo: "robos", checagem: "robo_sem_sucesso", severidade: "alta",
                titulo: idadeH === null ? `Robô "${robo}" nunca teve sucesso no histórico do monitor` : `Robô "${robo}" sem sucesso há ${Math.floor(idadeH)}h (limite ${horas}h)`,
                detalhe: { robo, ultimo_sucesso: l && l.ultimo_ok ? new Date(l.ultimo_ok).toISOString() : null, limite_horas: horas },
                acao: "Ver a última execução em Gestão > Auditor diário e o log da Vercel do robô.",
            });
        }
    }
    for (const u of ultimas) {
        if (u.ok || !(u.robo in ESPERADOS)) continue;
        achados.push({
            chave: `robo_ultima_falhou:${u.robo}`, grupo: "robos", checagem: "robo_ultima_falhou", severidade: "media",
            titulo: `A última execução do robô "${u.robo}" falhou`,
            detalhe: { robo: u.robo, quando: new Date(u.iniciado_em).toISOString(), erro: u.erro },
            acao: "Conferir o erro e se a próxima rodada já recuperou.",
        });
    }
    return achados;
}

// `cobre`: os tipos de achado (campo `checagem`) que esta função consegue dar como resolvidos quando roda sem erro e não os encontra mais.
const CHECAGENS = [
    { id: "saldo_vs_razao", grupo: "dinheiro", cobre: ["saldo_vs_razao"], roda: checarSaldoVsRazao },
    { id: "creditos_anormais", grupo: "dinheiro", cobre: ["creditos_anormais"], roda: checarCreditosAnormais },
    { id: "robos", grupo: "robos", cobre: ["robo_sem_sucesso", "robo_ultima_falhou"], roda: checarRobos },
];

// ─── Comparação com o que já estava aberto (função pura, testada sem banco) ───────────────────────────────

// atuais: achados desta rodada. abertos: linhas de bmax_auditoria_achados com resolvido_em NULL.
// checagensOk: tipos de achado (`checagem`) cobertos por checagens que rodaram sem erro, mais a chave "auditor_checagem_falhou:<id>" de cada
// uma delas. Só o que está nesse conjunto pode ser dado como resolvido: checagem que falhou ao rodar nunca resolve nada.
function reconciliar(atuais, abertos, checagensOk, agora = new Date(), reavisoDias = REAVISO_DIAS) {
    const abertosPorChave = new Map(abertos.map(a => [a.chave, a]));
    const chavesAtuais = new Set(atuais.map(a => a.chave));
    const limite = agora.getTime() - reavisoDias * 86400000;
    const novos = [], persistentes = [];
    for (const a of atuais) (abertosPorChave.has(a.chave) ? persistentes : novos).push(a);
    const okSet = new Set(checagensOk);
    const resolvidos = abertos.filter(a => !chavesAtuais.has(a.chave) && (okSet.has(a.checagem) || okSet.has(a.chave)));
    // Persistente só volta ao e-mail quando venceu o lembrete semanal (ou nunca foi avisado)
    const lembretes = persistentes.filter(a => {
        const antigo = abertosPorChave.get(a.chave);
        return !antigo.ultimo_aviso_em || new Date(antigo.ultimo_aviso_em).getTime() < limite;
    });
    return { novos, persistentes, resolvidos, lembretes, paraAvisar: [...novos, ...lembretes] };
}

// ─── E-mail ───────────────────────────────────────────────────────────────────────────────────────────────

const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const COR_SEV = { alta: "#e30613", media: "#e8890c", baixa: "#6b7280" };

function montarEmail({ novos, lembretes, resolvidos, abertosTotal }) {
    const bloco = (titulo, lista) => {
        if (!lista.length) return "";
        const porGrupo = {};
        for (const a of lista) (porGrupo[a.grupo] = porGrupo[a.grupo] || []).push(a);
        return `<h3 style="margin:18px 0 6px">${esc(titulo)} (${lista.length})</h3>` + Object.entries(porGrupo).map(([g, itens]) =>
            `<p style="margin:10px 0 4px;color:#1d327b"><strong>${esc(ROTULO_GRUPO[g] || g)}</strong></p><ul style="margin:0;padding-left:18px">${itens.map(a =>
                `<li style="margin-bottom:8px"><span style="color:${COR_SEV[a.severidade] || "#6b7280"};font-weight:bold">${esc((a.severidade || "").toUpperCase())}</span> ${esc(a.titulo)}${a.acao ? `<br><span style="color:#555;font-size:13px">O que fazer: ${esc(a.acao)}</span>` : ""}${a.link ? `<br><a href="${esc(a.link)}">abrir</a>` : ""}</li>`).join("")}</ul>`).join("");
    };
    const assunto = `BMAX - Auditor diário: ${novos.length} novo(s), ${abertosTotal} em aberto`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:20px">
        <h2 style="color:#1d327b;margin-bottom:4px">Auditor diário do BMAX</h2>
        <p style="margin-top:0;color:#555">${novos.length} achado(s) novo(s) · ${lembretes.length} lembrete(s) semanal(is) · ${resolvidos.length} resolvido(s) desde a última rodada · ${abertosTotal} em aberto no total.</p>
        ${bloco("Novos", novos)}${bloco("Continuam abertos (lembrete semanal)", lembretes)}${bloco("Resolvidos desde a última rodada", resolvidos.map(r => ({ grupo: r.grupo, severidade: "baixa", titulo: r.titulo })))}
        <p style="font-size:12px;color:#666;margin-top:24px">Aviso automático do Portal BMAX. O auditor só lê e avisa: nunca corrige nada. Detalhes em Gestão &gt; Auditor diário.</p></div>`;
    return { assunto, html };
}

// ─── Execução ─────────────────────────────────────────────────────────────────────────────────────────────

// dryRun: roda as checagens e devolve o resultado, sem gravar nada e sem enviar e-mail.
async function rodarAuditoria({ rodada = "manual", dryRun = false } = {}) {
    const t0 = Date.now();
    const atuais = [], checagensOk = [], tempos = [];
    let erros = 0;

    for (const c of CHECAGENS) {
        const c0 = Date.now();
        try {
            const achados = await c.roda();
            achados.forEach(a => atuais.push(a));
            checagensOk.push(...c.cobre, `auditor_checagem_falhou:${c.id}`);
            tempos.push({ id: c.id, ms: Date.now() - c0, achados: achados.length });
        } catch (e) {
            erros++;
            logger.error({ message: "Auditor: checagem falhou", checagem: c.id, error: e.message });
            tempos.push({ id: c.id, ms: Date.now() - c0, erro: e.message });
            atuais.push({ chave: `auditor_checagem_falhou:${c.id}`, grupo: c.grupo, checagem: "auditor_checagem_falhou", severidade: "alta",
                titulo: `A checagem "${c.id}" do auditor falhou ao rodar: ${e.message}`, detalhe: { checagem: c.id, erro: e.message },
                acao: "Ver o log da Vercel. Enquanto isso essa checagem não está vigiando nada." });
        }
    }

    let tabelasAusentes = false;
    const abertos = await sequelize.query(`SELECT chave, checagem, grupo, titulo, ultimo_aviso_em FROM bmax_auditoria_achados WHERE resolvido_em IS NULL`, { type: QueryTypes.SELECT })
        .catch(e => { if (!dryRun) throw e; tabelasAusentes = true; return []; });   // simulação funciona antes de o DDL ser aplicado
    const r = reconciliar(atuais, abertos, checagensOk);

    const resumo = {
        ok: erros === 0, rodada, dryRun, duracaoMs: 0, checagens: tempos,
        total: atuais.length, novos: r.novos.length, persistentes: r.persistentes.length, resolvidos: r.resolvidos.length,
        lembretes: r.lembretes.length, avisados: 0, emailEnviado: false,
    };
    if (dryRun) {
        resumo.duracaoMs = Date.now() - t0;
        resumo.achados = atuais;
        resumo.resolvidosLista = r.resolvidos.map(x => x.chave);
        resumo.emailSeriaEnviado = r.paraAvisar.length > 0;
        if (tabelasAusentes) resumo.aviso = "tabelas do auditor ainda não existem: tudo aparece como novo";
        return resumo;
    }

    for (const a of atuais) {
        await sequelize.query(
            `INSERT INTO bmax_auditoria_achados (chave, grupo, checagem, severidade, titulo, detalhe, link, acao_sugerida)
             VALUES (:chave, :grupo, :checagem, :severidade, :titulo, CAST(:detalhe AS jsonb), :link, :acao)
             ON CONFLICT (chave) DO UPDATE SET
                severidade = EXCLUDED.severidade, titulo = EXCLUDED.titulo, detalhe = EXCLUDED.detalhe, link = EXCLUDED.link, acao_sugerida = EXCLUDED.acao_sugerida,
                primeira_vez = CASE WHEN bmax_auditoria_achados.resolvido_em IS NOT NULL THEN now() ELSE bmax_auditoria_achados.primeira_vez END,
                ultimo_aviso_em = CASE WHEN bmax_auditoria_achados.resolvido_em IS NOT NULL THEN NULL ELSE bmax_auditoria_achados.ultimo_aviso_em END,
                resolvido_em = NULL, ultima_vez = now()`,
            { replacements: { chave: a.chave, grupo: a.grupo, checagem: a.checagem, severidade: a.severidade || "media", titulo: a.titulo, detalhe: JSON.stringify(a.detalhe || {}), link: a.link || null, acao: a.acao || null }, type: QueryTypes.INSERT }
        );
    }
    if (r.resolvidos.length) {
        await sequelize.query(`UPDATE bmax_auditoria_achados SET resolvido_em = now() WHERE chave IN (:chaves) AND resolvido_em IS NULL`,
            { replacements: { chaves: r.resolvidos.map(x => x.chave) }, type: QueryTypes.UPDATE });
    }

    if (r.paraAvisar.length) {
        const destino = process.env.EMAIL_AUDITOR;
        if (!destino) {
            erros++;
            resumo.erroEmail = "EMAIL_AUDITOR não configurado: há achados para avisar e nenhum e-mail foi enviado";
            logger.error({ message: resumo.erroEmail });
        } else {
            const { assunto, html } = montarEmail({ novos: r.novos, lembretes: r.lembretes, resolvidos: r.resolvidos, abertosTotal: atuais.length });
            const enviado = await sendEmail(destino, assunto, html).catch(() => false);
            if (enviado === false) {
                erros++;
                resumo.erroEmail = "falha ao enviar o e-mail do auditor";
            } else {
                resumo.emailEnviado = true;
                resumo.avisados = r.paraAvisar.length;
                await sequelize.query(`UPDATE bmax_auditoria_achados SET ultimo_aviso_em = now() WHERE chave IN (:chaves)`,
                    { replacements: { chaves: r.paraAvisar.map(x => x.chave) }, type: QueryTypes.UPDATE });
            }
        }
    }

    resumo.ok = erros === 0;
    if (erros) resumo.erros = erros;   // o monitor dos robôs (cronTracker) trata "erros" > 0 como falha e avisa o admin
    resumo.duracaoMs = Date.now() - t0;
    await sequelize.query(
        `INSERT INTO bmax_auditoria_execucoes (rodada, duracao_ms, total_achados, novos, resolvidos, avisados, email_enviado, resumo, erro)
         VALUES (:rodada, :ms, :total, :novos, :resolvidos, :avisados, :email, CAST(:resumo AS jsonb), :erro)`,
        { replacements: { rodada, ms: resumo.duracaoMs, total: resumo.total, novos: resumo.novos, resolvidos: resumo.resolvidos, avisados: resumo.avisados, email: resumo.emailEnviado, resumo: JSON.stringify({ checagens: tempos }), erro: resumo.erroEmail || null }, type: QueryTypes.INSERT }
    );
    return resumo;
}

module.exports = { rodarAuditoria, reconciliar, montarEmail, CHECAGENS, REAVISO_DIAS };
