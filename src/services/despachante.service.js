// DESPACHANTE DOS ROBÔS (27/11/2026). Rede de segurança contra cron perdido da Vercel.
// Problema: a Vercel dispara cada cron uma única vez e NÃO tenta de novo; em 25–27/11 várias rodadas (inclusive o auditor das 06h) simplesmente não aconteceram,
// e o monitor antigo só reclamava depois de 30 h. Solução: um cron FREQUENTE (a cada 10 min) olha a agenda dos robôs, vê no histórico (bmax_robo_execucoes)
// se a rodada que já deveria ter acontecido teve sucesso e, se não teve, DISPARA o robô na hora (catch-up). Uma rodada perdida passa a atrasar minutos, não horas.
// Os crons individuais continuam como estão; o despachante só age quando falta sucesso depois da carência. Os robôs são idempotentes.
// Proteções: cada (robô, rodada) é "reservado" em bmax_robo_disparo (nunca dois despachantes na mesma rodada); no máximo 3 tentativas, com espera entre elas;
// esgotadas as tentativas, avisa os admins por e-mail UMA vez. DDL: scripts/sql/despachante-27-11-2026.sql.

const { sequelize } = require("../database");
const { QueryTypes } = require("sequelize");
const { logger } = require("../logger");

// Agenda = a mesma do vercel.json (horários em UTC). `janelaH` = por quanto tempo depois do horário ainda vale correr atrás da rodada perdida.
// `soAusente: true` = robô SEM controle próprio contra e-mail repetido: o despachante só corre atrás dele se NÃO existir nenhuma execução desde o horário
// (nem com falha; falha já gera aviso aos admins pelo monitor). Os demais têm controle próprio (flags, reconciliação, idempotência) e podem ser repetidos.
// `janelaH` = por quanto tempo depois do horário ainda vale correr atrás da rodada perdida (diários: só em horário comercial, nunca de madrugada).
const AGENDA = [
    { robo: "auditor", chave: "auditor:manha", path: "/api/cron/auditor?rodada=manha", slots: ["09:00"], janelaH: 6 },
    { robo: "auditor", chave: "auditor:tarde", path: "/api/cron/auditor?rodada=tarde", slots: ["16:00"], janelaH: 5 },
    { robo: "expirar-cashback", path: "/api/cron/expirar-cashback", slots: ["10:00"], janelaH: 7, soAusente: true },   // avisa por e-mail todo dia, sem controle de repetição
    { robo: "pci12a-prazo", path: "/api/cron/pci12a-prazo", slots: ["11:00"], janelaH: 7 },
    { robo: "pcix-prazo", path: "/api/cron/pcix-prazo", slots: ["11:30"], janelaH: 7 },
    { robo: "status-x-etapa", path: "/api/cron/status-x-etapa", slots: ["11:30"], janelaH: 7 },
    { robo: "termos-prazos", path: "/api/cron/termos-prazos", slots: ["13:00"], janelaH: 6, soAusente: true },
    { robo: "sync-consulta-lead", path: "/api/cron/sync-consulta-lead", slots: ["12:00", "17:00", "21:00"], janelaH: 3 },
    { robo: "recalcular-comissoes", path: "/api/cron/recalcular-comissoes", slots: ["12:00", "15:00", "18:00", "21:00"], janelaH: 2.5 },
    { robo: "sync-revenda-rep-rd", path: "/api/cron/sync-revenda-rep-rd", slots: ["10:00", "13:00", "17:00", "20:00"], janelaH: 2.5 },
    { robo: "pci12-followup", path: "/api/cron/pci12-followup", slots: ["10:00", "13:00", "17:00", "20:00"], janelaH: 2.5 },
    { robo: "cheques-zen", path: "/api/cron/cheques-zen", slots: ["08:30", "15:30"], janelaH: 2.5 },   // idempotente e incremental; roda antes do auditor (09:00 e 16:00)
    { robo: "vigia-robos", path: "/api/cron/vigia-robos", slots: ["22:30"], janelaH: 1.5, soAusente: true },
];

const CARENCIA_MIN = 10;          // espera depois do horário antes de dar a rodada por perdida (o cron normal ainda pode estar rodando)
const ESPERA_ENTRE_TENTATIVAS_MIN = 12;
const MAX_TENTATIVAS = 3;
const ORCAMENTO_MS = 230000;      // a função tem 300 s; o que não couber fica para o próximo ciclo (10 min)

// Último horário da agenda que já passou (UTC) para um "HH:MM".
function ultimoSlot(agora, hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    const d = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), h, m, 0));
    if (d.getTime() > agora.getTime()) d.setUTCDate(d.getUTCDate() - 1);
    return d;
}

// Rodadas que já deveriam ter acontecido e ainda estão dentro da janela. Função pura.
function rodadasVencidas(agora, agenda = AGENDA) {
    const out = [];
    for (const a of agenda) {
        for (const hhmm of a.slots) {
            const slot = ultimoSlot(agora, hhmm);
            const idadeMin = (agora.getTime() - slot.getTime()) / 60000;
            if (idadeMin >= CARENCIA_MIN && idadeMin <= a.janelaH * 60) out.push({ robo: a.robo, chave: a.chave || a.robo, path: a.path, slot, soAusente: !!a.soAusente });
        }
    }
    return out.sort((x, y) => x.slot - y.slot);
}

// Das vencidas, as que ainda precisam rodar. execs: Map robo -> { ok: Date|null, qualquer: Date|null } (última execução com sucesso e última de qualquer tipo).
// Robô comum: pendente se não houve SUCESSO desde o horário. Robô `soAusente`: pendente só se não houve NENHUMA execução desde o horário.
function pendentes(vencidas, execs) {
    return vencidas.filter(r => {
        const e = execs.get(r.robo) || {};
        const ref = r.soAusente ? e.qualquer : e.ok;
        return !ref || new Date(ref).getTime() < r.slot.getTime();
    });
}

async function ultimosSucessos() {
    const rows = await sequelize.query(`SELECT robo, MAX(iniciado_em) FILTER (WHERE ok) AS ok_em, MAX(iniciado_em) AS qualquer_em FROM bmax_robo_execucoes WHERE iniciado_em > now() - interval '3 days' GROUP BY robo`, { type: QueryTypes.SELECT });
    return new Map(rows.map(r => [r.robo, { ok: r.ok_em ? new Date(r.ok_em) : null, qualquer: r.qualquer_em ? new Date(r.qualquer_em) : null }]));
}

// Reserva a rodada. Devolve o número da tentativa, ou null se outro despachante já reservou / acabaram as tentativas / ainda está no intervalo de espera.
async function reservar(r) {
    const rows = await sequelize.query(
        `INSERT INTO bmax_robo_disparo (robo, slot, tentativas, ultima_tentativa) VALUES (:chave, :slot, 1, now())
         ON CONFLICT (robo, slot) DO UPDATE SET tentativas = bmax_robo_disparo.tentativas + 1, ultima_tentativa = now()
          WHERE bmax_robo_disparo.tentativas < :max AND bmax_robo_disparo.ultima_tentativa < now() - make_interval(mins => :espera)
         RETURNING tentativas`,
        { replacements: { chave: r.chave, slot: r.slot, max: MAX_TENTATIVAS, espera: ESPERA_ENTRE_TENTATIVAS_MIN }, type: QueryTypes.SELECT });
    return rows.length ? Number(rows[0].tentativas) : null;
}

async function chamarRobo(path, timeoutMs) {
    const chave = process.env.CRON_SECRET || process.env.CRON_TRIGGER_KEY;
    if (!chave) throw new Error("CRON_SECRET não configurado: o despachante não consegue chamar os robôs");
    const base = process.env.CRON_BASE_URL || "https://bmax.boxersoldas.com.br";
    const r = await fetch(base + path, { headers: { Authorization: `Bearer ${chave}` }, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, ok: r.ok };
}

// `deps` existe para teste (banco e HTTP falsos).
async function despachar({ agora = new Date(), deps = {}, orcamentoMs = ORCAMENTO_MS } = {}) {
    const d = { sucessos: ultimosSucessos, reservar, chamar: chamarRobo, avisar: avisarEsgotado, agenda: AGENDA, ...deps };
    const t0 = Date.now();
    const pend = pendentes(rodadasVencidas(agora, d.agenda), await d.sucessos());
    const feitos = [];
    for (const r of pend) {
        const restante = orcamentoMs - (Date.now() - t0);
        if (restante < 20000) { feitos.push({ robo: r.chave, slot: r.slot.toISOString(), resultado: "adiado (sem tempo neste ciclo)" }); continue; }
        let tentativa;
        try { tentativa = await d.reservar(r); } catch (e) { logger.error({ message: "Despachante: falha ao reservar rodada", robo: r.chave, error: e.message }); feitos.push({ robo: r.chave, slot: r.slot.toISOString(), resultado: "erro ao reservar: " + e.message }); continue; }
        if (!tentativa) continue;   // outro ciclo já cuidou, ou aguardando o intervalo entre tentativas, ou tentativas esgotadas
        let ok = false, detalhe = "";
        try { const resp = await d.chamar(r.path, Math.min(restante - 5000, 280000)); ok = resp.ok; detalhe = "HTTP " + resp.status; }
        catch (e) { detalhe = String(e.message || e).slice(0, 160); }
        feitos.push({ robo: r.chave, slot: r.slot.toISOString(), tentativa, resultado: ok ? "rodou" : "falhou: " + detalhe });
        logger.warn({ message: "Despachante: rodada perdida recuperada", robo: r.chave, slot: r.slot.toISOString(), tentativa, ok, detalhe });
        if (!ok && tentativa >= MAX_TENTATIVAS) { try { await d.avisar(r, detalhe); } catch (e) { logger.error({ message: "Despachante: falha ao avisar", error: e.message }); } }
    }
    return { ok: !feitos.some(f => /^falhou|^erro/.test(f.resultado)), pendentes: pend.length, acionados: feitos.filter(f => f.tentativa).length, feitos };
}

async function avisarEsgotado(r, detalhe) {
    const { alertarAdminErro } = require("./email.service");
    await alertarAdminErro(`Robô "${r.chave}" não rodou, mesmo com ${MAX_TENTATIVAS} tentativas`, new Error(detalhe || "sem resposta"), { "rodada prevista (UTC)": r.slot.toISOString(), "o que fazer": "Ver os logs da Vercel e a tabela bmax_robo_execucoes; rodar o cron manualmente em Settings > Cron Jobs > Run." });
}

module.exports = { despachar, rodadasVencidas, pendentes, ultimoSlot, AGENDA, CARENCIA_MIN, MAX_TENTATIVAS };
