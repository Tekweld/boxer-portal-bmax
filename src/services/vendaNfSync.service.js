// GUARDA OS FATOS DA VENDA BMAX (Pipefy x ZEN) EM TABELAS, para o Portal e outros agentes (ex.: a visão de margem) lerem sem divergir.
// Regra do André (27/11/2026): NENHUM cálculo aqui. Só se guarda o que o Pipefy e o ZEN dizem, como vieram: cliente (CNPJ), card, nota,
// pedido, itens (produto, quantidade, preço, desconto, impostos), vendedor. O estado do vínculo card x nota vem da lógica do auditor
// (vendasZen.service.js). Quem chama é a checagem "vendas_zen" do auditor; falha aqui NUNCA derruba o auditor.
// DDL: scripts/sql/vendas-nf-27-11-2026.sql. Tabelas: bmax_cliente_zen, bmax_venda_vinculo, bmax_venda_nf, bmax_venda_card_nf, bmax_venda_nf_item.

const so = s => String(s || "").replace(/\D/g, "");
const dia = s => (s ? String(s).slice(0, 10) : null);

// Notas cujo detalhe (itens e pedido) ainda não foi guardado e que precisam ser lidas do ZEN.
function notasParaDetalhar(vinculos, jaTemItens) {
    const ids = new Map();
    for (const { res } of vinculos) for (const n of (res.usadas || [])) if (n.id != null && !jaTemItens.has(String(n.id))) ids.set(String(n.id), n);
    return [...ids.values()];
}

// Monta as linhas a gravar. Entradas:
//  vinculos: [{ card: {id, nome, cnpj, valor, fechadoEm}, res: {estado, usadas:[{id, numero, data, total, cab}]} }]
//  itensPorNf: Map nf_id -> itens (como zenNf.itensDaNota); pedidos: Map pedido_id -> pedido (zenNf.pedidoDeVenda); tabela: Map codigo -> modelo (Tabela BMax)
function prepararRegistros({ vinculos, itensPorNf = new Map(), pedidos = new Map(), tabela = null }) {
    const out = { vinculos: [], cardNf: [], nfs: [], itens: [], clientes: [] };
    const nfVistas = new Set(), cliVistos = new Set();
    for (const { card, res } of vinculos) {
        const usadas = res.usadas || [];
        out.vinculos.push({ card_id: String(card.id), cnpj: so(card.cnpj) || null, estado: res.estado, card_valor: card.valor != null ? Number(card.valor) : null, card_fechado_em: dia(card.fechadoEm),
            nf_ids: usadas.map(n => Number(n.id)).filter(Number.isFinite), nf_numeros: usadas.map(n => n.numero).join(" + ") || null });
        for (const n of usadas) {
            if (n.id == null) continue;
            out.cardNf.push({ card_id: String(card.id), nf_id: Number(n.id), estado: res.estado });
            if (nfVistas.has(n.id)) continue;
            nfVistas.add(n.id);
            const cab = n.cab || {}, ped = cab.pedido_id ? pedidos.get(String(cab.pedido_id)) : null;
            const cnpj = so(cab.cliente && cab.cliente.documento) || so(card.cnpj) || null;
            out.nfs.push({
                nf_id: Number(n.id), nf_numero: cab.numero != null ? String(cab.numero) : String(n.numero), nf_serie: cab.serie || null, data_emissao: cab.data_emissao || n.data || null, status: cab.status || null, devolvida: !!cab.devolvida,
                valor_total: cab.total != null ? cab.total : n.total, tags: cab.tags || null, chave_acesso: cab.chave_acesso || null, operacao_fiscal: cab.operacao_fiscal || null, tipo_frete: cab.tipo_frete || null,
                peso_bruto_kg: cab.peso_bruto_kg != null ? cab.peso_bruto_kg : null, peso_liquido_kg: cab.peso_liquido_kg != null ? cab.peso_liquido_kg : null, volume_m3: cab.volume_m3 != null ? cab.volume_m3 : null, volumes: cab.volumes != null ? cab.volumes : null,
                observacao: cab.observacao || null, cnpj, cliente_zen_id: cab.cliente ? cab.cliente.id : null, cliente_nome: cab.cliente ? cab.cliente.nome : null,
                vendedor_zen_id: cab.vendedor ? cab.vendedor.id : null, vendedor_nome: cab.vendedor ? cab.vendedor.nome : null, vendedor_categoria1: cab.vendedor ? cab.vendedor.categoria1 : null,
                comissao_vendedor_zen: cab.comissao_vendedor_zen != null ? cab.comissao_vendedor_zen : null,
                pedido_id: cab.pedido_id || null, pedido_status: ped ? ped.status : null, pedido_data: ped ? ped.data : null, pedido_valor_total: ped ? ped.total : null, pedido_custo_total: ped ? ped.custo_total : null,
                pedido_tags: ped ? ped.tags : null, pedido_observacao: ped ? ped.observacao : null, pedido_perfil: ped ? ped.perfil : null, pedido_forma_pagamento: ped ? ped.forma_pagamento : null, pedido_comissao_vendedor_zen: ped ? ped.comissao_vendedor_zen : null,
                zen_bruto: { nota: cab, pedido: ped || null },
                tem_detalhe: itensPorNf.has(String(n.id)) || !!ped,
            });
            const cli = cab.cliente;
            if (cnpj && cnpj.length === 14 && !cliVistos.has(cnpj)) {
                cliVistos.add(cnpj);
                out.clientes.push({ cnpj, nome_card: card.nome || null, zen_pessoa_id: cli ? cli.id : null, zen_nome: cli ? cli.nome : null, zen_fantasia: cli ? cli.fantasia : null, zen_tipo: cli ? cli.tipo : null,
                    zen_documento: cli ? cli.documento : null, zen_email: cli ? cli.email : null, zen_telefone: cli ? cli.telefone : null, zen_cep: cli ? cli.cep : null, zen_categoria1: cli ? cli.categoria1 : null, zen_bruto: cli || null });
            }
            for (const it of (itensPorNf.get(String(n.id)) || [])) {
                out.itens.push({ nf_id: Number(n.id), item_id: it.item_id, sequencia: it.sequencia, item_pedido: it.item_pedido, produto_codigo: it.codigo || null, produto_descricao: it.descricao || null, produto_id_zen: it.produto_id_zen,
                    perfil_produto: it.perfil_produto, perfil_produto_descricao: it.perfil_produto_descricao, tabela_bmax_modelo: tabela && tabela.get(it.codigo) ? tabela.get(it.codigo) : null,
                    unidade: it.unidade, quantidade: it.quantidade, quantidade_fisica: it.quantidade_fisica, peso_liquido_kg: it.peso_liquido_kg, peso_bruto_kg: it.peso_bruto_kg, valor_unitario: it.valor_unitario,
                    valor_bruto_produto: it.valor_bruto_produto, desconto: it.desconto, valor_produto: it.valor_produto, outros_valores: it.outros_valores || {}, valor_operacao: it.valor_operacao,
                    imposto_incluso: it.imposto_incluso, imposto_fora: it.imposto_fora, valor_total: it.valor_total, compensacao_imposto: it.compensacao_imposto, valor_efetivo: it.valor_efetivo,
                    tipo_contabil: it.tipo_contabil, operacao_tributaria: it.operacao_tributaria, descricao_calculada: it.descricao_calculada });
            }
        }
    }
    return out;
}

const J = v => (v == null ? null : JSON.stringify(v));

// Grava tudo numa transação (upsert). `sequelize` e `QueryTypes` são injetados (teste usa banco em memória ou falso).
async function gravar(sequelize, regs) {
    const { QueryTypes } = require("sequelize");
    await sequelize.transaction(async (transaction) => {
        const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.INSERT, transaction });
        for (const c of regs.clientes) {
            await q(`INSERT INTO bmax_cliente_zen (cnpj, nome_card, zen_pessoa_id, zen_nome, zen_fantasia, zen_tipo, zen_documento, zen_email, zen_telefone, zen_cep, zen_categoria1, zen_bruto)
                     VALUES (:cnpj, :nome_card, :zen_pessoa_id, :zen_nome, :zen_fantasia, :zen_tipo, :zen_documento, :zen_email, :zen_telefone, :zen_cep, :zen_categoria1, CAST(:zen_bruto AS jsonb))
                     ON CONFLICT (cnpj) DO UPDATE SET nome_card = EXCLUDED.nome_card, zen_pessoa_id = EXCLUDED.zen_pessoa_id, zen_nome = EXCLUDED.zen_nome, zen_fantasia = EXCLUDED.zen_fantasia, zen_tipo = EXCLUDED.zen_tipo,
                       zen_documento = EXCLUDED.zen_documento, zen_email = EXCLUDED.zen_email, zen_telefone = EXCLUDED.zen_telefone, zen_cep = EXCLUDED.zen_cep, zen_categoria1 = EXCLUDED.zen_categoria1, zen_bruto = EXCLUDED.zen_bruto, atualizado_em = now()`,
                { ...c, zen_bruto: J(c.zen_bruto) });
        }
        for (const n of regs.nfs) {
            await q(`INSERT INTO bmax_venda_nf (nf_id, nf_numero, nf_serie, data_emissao, status, devolvida, valor_total, tags, chave_acesso, operacao_fiscal, tipo_frete, peso_bruto_kg, peso_liquido_kg, volume_m3, volumes, observacao,
                       cnpj, cliente_zen_id, cliente_nome, vendedor_zen_id, vendedor_nome, vendedor_categoria1, comissao_vendedor_zen, pedido_id, pedido_status, pedido_data, pedido_valor_total, pedido_custo_total, pedido_tags,
                       pedido_forma_pagamento, pedido_comissao_vendedor_zen, pedido_observacao, pedido_perfil, zen_bruto)
                     VALUES (:nf_id, :nf_numero, :nf_serie, :data_emissao, :status, :devolvida, :valor_total, :tags, :chave_acesso, :operacao_fiscal, :tipo_frete, :peso_bruto_kg, :peso_liquido_kg, :volume_m3, :volumes, :observacao,
                       :cnpj, :cliente_zen_id, :cliente_nome, :vendedor_zen_id, :vendedor_nome, :vendedor_categoria1, :comissao_vendedor_zen, :pedido_id, :pedido_status, :pedido_data, :pedido_valor_total, :pedido_custo_total, :pedido_tags,
                       :pedido_forma_pagamento, :pedido_comissao_vendedor_zen, :pedido_observacao, :pedido_perfil, CAST(:zen_bruto AS jsonb))
                     ON CONFLICT (nf_id) DO UPDATE SET nf_numero = EXCLUDED.nf_numero, nf_serie = EXCLUDED.nf_serie, data_emissao = EXCLUDED.data_emissao, status = EXCLUDED.status, devolvida = EXCLUDED.devolvida, valor_total = EXCLUDED.valor_total,
                       tags = EXCLUDED.tags, chave_acesso = EXCLUDED.chave_acesso, operacao_fiscal = EXCLUDED.operacao_fiscal, tipo_frete = EXCLUDED.tipo_frete, peso_bruto_kg = EXCLUDED.peso_bruto_kg, peso_liquido_kg = EXCLUDED.peso_liquido_kg,
                       volume_m3 = EXCLUDED.volume_m3, volumes = EXCLUDED.volumes, observacao = EXCLUDED.observacao, cnpj = EXCLUDED.cnpj, cliente_zen_id = EXCLUDED.cliente_zen_id, cliente_nome = EXCLUDED.cliente_nome,
                       vendedor_zen_id = EXCLUDED.vendedor_zen_id, vendedor_nome = EXCLUDED.vendedor_nome, vendedor_categoria1 = EXCLUDED.vendedor_categoria1, comissao_vendedor_zen = EXCLUDED.comissao_vendedor_zen,
                       pedido_id = COALESCE(EXCLUDED.pedido_id, bmax_venda_nf.pedido_id),
                       pedido_status = COALESCE(EXCLUDED.pedido_status, bmax_venda_nf.pedido_status), pedido_data = COALESCE(EXCLUDED.pedido_data, bmax_venda_nf.pedido_data),
                       pedido_valor_total = COALESCE(EXCLUDED.pedido_valor_total, bmax_venda_nf.pedido_valor_total), pedido_custo_total = COALESCE(EXCLUDED.pedido_custo_total, bmax_venda_nf.pedido_custo_total),
                       pedido_tags = COALESCE(EXCLUDED.pedido_tags, bmax_venda_nf.pedido_tags), pedido_forma_pagamento = COALESCE(EXCLUDED.pedido_forma_pagamento, bmax_venda_nf.pedido_forma_pagamento),
                       pedido_comissao_vendedor_zen = COALESCE(EXCLUDED.pedido_comissao_vendedor_zen, bmax_venda_nf.pedido_comissao_vendedor_zen),
                       pedido_observacao = COALESCE(EXCLUDED.pedido_observacao, bmax_venda_nf.pedido_observacao), pedido_perfil = COALESCE(EXCLUDED.pedido_perfil, bmax_venda_nf.pedido_perfil),
                       zen_bruto = CASE WHEN EXCLUDED.zen_bruto->'pedido' IS NOT NULL AND EXCLUDED.zen_bruto->>'pedido' <> 'null' THEN EXCLUDED.zen_bruto ELSE bmax_venda_nf.zen_bruto END, atualizado_em = now()`,
                { ...n, zen_bruto: J(n.zen_bruto) });
        }
        for (const it of regs.itens) {
            await q(`INSERT INTO bmax_venda_nf_item (nf_id, item_id, sequencia, item_pedido, produto_codigo, produto_descricao, produto_id_zen, perfil_produto, perfil_produto_descricao, tabela_bmax_modelo, unidade, quantidade, quantidade_fisica,
                       peso_liquido_kg, peso_bruto_kg, valor_unitario, valor_bruto_produto, desconto, valor_produto, outros_valores, valor_operacao, imposto_incluso, imposto_fora, valor_total, compensacao_imposto, valor_efetivo,
                       tipo_contabil, operacao_tributaria, descricao_calculada)
                     VALUES (:nf_id, :item_id, :sequencia, :item_pedido, :produto_codigo, :produto_descricao, :produto_id_zen, :perfil_produto, :perfil_produto_descricao, :tabela_bmax_modelo, :unidade, :quantidade, :quantidade_fisica,
                       :peso_liquido_kg, :peso_bruto_kg, :valor_unitario, :valor_bruto_produto, :desconto, :valor_produto, CAST(:outros_valores AS jsonb), :valor_operacao, :imposto_incluso, :imposto_fora, :valor_total, :compensacao_imposto, :valor_efetivo,
                       :tipo_contabil, :operacao_tributaria, :descricao_calculada)
                     ON CONFLICT (nf_id, item_id) DO UPDATE SET sequencia = EXCLUDED.sequencia, item_pedido = EXCLUDED.item_pedido, produto_codigo = EXCLUDED.produto_codigo, produto_descricao = EXCLUDED.produto_descricao,
                       produto_id_zen = EXCLUDED.produto_id_zen, perfil_produto = EXCLUDED.perfil_produto, perfil_produto_descricao = EXCLUDED.perfil_produto_descricao, tabela_bmax_modelo = EXCLUDED.tabela_bmax_modelo, unidade = EXCLUDED.unidade,
                       quantidade = EXCLUDED.quantidade, quantidade_fisica = EXCLUDED.quantidade_fisica, peso_liquido_kg = EXCLUDED.peso_liquido_kg, peso_bruto_kg = EXCLUDED.peso_bruto_kg, valor_unitario = EXCLUDED.valor_unitario,
                       valor_bruto_produto = EXCLUDED.valor_bruto_produto, desconto = EXCLUDED.desconto, valor_produto = EXCLUDED.valor_produto, outros_valores = EXCLUDED.outros_valores, valor_operacao = EXCLUDED.valor_operacao,
                       imposto_incluso = EXCLUDED.imposto_incluso, imposto_fora = EXCLUDED.imposto_fora, valor_total = EXCLUDED.valor_total, compensacao_imposto = EXCLUDED.compensacao_imposto, valor_efetivo = EXCLUDED.valor_efetivo,
                       tipo_contabil = EXCLUDED.tipo_contabil, operacao_tributaria = EXCLUDED.operacao_tributaria, descricao_calculada = EXCLUDED.descricao_calculada, atualizado_em = now()`,
                { ...it, outros_valores: J(it.outros_valores) });
        }
        for (const v of regs.vinculos) {
            // o vínculo do card é reescrito por inteiro (notas ligadas podem mudar de uma rodada para outra)
            await q(`DELETE FROM bmax_venda_card_nf WHERE card_id = :card_id`, { card_id: v.card_id });
            await q(`INSERT INTO bmax_venda_vinculo (card_id, cnpj, estado, card_valor, card_fechado_em, nf_ids, nf_numeros)
                     VALUES (:card_id, :cnpj, :estado, :card_valor, :card_fechado_em, CAST(:nf_ids AS bigint[]), :nf_numeros)
                     ON CONFLICT (card_id) DO UPDATE SET cnpj = EXCLUDED.cnpj, estado = EXCLUDED.estado, card_valor = EXCLUDED.card_valor, card_fechado_em = EXCLUDED.card_fechado_em,
                       nf_ids = EXCLUDED.nf_ids, nf_numeros = EXCLUDED.nf_numeros, avaliado_em = now()`,
                { ...v, nf_ids: "{" + v.nf_ids.join(",") + "}" });
        }
        for (const l of regs.cardNf) await q(`INSERT INTO bmax_venda_card_nf (card_id, nf_id, estado) VALUES (:card_id, :nf_id, :estado) ON CONFLICT (card_id, nf_id) DO UPDATE SET estado = EXCLUDED.estado`, l);
    });
}

module.exports = { notasParaDetalhar, prepararRegistros, gravar };
