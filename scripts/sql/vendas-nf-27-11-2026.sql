-- VENDAS BMAX x NF DO ZEN: FATOS GUARDADOS (27/11/2026). NÃO APLICADO em produção até o André autorizar.
-- Banco: Postgres boxer-bmax. Só cria tabelas e views NOVAS (nada existente é alterado). Reversível (ver o fim).
-- Princípio: AQUI SÓ SE GUARDA O QUE ESTÁ NO PIPEFY E NO ZEN, COMO VEIO. Nenhum cálculo de margem, comissão ou imposto.
-- Quem preenche: o auditor diário (checagem "vendas_zen"), a cada rodada, de forma incremental (nota emitida já guardada não é relida).
-- Chaves: card = id numérico do Pipefy; nota = id interno da nota no ZEN (nf_id); cliente = CNPJ só com dígitos.

-- 1) Cliente BMax que também existe no ZEN (ligação pelo CNPJ)
CREATE TABLE IF NOT EXISTS bmax_cliente_zen (
  cnpj             text PRIMARY KEY,               -- 14 dígitos
  nome_card        text,                           -- nome no Pipefy (último visto)
  zen_pessoa_id    bigint,                         -- id da pessoa no ZEN
  zen_nome         text,
  zen_fantasia     text,
  zen_tipo         text,
  zen_documento    text,
  zen_email        text,
  zen_telefone     text,
  zen_cep          text,
  zen_categoria1   text,                           -- categoria do cadastro no ZEN, como veio
  zen_bruto        jsonb,
  primeira_vez     timestamptz NOT NULL DEFAULT now(),
  atualizado_em    timestamptz NOT NULL DEFAULT now()
);

-- 2) Um registro por card de venda: como o card se liga (ou não) ao ZEN. Estado vem da lógica do auditor (valor até 1%, soma de notas).
CREATE TABLE IF NOT EXISTS bmax_venda_vinculo (
  card_id          text PRIMARY KEY,               -- id do Pipefy
  cnpj             text,
  estado           text NOT NULL,                  -- ok | ok_soma | valor_diverge | sem_nota | sem_cnpj (card sem CNPJ válido)
  card_valor       numeric(14,2),                  -- valor do card no momento da avaliação
  card_fechado_em  date,
  nf_ids           bigint[] NOT NULL DEFAULT '{}', -- notas ligadas a este card
  nf_numeros       text,                           -- "152311 + 152312"
  avaliado_em      timestamptz NOT NULL DEFAULT now(),
  primeira_vez     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_bmax_venda_vinculo_cnpj ON bmax_venda_vinculo (cnpj);

-- 3) Nota fiscal de saída (cabeçalho) e dados do pedido de venda do ZEN. Valores como o ZEN devolve.
CREATE TABLE IF NOT EXISTS bmax_venda_nf (
  nf_id                   bigint PRIMARY KEY,      -- id da nota no ZEN
  nf_numero               text,
  nf_serie                text,
  data_emissao            date,
  status                  text,                    -- ex.: SHIPMENT, CANCELED
  devolvida               boolean,
  valor_total             numeric(14,2),           -- total da nota, como o ZEN
  tags                    text,
  chave_acesso            text,
  operacao_fiscal         text,
  tipo_frete              text,                    -- ISSUER etc. (o ZEN não devolve valor de frete separado nos campos lidos)
  peso_bruto_kg           numeric(14,3),
  peso_liquido_kg         numeric(14,3),
  volume_m3               numeric(14,3),
  volumes                 integer,
  observacao              text,
  cnpj                    text,                    -- do cliente da nota
  cliente_zen_id          bigint,
  cliente_nome            text,
  vendedor_zen_id         bigint,
  vendedor_nome           text,
  vendedor_categoria1     text,                    -- canal: Industria / Varejo / Representante / vazio
  comissao_vendedor_zen   numeric(8,4),            -- "salesCommission" da nota (campo do ZEN; NÃO é a comissão do Portal)
  pedido_id               text,                    -- saleId
  pedido_status           text,
  pedido_data             date,
  pedido_valor_total      numeric(14,2),
  pedido_custo_total      numeric(14,2),           -- "costTotalValue" como o ZEN devolve (vem 0 em vários pedidos: conferir antes de usar)
  pedido_tags             text,
  pedido_forma_pagamento  text,
  pedido_comissao_vendedor_zen numeric(8,4),
  zen_bruto               jsonb,                   -- cabeçalho e pedido resumidos, sem dados de empresa
  primeira_vez            timestamptz NOT NULL DEFAULT now(),
  atualizado_em           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_bmax_venda_nf_cnpj   ON bmax_venda_nf (cnpj);
CREATE INDEX IF NOT EXISTS ix_bmax_venda_nf_pedido ON bmax_venda_nf (pedido_id);
CREATE INDEX IF NOT EXISTS ix_bmax_venda_nf_data   ON bmax_venda_nf (data_emissao);

-- 4) Ligação card x nota (uma venda pode ter várias notas; a mesma nota liga a um card só)
CREATE TABLE IF NOT EXISTS bmax_venda_card_nf (
  card_id   text   NOT NULL,
  nf_id     bigint NOT NULL,
  estado    text   NOT NULL,                       -- o estado do vínculo do card (ok | ok_soma | valor_diverge)
  PRIMARY KEY (card_id, nf_id)
);
CREATE INDEX IF NOT EXISTS ix_bmax_venda_card_nf_nf ON bmax_venda_card_nf (nf_id);

-- 5) Itens da nota: produto, quantidade, preço, desconto e impostos, como o ZEN devolve
CREATE TABLE IF NOT EXISTS bmax_venda_nf_item (
  nf_id                   bigint NOT NULL,
  item_id                 bigint NOT NULL,         -- id do item no ZEN
  sequencia               integer,
  item_pedido             text,
  produto_codigo          text,                    -- = produtos.codigo da Tabela de Preços BMax (boxer-sistemas) quando é produto de tabela
  produto_descricao       text,
  produto_id_zen          bigint,
  perfil_produto          text,                    -- ex.: MAQ
  perfil_produto_descricao text,
  tabela_bmax_modelo      text,                    -- modelo na Tabela de Preços BMax, quando o código existe lá (NULL = fora da tabela)
  unidade                 text,
  quantidade              numeric(14,4),
  quantidade_fisica       numeric(14,4),
  peso_liquido_kg         numeric(14,3),
  peso_bruto_kg           numeric(14,3),
  valor_unitario          numeric(14,4),
  valor_bruto_produto     numeric(14,2),
  desconto                numeric(14,2),
  valor_produto           numeric(14,2),
  outros_valores          jsonb,                   -- frete, seguro, despesas, se o ZEN preencher (vazio nas notas vistas)
  valor_operacao          numeric(14,2),
  imposto_incluso         numeric(14,2),           -- "insideTaxValue"
  imposto_fora            numeric(14,2),           -- "outsideTaxValue"
  valor_total             numeric(14,2),
  compensacao_imposto     numeric(14,2),
  valor_efetivo           numeric(14,2),
  tipo_contabil           text,
  operacao_tributaria     text,
  descricao_calculada     text,
  atualizado_em           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (nf_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_bmax_venda_nf_item_produto ON bmax_venda_nf_item (produto_codigo);

-- ─── VIEWS ───────────────────────────────────────────────────────────────────────────────────────────

-- A) Cards do Pipefy em colunas (lidos do cache do Portal; o cache pode ter minutos de atraso). Nada é calculado; só se abre o JSON.
CREATE OR REPLACE VIEW vw_bmax_cards_venda AS
WITH c AS (
  SELECT card_id, card, atualizado_em AS cache_atualizado_em FROM bmax_pipefy_cache_cards WHERE pipe = 'CRM BOXER SOLDAS'
)
SELECT
  c.card_id                                                                   AS card_pipefy_id,
  NULLIF(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "id_no_rd").value') #>> '{}', '')            AS card_rd_id_antigo,
  c.card->>'title'                                                            AS titulo,
  c.card->'current_phase'->>'name'                                            AS fase,
  c.card->'current_phase'->>'id'                                              AS fase_id,
  ARRAY(SELECT l->>'name' FROM jsonb_array_elements(COALESCE(c.card->'labels','[]'::jsonb)) l)                    AS etiquetas,
  (c.card->>'created_at')::timestamptz                                        AS criado_em,
  (c.card->>'updated_at')::timestamptz                                        AS atualizado_em,
  NULLIF(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "data_de_fechamento").value') #>> '{}', '')  AS data_fechamento_texto,
  CASE WHEN (jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "data_de_fechamento").value') #>> '{}') ~ '^\d{2}/\d{2}/\d{4}$'
       THEN to_date(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "data_de_fechamento").value') #>> '{}', 'DD/MM/YYYY') END AS data_fechamento,
  regexp_replace(COALESCE(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "cnpj").value') #>> '{}', ''), '\D', '', 'g')               AS cnpj,
  NULLIF(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "nome_fantasia").value') #>> '{}', '')       AS nome_fantasia,
  NULLIF(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "empresa").value') #>> '{}', '')             AS empresa,
  NULLIF(btrim(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "respons_vel").value') #>> '{}', '[]" '), '')  AS responsavel,
  NULLIF(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "representante").value') #>> '{}', '')       AS representante,
  NULLIF(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "revenda_loja").value') #>> '{}', '')         AS revenda_loja,
  NULLIF(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "perfil_pci").value') #>> '{}', '')           AS perfil_pci,
  NULLIF(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "classe_de_pre_o").value') #>> '{}', '')     AS classe_preco,
  NULLIF(btrim(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "m_quina_de_interesse").value') #>> '{}', '[]" '), '') AS maquina_interesse,
  NULLIF(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "segmento_de_produto").value') #>> '{}', '')  AS segmento_produto,
  NULLIF(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "produtos").value') #>> '{}', '')             AS produtos_texto,
  NULLIF(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "valor_total").value') #>> '{}', '')          AS valor_total_texto,
  CASE WHEN (jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "valor_total").value') #>> '{}') ~ '^[0-9.]+,[0-9]{2}$|^[0-9]+$'
       THEN replace(replace(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "valor_total").value') #>> '{}', '.', ''), ',', '.')::numeric END AS valor_total,
  NULLIF(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "estado").value') #>> '{}', '')               AS estado_uf,
  NULLIF(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "cidade").value') #>> '{}', '')               AS cidade,
  NULLIF(jsonb_path_query_first(c.card, '$.fields[*] ? (@.field.id == "fonte").value') #>> '{}', '')                AS fonte,
  c.cache_atualizado_em
FROM c;

-- B) Cada item vendido, com a nota, o pedido, o cliente, o vendedor e o card ligado. Sem nenhuma conta.
CREATE OR REPLACE VIEW vw_bmax_venda_itens AS
SELECT
  vc.card_id                               AS card_pipefy_id,
  v.estado                                 AS estado_vinculo,        -- ok | ok_soma | valor_diverge | sem_nota | sem_cnpj
  k.titulo, k.fase, k.etiquetas, k.data_fechamento, k.valor_total AS card_valor_total,
  k.responsavel, k.representante, k.revenda_loja, k.perfil_pci, k.classe_preco, k.maquina_interesse, k.segmento_produto,
  n.cnpj, c.zen_nome AS cliente_zen_nome, c.nome_card AS cliente_card_nome,
  n.nf_id, n.nf_numero, n.nf_serie, n.data_emissao, n.status AS nf_status, n.devolvida AS nf_devolvida, n.valor_total AS nf_valor_total, n.chave_acesso,
  n.tipo_frete, n.operacao_fiscal, n.vendedor_nome AS nf_vendedor, n.vendedor_categoria1 AS nf_vendedor_canal, n.comissao_vendedor_zen,
  n.pedido_id, n.pedido_valor_total, n.pedido_custo_total, n.pedido_forma_pagamento,
  i.item_id, i.sequencia, i.produto_codigo, i.produto_descricao, i.perfil_produto, i.tabela_bmax_modelo,
  i.unidade, i.quantidade, i.valor_unitario, i.valor_bruto_produto, i.desconto, i.valor_produto, i.outros_valores,
  i.valor_operacao, i.imposto_incluso, i.imposto_fora, i.valor_total AS item_valor_total, i.compensacao_imposto, i.valor_efetivo, i.operacao_tributaria
FROM bmax_venda_card_nf vc
JOIN bmax_venda_vinculo v ON v.card_id = vc.card_id
JOIN bmax_venda_nf n      ON n.nf_id = vc.nf_id
LEFT JOIN bmax_venda_nf_item i ON i.nf_id = n.nf_id
LEFT JOIN bmax_cliente_zen c   ON c.cnpj = n.cnpj
LEFT JOIN vw_bmax_cards_venda k ON k.card_pipefy_id = vc.card_id;

-- C) Uma linha por venda (card): o card, o vínculo e as notas, para juntar com a comissão (vw_bmax_comissao_por_venda) pelo card_pipefy_id
CREATE OR REPLACE VIEW vw_bmax_vendas AS
SELECT
  v.card_id AS card_pipefy_id, v.estado AS estado_vinculo, v.cnpj, v.card_valor, v.card_fechado_em, v.nf_numeros, v.nf_ids, v.avaliado_em,
  k.titulo, k.fase, k.etiquetas, k.responsavel, k.representante, k.revenda_loja, k.perfil_pci, k.classe_preco, k.maquina_interesse, k.segmento_produto,
  c.zen_nome AS cliente_zen_nome, c.zen_pessoa_id AS cliente_zen_id
FROM bmax_venda_vinculo v
LEFT JOIN vw_bmax_cards_venda k ON k.card_pipefy_id = v.card_id
LEFT JOIN bmax_cliente_zen c    ON c.cnpj = v.cnpj;

-- ─── Acesso de leitura (APLICAR SÓ COM AUTORIZAÇÃO) ───
-- GRANT SELECT ON vw_bmax_cards_venda, vw_bmax_venda_itens, vw_bmax_vendas TO bmax_margem_leitura;

-- Reverter:
-- DROP VIEW IF EXISTS vw_bmax_vendas, vw_bmax_venda_itens, vw_bmax_cards_venda;
-- DROP TABLE IF EXISTS bmax_venda_nf_item, bmax_venda_card_nf, bmax_venda_nf, bmax_venda_vinculo, bmax_cliente_zen;
