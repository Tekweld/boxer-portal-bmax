// USO DO CASHBACK (CHEQUE) x PEDIDO DO ZEN (27/11/2026). Regra do André: o uso da comissão da revenda é o saque que gera o cheque (bmax_saques.codigo_cheque,
// ex.: BMAX-2026-31405); o PEDIDO do ZEN que aplica o cheque cita o código na observação (properties.comments); o custo do uso entra na margem desse pedido.
// Aqui só se GUARDA o que o Portal e o ZEN dizem, como vieram. Nada é calculado e nada é corrigido (o auditor só avisa). DDL: scripts/sql/cheques-uso-27-11-2026.sql.

const so = s => String(s || "").replace(/\D/g, "");

// Códigos de cheque citados num texto livre. Aceita "BMAX-2026-31405", "BMAX 2026 31405" e "BMAX2026-31405". Devolve em maiúsculas e no formato BMAX-AAAA-NNNNN, sem repetir.
function extrairCodigos(texto) {
    const out = new Set();
    for (const m of String(texto || "").matchAll(/BMAX[-\s]?(\d{4})[-\s]?(\d{3,6})/gi)) out.add(`BMAX-${m[1]}-${m[2]}`);
    return [...out];
}

// cheques: linhas de bmax_saques com código; pedidos: de zenNf.pedidosRecentes; itensPorPedido: Map pedido_id -> itens; tabela: Map codigo -> modelo (Tabela BMax)
function prepararRegistros({ cheques, pedidos, itensPorPedido = new Map(), tabela = null }) {
    const porCodigo = new Map(cheques.filter(c => c.codigo_cheque).map(c => [String(c.codigo_cheque).toUpperCase(), c]));
    const out = { usos: [], itens: [] };
    const itensVistos = new Set();
    for (const p of pedidos) {
        for (const codigo of extrairCodigos(p.observacao)) {
            const c = porCodigo.get(codigo) || null;
            const cli = p.cliente || {}, ven = p.vendedor || {};
            out.usos.push({
                codigo_cheque: codigo, pedido_id: String(p.pedido_id), codigo_existe: !!c, saque_id: c ? c.id : null, revenda: c ? c.revenda : null, tipo_uso: c ? c.tipo_uso : null,
                valor_cheque: c && c.valor != null ? Number(c.valor) : null, cheque_status: c ? c.status : null, cheque_criado_em: c ? c.criado_em : null, cheque_expira_em: c ? c.expira_em : null, cheque_utilizado_em: c ? c.utilizado_em : null,
                pedido_data: p.data || null, pedido_status: p.status || null, pedido_perfil: p.perfil || null, pedido_perfil_descricao: p.perfil_descricao || null, pedido_operacao_fiscal: p.operacao_fiscal || null,
                pedido_total: p.total, pedido_custo_total: p.custo_total, pedido_forma_pagamento: p.forma_pagamento || null, pedido_tags: p.tags || null, pedido_tipo_frete: p.tipo_frete || null, pedido_observacao: p.observacao || null,
                cliente_cnpj: so(cli.documento) || null, cliente_zen_id: cli.id != null ? cli.id : null, cliente_nome: cli.nome || null, vendedor_zen_id: ven.id != null ? ven.id : null, vendedor_nome: ven.nome || null,
                nf_id: p.nf_id != null ? Number(p.nf_id) : null, nf_numero: p.nf_numero || null, zen_bruto: p,
            });
            if (itensVistos.has(String(p.pedido_id))) continue;
            itensVistos.add(String(p.pedido_id));
            for (const it of (itensPorPedido.get(String(p.pedido_id)) || [])) {
                out.itens.push({ pedido_id: String(p.pedido_id), item_id: it.item_id, produto_codigo: it.codigo || null, produto_descricao: it.descricao || null, tabela_bmax_modelo: tabela && tabela.get(it.codigo) ? tabela.get(it.codigo) : null,
                    unidade: it.unidade, quantidade: it.quantidade, valor_unitario: it.valor_unitario, custo_unitario: it.custo_unitario, custo_total: it.custo_total, valor_bruto_produto: it.valor_bruto_produto, desconto: it.desconto,
                    valor_produto: it.valor_produto, outros_valores: it.outros_valores || {}, valor_operacao: it.valor_operacao, imposto_incluso: it.imposto_incluso, imposto_fora: it.imposto_fora, valor_total: it.valor_total,
                    valor_efetivo: it.valor_efetivo, operacao_tributaria: it.operacao_tributaria });
            }
        }
    }
    return out;
}

const J = v => (v == null ? null : JSON.stringify(v));

async function gravar(sequelize, regs) {
    const { QueryTypes } = require("sequelize");
    await sequelize.transaction(async (transaction) => {
        const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.INSERT, transaction });
        for (const u of regs.usos) {
            await q(`INSERT INTO bmax_cheque_uso (codigo_cheque, pedido_id, codigo_existe, saque_id, revenda, tipo_uso, valor_cheque, cheque_status, cheque_criado_em, cheque_expira_em, cheque_utilizado_em, pedido_data, pedido_status, pedido_perfil,
                       pedido_perfil_descricao, pedido_operacao_fiscal, pedido_total, pedido_custo_total, pedido_forma_pagamento, pedido_tags, pedido_tipo_frete, pedido_observacao, cliente_cnpj, cliente_zen_id, cliente_nome, vendedor_zen_id,
                       vendedor_nome, nf_id, nf_numero, zen_bruto)
                     VALUES (:codigo_cheque, :pedido_id, :codigo_existe, :saque_id, :revenda, :tipo_uso, :valor_cheque, :cheque_status, :cheque_criado_em, :cheque_expira_em, :cheque_utilizado_em, :pedido_data, :pedido_status, :pedido_perfil,
                       :pedido_perfil_descricao, :pedido_operacao_fiscal, :pedido_total, :pedido_custo_total, :pedido_forma_pagamento, :pedido_tags, :pedido_tipo_frete, :pedido_observacao, :cliente_cnpj, :cliente_zen_id, :cliente_nome,
                       :vendedor_zen_id, :vendedor_nome, :nf_id, :nf_numero, CAST(:zen_bruto AS jsonb))
                     ON CONFLICT (codigo_cheque, pedido_id) DO UPDATE SET codigo_existe = EXCLUDED.codigo_existe, saque_id = EXCLUDED.saque_id, revenda = EXCLUDED.revenda, tipo_uso = EXCLUDED.tipo_uso, valor_cheque = EXCLUDED.valor_cheque,
                       cheque_status = EXCLUDED.cheque_status, cheque_criado_em = EXCLUDED.cheque_criado_em, cheque_expira_em = EXCLUDED.cheque_expira_em, cheque_utilizado_em = EXCLUDED.cheque_utilizado_em, pedido_data = EXCLUDED.pedido_data,
                       pedido_status = EXCLUDED.pedido_status, pedido_perfil = EXCLUDED.pedido_perfil, pedido_perfil_descricao = EXCLUDED.pedido_perfil_descricao, pedido_operacao_fiscal = EXCLUDED.pedido_operacao_fiscal,
                       pedido_total = EXCLUDED.pedido_total, pedido_custo_total = EXCLUDED.pedido_custo_total, pedido_forma_pagamento = EXCLUDED.pedido_forma_pagamento, pedido_tags = EXCLUDED.pedido_tags, pedido_tipo_frete = EXCLUDED.pedido_tipo_frete,
                       pedido_observacao = EXCLUDED.pedido_observacao, cliente_cnpj = EXCLUDED.cliente_cnpj, cliente_zen_id = EXCLUDED.cliente_zen_id, cliente_nome = EXCLUDED.cliente_nome, vendedor_zen_id = EXCLUDED.vendedor_zen_id,
                       vendedor_nome = EXCLUDED.vendedor_nome, nf_id = EXCLUDED.nf_id, nf_numero = EXCLUDED.nf_numero, zen_bruto = EXCLUDED.zen_bruto, atualizado_em = now()`,
                { ...u, zen_bruto: J(u.zen_bruto) });
        }
        for (const it of regs.itens) {
            await q(`INSERT INTO bmax_cheque_uso_item (pedido_id, item_id, produto_codigo, produto_descricao, tabela_bmax_modelo, unidade, quantidade, valor_unitario, custo_unitario, custo_total, valor_bruto_produto, desconto, valor_produto,
                       outros_valores, valor_operacao, imposto_incluso, imposto_fora, valor_total, valor_efetivo, operacao_tributaria)
                     VALUES (:pedido_id, :item_id, :produto_codigo, :produto_descricao, :tabela_bmax_modelo, :unidade, :quantidade, :valor_unitario, :custo_unitario, :custo_total, :valor_bruto_produto, :desconto, :valor_produto,
                       CAST(:outros_valores AS jsonb), :valor_operacao, :imposto_incluso, :imposto_fora, :valor_total, :valor_efetivo, :operacao_tributaria)
                     ON CONFLICT (pedido_id, item_id) DO UPDATE SET produto_codigo = EXCLUDED.produto_codigo, produto_descricao = EXCLUDED.produto_descricao, tabela_bmax_modelo = EXCLUDED.tabela_bmax_modelo, unidade = EXCLUDED.unidade,
                       quantidade = EXCLUDED.quantidade, valor_unitario = EXCLUDED.valor_unitario, custo_unitario = EXCLUDED.custo_unitario, custo_total = EXCLUDED.custo_total, valor_bruto_produto = EXCLUDED.valor_bruto_produto,
                       desconto = EXCLUDED.desconto, valor_produto = EXCLUDED.valor_produto, outros_valores = EXCLUDED.outros_valores, valor_operacao = EXCLUDED.valor_operacao, imposto_incluso = EXCLUDED.imposto_incluso,
                       imposto_fora = EXCLUDED.imposto_fora, valor_total = EXCLUDED.valor_total, valor_efetivo = EXCLUDED.valor_efetivo, operacao_tributaria = EXCLUDED.operacao_tributaria, atualizado_em = now()`,
                { ...it, outros_valores: J(it.outros_valores) });
        }
    });
}

const K_TOPO = "pedidos_ultimo_id", K_CURSOR = "pedidos_cursor", K_ANDAMENTO = "pedidos_topo_em_andamento";
const SOBREPOSICAO_IDS = 250;       // ~1,5 dia de pedidos relidos a cada varredura completa: pega observação editada depois
const PRIMEIRA_VARREDURA_DIAS = 8;  // sem marco gravado, olha os últimos 8 dias
const ORCAMENTO_MS = 200000;        // a função tem 300 s; o resto é banco e itens

// ROBÔ cheques-zen: varre os pedidos novos do ZEN, acha os que citam código de cheque e guarda (cheque, pedido, itens). Incremental e RETOMÁVEL: o ZEN leva de 11 a 27 s por
// 100 pedidos; se o tempo acaba antes de chegar ao marco, grava o ponto de retomada (cursor) e a próxima rodada continua dali. Estado em bmax_zen_varredura:
//   topo = maior id já varrido por uma varredura COMPLETA; cursor = menor id alcançado numa varredura ainda INCOMPLETA; topo_em_andamento = maior id visto nessa varredura.
// deps: { sequelize, zen } (teste injeta falsos). Falha do ZEN lança erro (o monitor dos robôs avisa); nada é corrigido em lugar nenhum.
async function sincronizar(deps) {
    const { QueryTypes } = require("sequelize");
    const sequelize = deps.sequelize, zen = deps.zen, orcamento = deps.orcamentoMs || ORCAMENTO_MS;
    if (!zen.configurado()) throw new Error("ZEN_EMAIL/ZEN_SENHA não configurados");
    const cheques = await sequelize.query(`SELECT id, codigo_cheque, revenda, tipo_uso, valor, status, criado_em, aprovado_em, utilizado_em, expira_em FROM bmax_saques WHERE codigo_cheque IS NOT NULL`, { type: QueryTypes.SELECT });
    const est = {};
    for (const r of await sequelize.query(`SELECT chave, valor FROM bmax_zen_varredura`, { type: QueryTypes.SELECT })) est[r.chave] = Number(r.valor);
    const topo = est[K_TOPO] != null ? est[K_TOPO] : null, cursor = est[K_CURSOR] != null ? est[K_CURSOR] : null, andamento = est[K_ANDAMENTO] != null ? est[K_ANDAMENTO] : null;
    const desde = new Date(Date.now() - PRIMEIRA_VARREDURA_DIAS * 86400000).toISOString().slice(0, 10);
    const varr = await zen.pedidosRecentes({ startId: cursor, minId: topo != null ? topo - SOBREPOSICAO_IDS : null, desdeISO: topo == null ? desde : null, budgetMs: orcamento });
    const comCodigo = varr.pedidos.filter(p => extrairCodigos(p.observacao).length);
    const itensPorPedido = new Map();
    for (const p of comCodigo) itensPorPedido.set(String(p.pedido_id), await zen.itensDoPedido(p.pedido_id));
    let tabela = null; try { tabela = await zen.tabelaBmax(); } catch (e) { tabela = null; }
    const regs = prepararRegistros({ cheques, pedidos: comCodigo, itensPorPedido, tabela });
    await gravar(sequelize, regs);
    const set = (chave, valor) => sequelize.query(`INSERT INTO bmax_zen_varredura (chave, valor) VALUES (:c, :v) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`, { replacements: { c: chave, v: valor }, type: QueryTypes.INSERT });
    const del = chave => sequelize.query(`DELETE FROM bmax_zen_varredura WHERE chave = :c`, { replacements: { c: chave }, type: QueryTypes.DELETE });
    let novoTopo = topo;
    if (varr.completo) {
        const maior = Math.max(andamento != null ? andamento : 0, varr.maiorId != null ? varr.maiorId : 0, topo != null ? topo : 0);
        if (maior > 0) { await set(K_TOPO, maior); novoTopo = maior; }
        await del(K_CURSOR); await del(K_ANDAMENTO);
    } else if (varr.menorId != null) {
        await set(K_CURSOR, varr.menorId);
        if (andamento == null && varr.maiorId != null) await set(K_ANDAMENTO, varr.maiorId);
    }
    return { ok: true, completo: varr.completo, pedidosLidos: varr.pedidos.length, paginas: varr.paginas, pedidosComCodigo: comCodigo.length, usosGravados: regs.usos.length, itensGravados: regs.itens.length, topoAnterior: topo, novoTopo, cursor: varr.completo ? null : varr.menorId };
}

module.exports = { extrairCodigos, prepararRegistros, gravar, sincronizar };
