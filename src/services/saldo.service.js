const { sequelize } = require("../database");
const { QueryTypes } = require("sequelize");
const { REVENDA_SEM_CREDITO } = require("../config/constants");
const { codigoDe, codigosDoGrupo, nomeUnico } = require("./codigoUnico.service");
const SEM_ID = "00000000-0000-0000-0000-000000000000"; // lista vazia segura para IN (...)

// `tipoAgente` default 'revenda' preserva 100% o comportamento anterior para todo
// chamador que não passa o parâmetro. Representante e Vendedor Interno/Técnico
// passam 'representante'/'vendedor_interno' pra terem carteira própria, isolada
// por (tipo_agente, revenda) — a coluna `revenda` virou, na prática, "nome do
// agente" (revenda, representante ou vendedor interno), mas o nome da coluna foi
// mantido pra não precisar migrar/renomear todo o resto do código já existente.
async function getSaldo(nome, tipoAgente = 'revenda') {
    const rows = await sequelize.query(
        `SELECT saldo FROM bmax_saldo WHERE revenda = :nome AND tipo_agente = :tipoAgente LIMIT 1`,
        { replacements: { nome, tipoAgente }, type: QueryTypes.SELECT }
    );
    return rows.length ? Number(rows[0].saldo) : 0;
}

async function upsertSaldo(nome, novoSaldo, tipoAgente = 'revenda') {
    nome = await nomeUnico(nome, tipoAgente);
    // Código único gravado ao lado do nome (etapa 4); se não resolver, mantém o código que a carteira já tinha.
    const cod = await codigoDe(nome, tipoAgente);
    await sequelize.query(
        `INSERT INTO bmax_saldo (revenda, saldo, tipo_agente, atualizado_em, revenda_id, grupo_id, representante_id)
         VALUES (:nome, :saldo, :tipoAgente, NOW(), :revendaId, :grupoId, :representanteId)
         ON CONFLICT (tipo_agente, revenda)
         DO UPDATE SET saldo = :saldo, atualizado_em = NOW(),
            revenda_id = COALESCE(:revendaId, bmax_saldo.revenda_id),
            grupo_id = COALESCE(:grupoId, bmax_saldo.grupo_id),
            representante_id = COALESCE(:representanteId, bmax_saldo.representante_id)`,
        { replacements: { nome, saldo: novoSaldo, tipoAgente, revendaId: cod.revenda_id, grupoId: cod.grupo_id, representanteId: cod.representante_id }, type: QueryTypes.INSERT }
    );
}

// `detalhes` guarda, de forma estruturada, o PCI/Classe de Preço/percentual
// usados NESTE crédito específico — antes só existiam embutidos em texto
// livre em `descricao` (ou nem isso, nos ajustes de recálculo), o que
// impedia auditar depois se o cálculo bateu com a regra vigente. Opcional
// (default {}) pra não quebrar nenhum chamador existente.
async function creditarCashback(nome, valor, descricao, leadId, tipoAgente = 'revenda', detalhes = {}) {
    const { pci = null, classePreco = null, comissaoPct = null } = detalhes;
    nome = await nomeUnico(nome, tipoAgente);   // carteira única por revenda, mesmo se o card trouxer o nome antigo (Pipefy/ZEN)
    const saldoAtual = await getSaldo(nome, tipoAgente);
    const novoSaldo = Number((saldoAtual + valor).toFixed(2));
    // Expiração de 180 dias é regra do cashback-produto da revenda (resgatável em
    // compras). Comissão de representante/vendedor interno é registro contábil
    // pra acompanhamento e pagamento — não "expira".
    const expiraEm = tipoAgente === 'revenda' ? new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString() : null;

    const cod = await codigoDe(nome, tipoAgente);
    await sequelize.query(
        `INSERT INTO bmax_transacoes (revenda, tipo, valor, descricao, lead_id, saldo_apos, expira_em, tipo_agente, pci, classe_preco, comissao_pct, revenda_id, grupo_id, representante_id)
         VALUES (:nome, 'credito', :valor, :descricao, :leadId, :saldoApos, :expiraEm, :tipoAgente, :pci, :classePreco, :comissaoPct, :revendaId, :grupoId, :representanteId)`,
        { replacements: { nome, valor, descricao, leadId, saldoApos: novoSaldo, expiraEm, tipoAgente, pci, classePreco, comissaoPct, revendaId: cod.revenda_id, grupoId: cod.grupo_id, representanteId: cod.representante_id }, type: QueryTypes.INSERT }
    );

    await upsertSaldo(nome, novoSaldo, tipoAgente);
    return novoSaldo;
}

async function debitarCashback(nome, valor, descricao, saqueId, tipoAgente = 'revenda') {
    nome = await nomeUnico(nome, tipoAgente);
    const saldoAtual = await getSaldo(nome, tipoAgente);
    const novoSaldo = Number((saldoAtual - valor).toFixed(2));

    const cod = await codigoDe(nome, tipoAgente);
    await sequelize.query(
        `INSERT INTO bmax_transacoes (revenda, tipo, valor, descricao, saque_id, saldo_apos, tipo_agente, revenda_id, grupo_id, representante_id)
         VALUES (:nome, 'debito', :valor, :descricao, :saqueId, :saldoApos, :tipoAgente, :revendaId, :grupoId, :representanteId)`,
        { replacements: { nome, valor, descricao, saqueId, saldoApos: novoSaldo, tipoAgente, revendaId: cod.revenda_id, grupoId: cod.grupo_id, representanteId: cod.representante_id }, type: QueryTypes.INSERT }
    );

    await upsertSaldo(nome, novoSaldo, tipoAgente);
    return novoSaldo;
}

// Leitura por NOME ou por CÓDIGO (etapa 5): se a entidade for renomeada, o extrato continua achando as linhas pelo código.
async function getExtrato(nome, tipoAgente = 'revenda') {
    const cod = await codigoDe(nome, tipoAgente);
    return sequelize.query(
        `SELECT id, tipo, valor, descricao, lead_id, saque_id, saldo_apos, expira_em, criado_em
         FROM bmax_transacoes WHERE tipo_agente = :tipoAgente
           AND (revenda = :nome OR revenda_id = :revendaId OR grupo_id = :grupoId OR representante_id = :representanteId)
         ORDER BY criado_em DESC LIMIT 200`,
        { replacements: { nome, tipoAgente, revendaId: cod.revenda_id, grupoId: cod.grupo_id, representanteId: cod.representante_id }, type: QueryTypes.SELECT }
    );
}

async function getExpirandoEm(dias) {
    const desde = new Date();
    const ate = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
    return sequelize.query(
        `SELECT id, revenda, valor, descricao, expira_em, criado_em
         FROM bmax_transacoes
         WHERE tipo = 'credito' AND tipo_agente = 'revenda' AND expira_em IS NOT NULL
           AND expira_em > :desde AND expira_em <= :ate
           AND NOT EXISTS (
               SELECT 1 FROM bmax_transacoes t2
               WHERE t2.descricao LIKE '%Expirado:%' AND t2.descricao LIKE '%' || bmax_transacoes.id::text || '%'
           )
         ORDER BY expira_em ASC`,
        { replacements: { desde: desde.toISOString(), ate: ate.toISOString() }, type: QueryTypes.SELECT }
    );
}

async function processarExpirados() {
    const agora = new Date().toISOString();
    const expirados = await sequelize.query(
        `SELECT id, revenda, valor, descricao, expira_em
         FROM bmax_transacoes
         WHERE tipo = 'credito' AND tipo_agente = 'revenda' AND expira_em IS NOT NULL AND expira_em <= :agora
           AND NOT EXISTS (
               SELECT 1 FROM bmax_transacoes t2
               WHERE t2.descricao LIKE 'Expirado: credito ' || bmax_transacoes.id::text
           )`,
        { replacements: { agora }, type: QueryTypes.SELECT }
    );

    const resultados = [];
    for (const tx of expirados) {
        await debitarCashback(tx.revenda, Number(tx.valor), `Expirado: credito ${tx.id}`, null);
        resultados.push({ id: tx.id, revenda: tx.revenda, valor: tx.valor });
    }
    return resultados;
}

async function getCreditosProximosVencimento(revenda) {
    const em30dias = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const cod = await codigoDe(revenda, "revenda");
    return sequelize.query(
        `SELECT id, valor, descricao, lead_id, expira_em, criado_em
         FROM bmax_transacoes
         WHERE tipo = 'credito' AND tipo_agente = 'revenda' AND (revenda = :revenda OR revenda_id = :revendaId OR grupo_id = :grupoId)
           AND expira_em IS NOT NULL AND expira_em <= :em30dias AND expira_em > NOW()
           AND NOT EXISTS (
               SELECT 1 FROM bmax_transacoes t2
               WHERE t2.descricao LIKE 'Expirado: credito ' || bmax_transacoes.id::text
           )
         ORDER BY expira_em ASC`,
        { replacements: { revenda, em30dias, revendaId: cod.revenda_id, grupoId: cod.grupo_id }, type: QueryTypes.SELECT }
    );
}

async function getGrupoRevendas(grupo) {
    const rows = await sequelize.query(
        `SELECT revenda_rd FROM bmax_grupos WHERE grupo = :grupo`,
        { replacements: { grupo }, type: QueryTypes.SELECT }
    );
    return rows.map(r => r.revenda_rd);
}

async function getSaldoGrupo(revenda, grupo) {
    if (!grupo) return getSaldo(revenda);
    const revendas = await getGrupoRevendas(grupo);
    if (!revendas.length) return getSaldo(revenda);
    const cg = await codigosDoGrupo(grupo);   // leitura por nome (bmax_grupos) OU por código (grupo/lojas): a mesma linha nunca é somada 2x
    const rows = await sequelize.query(
        `SELECT COALESCE(SUM(saldo), 0) as total FROM bmax_saldo
         WHERE tipo_agente = 'revenda' AND (revenda IN (:revendas) OR grupo_id = :grupoId OR revenda_id IN (:lojaIds))`,
        { replacements: { revendas, grupoId: cg.grupoId, lojaIds: cg.lojaIds.length ? cg.lojaIds : [SEM_ID] }, type: QueryTypes.SELECT }
    );
    return Number(rows[0].total);
}

// Carteiras de revenda com saldo positivo do grupo (mesma regra de leitura do getSaldoGrupo), a da loja que pede primeiro, depois as maiores
async function carteirasDoGrupo(revenda, grupo) {
    const revendas = await getGrupoRevendas(grupo);
    const cg = await codigosDoGrupo(grupo);
    return sequelize.query(
        `SELECT revenda, saldo::float AS saldo FROM bmax_saldo
         WHERE tipo_agente = 'revenda' AND saldo > 0 AND (revenda IN (:revendas) OR grupo_id = :grupoId OR revenda_id IN (:lojaIds))
         ORDER BY (revenda = :primeira) DESC, saldo DESC`,
        { replacements: { revendas: revendas.length ? revendas : [SEM_ID], grupoId: cg.grupoId, lojaIds: cg.lojaIds.length ? cg.lojaIds : [SEM_ID], primeira: revenda }, type: QueryTypes.SELECT }
    );
}

// Débito de saque de GRUPO: o saldo que a revenda vê é a soma das lojas do grupo, então o saque sai das carteiras em ordem (nenhuma fica negativa).
// Devolve as partes debitadas. Lança erro se a soma das carteiras com saldo não cobre o valor.
async function debitarCashbackGrupo(revenda, grupo, valor, descricao, saqueId) {
    const carteiras = await carteirasDoGrupo(revenda, grupo);
    const disponivel = carteiras.reduce((s, c) => s + c.saldo, 0);
    if (valor > disponivel + 0.005) throw new Error(`Saldo insuficiente. Disponivel: R$ ${disponivel.toFixed(2)}`);
    let restante = Number(valor.toFixed(2)); const partes = [];
    for (const c of carteiras) {
        if (restante <= 0.004) break;
        const parte = Number(Math.min(restante, c.saldo).toFixed(2));
        await debitarCashback(c.revenda, parte, descricao, saqueId);
        partes.push({ carteira: c.revenda, valor: parte }); restante = Number((restante - parte).toFixed(2));
    }
    return partes;
}

async function getExtratoGrupo(revenda, grupo) {
    if (!grupo) return getExtrato(revenda);
    const revendas = await getGrupoRevendas(grupo);
    if (!revendas.length) return getExtrato(revenda);
    const cg = await codigosDoGrupo(grupo);
    const rows = await sequelize.query(
        `SELECT id, tipo, valor, descricao, lead_id, saque_id, saldo_apos, expira_em, criado_em, revenda
         FROM bmax_transacoes WHERE tipo_agente = 'revenda' AND (revenda IN (:revendas) OR grupo_id = :grupoId OR revenda_id IN (:lojaIds))
         ORDER BY criado_em ASC LIMIT 200`,
        { replacements: { revendas, grupoId: cg.grupoId, lojaIds: cg.lojaIds.length ? cg.lojaIds : [SEM_ID] }, type: QueryTypes.SELECT }
    );
    let running = 0;
    for (const r of rows) {
        running += r.tipo === "credito" ? Number(r.valor) : -Number(r.valor);
        r.saldo_apos = Number(running.toFixed(2));
    }
    rows.reverse();
    return rows;
}

async function getCreditosProximosVencimentoGrupo(revenda, grupo) {
    if (!grupo) return getCreditosProximosVencimento(revenda);
    const revendas = await getGrupoRevendas(grupo);
    if (!revendas.length) return getCreditosProximosVencimento(revenda);
    const em30dias = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const cg = await codigosDoGrupo(grupo);
    return sequelize.query(
        `SELECT id, valor, descricao, lead_id, expira_em, criado_em, revenda
         FROM bmax_transacoes
         WHERE tipo = 'credito' AND tipo_agente = 'revenda' AND (revenda IN (:revendas) OR grupo_id = :grupoId OR revenda_id IN (:lojaIds))
           AND expira_em IS NOT NULL AND expira_em <= :em30dias AND expira_em > NOW()
           AND NOT EXISTS (
               SELECT 1 FROM bmax_transacoes t2
               WHERE t2.descricao LIKE 'Expirado: credito ' || bmax_transacoes.id::text
           )
         ORDER BY expira_em ASC`,
        { replacements: { revendas, em30dias, grupoId: cg.grupoId, lojaIds: cg.lojaIds.length ? cg.lojaIds : [SEM_ID] }, type: QueryTypes.SELECT }
    );
}

const _repRevendasCache = {};
const REP_CACHE_TTL = 5 * 60 * 1000;

async function getRepRevendas(username) {
    const cached = _repRevendasCache[username];
    if (cached && Date.now() - cached.ts < REP_CACHE_TTL) return cached.data;

    const { getLeads, getCustomField, getAliasMaps } = require("../services/rd.leads.service");
    const allDeals = await getLeads("admin", "adm");
    const { usernameToRd, rdToUsername, loginToNomes } = await getAliasMaps();
    const rdName = usernameToRd[username] || username;
    const portalAliases = [username, rdName, ...Object.entries(rdToUsername).filter(([, v]) => v === username).map(([k]) => k),
        ...(loginToNomes[username] || []), ...(loginToNomes[String(username).toLowerCase()] || [])];
    const nameSet = new Set(portalAliases);
    const revendas = new Set();
    for (const d of allDeals) {
        const rep = getCustomField(d, "REPRESENTANTE");
        if (nameSet.has(rep)) {
            const rev = getCustomField(d, "REVENDA/LOJA");
            // "Sem Revenda" é venda direta, sem parceira — não é "uma revenda do
            // representante" pra fins de saldo agregado (achado 21/09/2026: um
            // saldo fantasma "Sem Revenda" de OUTRO representante vazava pro
            // "Saldo Revendas" de qualquer rep que também tivesse leads sem revenda).
            if (rev && rev.trim() && !REVENDA_SEM_CREDITO.includes(rev.trim())) revendas.add(rev.trim());
        }
    }
    const result = Array.from(revendas);
    _repRevendasCache[username] = { data: result, ts: Date.now() };
    return result;
}

// Visão "quanto minhas revendas acumularam" — mantida como estava, além da
// carteira própria do representante (ver getSaldo/getExtrato com tipoAgente
// 'representante', creditada de verdade a partir de calcularComissoes).
async function getSaldoRep(username) {
    const revendas = await getRepRevendas(username);
    if (!revendas.length) return 0;
    const rows = await sequelize.query(
        `SELECT COALESCE(SUM(saldo), 0) as total FROM bmax_saldo WHERE revenda IN (:revendas) AND tipo_agente = 'revenda'`,
        { replacements: { revendas }, type: QueryTypes.SELECT }
    );
    return Number(rows[0].total);
}

async function getExtratoRep(username) {
    const revendas = await getRepRevendas(username);
    if (!revendas.length) return [];
    const rows = await sequelize.query(
        `SELECT id, tipo, valor, descricao, lead_id, saque_id, saldo_apos, expira_em, criado_em, revenda
         FROM bmax_transacoes WHERE revenda IN (:revendas) AND tipo_agente = 'revenda' ORDER BY criado_em ASC LIMIT 200`,
        { replacements: { revendas }, type: QueryTypes.SELECT }
    );
    let running = 0;
    for (const r of rows) {
        running += r.tipo === "credito" ? Number(r.valor) : -Number(r.valor);
        r.saldo_apos = Number(running.toFixed(2));
    }
    rows.reverse();
    return rows;
}

async function getCreditosExpirandoRep(username) {
    const revendas = await getRepRevendas(username);
    if (!revendas.length) return [];
    const em30dias = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    return sequelize.query(
        `SELECT id, valor, descricao, lead_id, expira_em, criado_em, revenda
         FROM bmax_transacoes
         WHERE tipo = 'credito' AND tipo_agente = 'revenda' AND revenda IN (:revendas)
           AND expira_em IS NOT NULL AND expira_em <= :em30dias AND expira_em > NOW()
           AND NOT EXISTS (
               SELECT 1 FROM bmax_transacoes t2
               WHERE t2.descricao LIKE 'Expirado: credito ' || bmax_transacoes.id::text
           )
         ORDER BY expira_em ASC`,
        { replacements: { revendas, em30dias }, type: QueryTypes.SELECT }
    );
}

// Escopado a tipo_agente='revenda': o card do lead mostra o cashback da REVENDA
// especificamente, não deve somar junto a comissão de representante/vendedor
// interno creditada pro mesmo lead_id.
// `aliasRd`: { idDoPipefy: idDoRd } — créditos antigos foram lançados sob o id do RD; o card do Pipefy soma os dois
async function getCreditosPorLeads(leadIds, aliasRd = {}) {
    if (!leadIds.length) return {};
    const todos = [...new Set([...leadIds, ...Object.values(aliasRd).filter(Boolean)].map(String))];
    const rows = await sequelize.query(
        `SELECT lead_id, SUM(valor) as total FROM bmax_transacoes
         WHERE tipo = 'credito' AND tipo_agente = 'revenda' AND lead_id IN (:leadIds)
         GROUP BY lead_id`,
        { replacements: { leadIds: todos }, type: QueryTypes.SELECT }
    );
    const bruto = {};
    for (const r of rows) bruto[r.lead_id] = Number(r.total);
    const map = {};
    for (const id of leadIds) {
        const a = bruto[id], b = aliasRd[id] ? bruto[aliasRd[id]] : undefined;
        if (a !== undefined || b !== undefined) map[id] = Number(((a || 0) + (b || 0)).toFixed(2));
    }
    return map;
}

// Acrescenta `lead_nome` (nome do deal no RD, igual ao do card) em cada linha
// que tem lead_id. Não altera `descricao`. Falha de RD não derruba o extrato.
async function anexarNomeLead(rows) {
    if (!rows || !rows.length) return rows;
    const ids = rows.map(r => r.lead_id).filter(Boolean);
    if (!ids.length) return rows;
    const { getInfoDeLeads } = require("./rd.leads.service");
    const { nomes, info } = await getInfoDeLeads(ids);
    for (const r of rows) { r.lead_nome = r.lead_id ? (nomes[String(r.lead_id)] || null) : null; r.lead_card_id = r.lead_id ? (info[String(r.lead_id)] || null) : null; }
    return rows;
}

const TIPOS_AGENTE_VALIDOS =['revenda', 'representante', 'vendedor_interno'];

// Lista todo mundo que já teve algum crédito/débito registrado para um tipo de
// agente — base pro módulo Admin de "extrato por agente" (dropdown de nomes) e
// pro export multi-aba.
async function listarAgentes(tipoAgente) {
    if (!TIPOS_AGENTE_VALIDOS.includes(tipoAgente)) return [];
    return sequelize.query(
        `SELECT s.revenda as nome, s.saldo
         FROM bmax_saldo s WHERE s.tipo_agente = :tipoAgente
         ORDER BY s.revenda ASC`,
        { replacements: { tipoAgente }, type: QueryTypes.SELECT }
    );
}

// Extrato de um agente específico, com filtro opcional de período (mesAno no
// formato 'YYYY-MM'; sem filtro = tudo acumulado). Diferente de getExtrato (que
// limita a 200 linhas pro uso de tela) — aqui não há limite, pensado pra export.
async function getExtratoPorAgente(tipoAgente, nome, mesAno) {
    let where = `tipo_agente = :tipoAgente AND revenda = :nome`;
    const replacements = { tipoAgente, nome };
    if (mesAno) {
        where += ` AND to_char(criado_em, 'YYYY-MM') = :mesAno`;
        replacements.mesAno = mesAno;
    }
    return sequelize.query(
        `SELECT id, tipo, valor, descricao, lead_id, saque_id, saldo_apos, expira_em, criado_em, pci, classe_preco, comissao_pct
         FROM bmax_transacoes WHERE ${where} ORDER BY criado_em ASC`,
        { replacements, type: QueryTypes.SELECT }
    );
}

// Extrato de TODOS os agentes de um tipo, já com o nome em cada linha — usado
// pelo export "uma aba por agente".
async function getExtratoTipoAgente(tipoAgente, mesAno) {
    let where = `tipo_agente = :tipoAgente`;
    const replacements = { tipoAgente };
    if (mesAno) {
        where += ` AND to_char(criado_em, 'YYYY-MM') = :mesAno`;
        replacements.mesAno = mesAno;
    }
    return sequelize.query(
        `SELECT revenda as nome, id, tipo, valor, descricao, lead_id, saldo_apos, expira_em, criado_em, pci, classe_preco, comissao_pct
         FROM bmax_transacoes WHERE ${where} ORDER BY revenda ASC, criado_em ASC`,
        { replacements, type: QueryTypes.SELECT }
    );
}

module.exports = { anexarNomeLead, getGrupoRevendas, carteirasDoGrupo, debitarCashbackGrupo, getSaldo, getSaldoGrupo, upsertSaldo, creditarCashback, debitarCashback, getExtrato, getExtratoGrupo, getExpirandoEm, processarExpirados, getCreditosProximosVencimento, getCreditosProximosVencimentoGrupo, getRepRevendas, getSaldoRep, getExtratoRep, getCreditosExpirandoRep, getCreditosPorLeads, listarAgentes, getExtratoPorAgente, getExtratoTipoAgente };
