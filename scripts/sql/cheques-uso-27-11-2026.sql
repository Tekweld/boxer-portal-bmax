-- USO DO CASHBACK (CHEQUE) x PEDIDO DO ZEN (27/11/2026). NÃO APLICADO em produção até o André autorizar.
-- Regra do André: o USO da comissão da revenda é o saque que gera o cheque (bmax_saques.codigo_cheque, ex.: BMAX-2026-31405). O PEDIDO do ZEN que aplica o
-- cheque cita o código na observação. O custo do uso entra na margem do PEDIDO QUE APLICOU O CHEQUE (decisão do André, 27/11/2026).
-- Só se GUARDA o que o ZEN diz, como veio; nenhum cálculo. Preenchido pelo auditor (checagem "cheques_zen"). Só cria/estende estruturas NOVAS. Reversível.

ALTER TABLE bmax_venda_nf ADD COLUMN IF NOT EXISTS pedido_observacao text;
ALTER TABLE bmax_venda_nf ADD COLUMN IF NOT EXISTS pedido_perfil text;     -- perfil de venda do ZEN (ex.: BRINDE)

-- Marca da varredura incremental dos pedidos do ZEN (o ZEN não filtra pela observação e cada página de 100 pedidos leva ~11 s)
CREATE TABLE IF NOT EXISTS bmax_zen_varredura (
  chave          text PRIMARY KEY,
  valor          bigint NOT NULL,
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);

-- Um registro por (código citado, pedido). codigo_existe = false quando o pedido cita um código que não existe em bmax_saques.
CREATE TABLE IF NOT EXISTS bmax_cheque_uso (
  codigo_cheque            text    NOT NULL,
  pedido_id                text    NOT NULL,                -- id do pedido no ZEN (saleId)
  codigo_existe            boolean NOT NULL,
  saque_id                 uuid,
  revenda                  text,
  tipo_uso                 text,                            -- bonificacao | desconto
  valor_cheque             numeric(14,2),
  cheque_status            text,
  cheque_criado_em         timestamptz,
  cheque_expira_em         timestamptz,
  cheque_utilizado_em      timestamptz,                     -- o que o Portal tem hoje (vazio = ninguém marcou o uso)
  pedido_data              date,
  pedido_status            text,                            -- PICKING, FINISHED...
  pedido_perfil            text,                            -- perfil de venda do ZEN como veio: bonificação = Brinde OU Bonificação; desconto = pedido de venda comum
  pedido_perfil_descricao  text,
  pedido_operacao_fiscal   text,                            -- ex.: Saída de brinde
  pedido_total             numeric(14,2),
  pedido_custo_total       numeric(14,2),
  pedido_forma_pagamento   text,
  pedido_tags              text,
  pedido_tipo_frete        text,
  pedido_observacao        text,                            -- texto livre completo (o valor usado vem escrito aqui)
  cliente_cnpj             text,
  cliente_zen_id           bigint,
  cliente_nome             text,
  vendedor_zen_id          bigint,
  vendedor_nome            text,
  nf_id                    bigint,                          -- vazio enquanto o pedido ainda não foi faturado
  nf_numero                text,
  zen_bruto                jsonb,
  primeira_vez             timestamptz NOT NULL DEFAULT now(),
  atualizado_em            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (codigo_cheque, pedido_id)
);
CREATE INDEX IF NOT EXISTS ix_bmax_cheque_uso_pedido ON bmax_cheque_uso (pedido_id);

-- Itens do pedido que aplicou o cheque (existem mesmo antes da nota): produto, quantidade, preço, custo, impostos, operação tributária
CREATE TABLE IF NOT EXISTS bmax_cheque_uso_item (
  pedido_id            text   NOT NULL,
  item_id              bigint NOT NULL,
  produto_codigo       text,
  produto_descricao    text,
  tabela_bmax_modelo   text,
  unidade              text,
  quantidade           numeric(14,4),
  valor_unitario       numeric(14,4),
  custo_unitario       numeric(14,4),
  custo_total          numeric(14,2),                       -- "costTotalValue" do ZEN (0 quando não apurado)
  valor_bruto_produto  numeric(14,2),
  desconto             numeric(14,2),
  valor_produto        numeric(14,2),
  outros_valores       jsonb,
  valor_operacao       numeric(14,2),
  imposto_incluso      numeric(14,2),
  imposto_fora         numeric(14,2),
  valor_total          numeric(14,2),
  valor_efetivo        numeric(14,2),
  operacao_tributaria  text,
  atualizado_em        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pedido_id, item_id)
);

-- Todos os cheques do Portal, com o pedido do ZEN que os aplicou (se houver), e os códigos citados no ZEN que não existem no Portal.
CREATE OR REPLACE VIEW vw_bmax_cheques AS
SELECT
  COALESCE(s.codigo_cheque, u.codigo_cheque)  AS codigo_cheque,
  (s.id IS NOT NULL)                          AS existe_no_portal,
  s.revenda, s.tipo_uso, s.valor AS valor_cheque, s.status AS status_cheque,
  s.criado_em AS cheque_criado_em, s.aprovado_em AS cheque_aprovado_em, s.utilizado_em AS cheque_utilizado_em_portal, s.expira_em AS cheque_expira_em,
  (u.pedido_id IS NOT NULL)                   AS citado_no_zen,
  u.pedido_id, u.pedido_data, u.pedido_status, u.pedido_perfil, u.pedido_perfil_descricao, u.pedido_operacao_fiscal,
  u.pedido_total, u.pedido_custo_total, u.pedido_forma_pagamento, u.pedido_observacao,
  u.cliente_cnpj, u.cliente_nome, u.vendedor_nome, u.nf_id, u.nf_numero, u.atualizado_em AS zen_lido_em
FROM bmax_saques s
FULL JOIN bmax_cheque_uso u ON u.codigo_cheque = s.codigo_cheque
WHERE s.codigo_cheque IS NOT NULL OR u.codigo_cheque IS NOT NULL;

-- Itens do pedido que aplicou cada cheque: a base para a MARGEM DO PEDIDO DO CHEQUE (custo do uso entra aqui)
CREATE OR REPLACE VIEW vw_bmax_cheque_itens AS
SELECT
  u.codigo_cheque, u.pedido_id, u.pedido_data, u.pedido_status, u.pedido_perfil, u.pedido_operacao_fiscal, u.cliente_cnpj, u.cliente_nome, u.valor_cheque, u.tipo_uso, u.nf_numero,
  i.item_id, i.produto_codigo, i.produto_descricao, i.tabela_bmax_modelo, i.unidade, i.quantidade, i.valor_unitario, i.custo_unitario, i.custo_total,
  i.valor_bruto_produto, i.desconto, i.valor_produto, i.outros_valores, i.valor_operacao, i.imposto_incluso, i.imposto_fora, i.valor_total AS item_valor_total, i.valor_efetivo, i.operacao_tributaria
FROM bmax_cheque_uso u
JOIN bmax_cheque_uso_item i ON i.pedido_id = u.pedido_id;

-- A view de inconsistências passa a incluir os 2 achados novos
CREATE OR REPLACE VIEW vw_bmax_inconsistencias_margem AS
SELECT
  a.checagem,
  CASE a.checagem
    WHEN 'venda_sem_nota_zen'       THEN 'Venda do CRM sem nota no ZEN (receita não comprovada)'
    WHEN 'venda_valor_zen'          THEN 'Valor do card diferente da nota em mais de 1% (base da comissão errada)'
    WHEN 'venda_sem_cnpj_zen'       THEN 'Venda sem CNPJ válido no card (não se liga ao ZEN)'
    WHEN 'venda_produto_zen'        THEN 'Produto do card diferente do vendido na nota (PCI/segmento podem estar errados)'
    WHEN 'cheque_usado_sem_baixa'   THEN 'Cheque de cashback usado em pedido do ZEN mas não marcado como utilizado no Portal'
    WHEN 'cheque_codigo_desconhecido' THEN 'Pedido do ZEN cita código de cheque que não existe no Portal'
    WHEN 'venda_sem_dados'          THEN 'Venda sem PCI/classe (comissão não creditada)'
    WHEN 'mudanca_campos'           THEN 'PCI/produto/classe mudou depois do cálculo (comissão pode estar desatualizada)'
    WHEN 'pci_x_produto'            THEN 'PCI não combina com o produto'
    WHEN 'pci12_responsavel'        THEN 'PCI12 com responsável/estado errado (quem recebe comissão pode estar errado)'
    WHEN 'saldo_vs_razao'           THEN 'Saldo diferente do razão'
    WHEN 'creditos_anormais'        THEN 'Créditos anormais nas últimas 24h (possível duplicidade)'
    ELSE a.checagem
  END                                              AS o_que_significa,
  a.severidade, a.titulo, a.acao_sugerida,
  COALESCE(a.detalhe->>'card', a.detalhe->>'pedido') AS card_pipefy_id,
  a.detalhe->>'nome'                               AS cliente,
  a.detalhe->>'responsavel'                        AS responsavel,
  NULLIF(a.detalhe->>'valorCard','')::numeric      AS valor_card,
  NULLIF(a.detalhe->>'notaTotal','')::numeric      AS valor_nota_zen,
  a.detalhe->>'nota'                               AS nota_zen,
  a.link, a.primeira_vez, a.ultima_vez
FROM bmax_auditoria_achados a
WHERE a.resolvido_em IS NULL
  AND a.checagem IN ('venda_sem_nota_zen','venda_valor_zen','venda_produto_zen','venda_sem_cnpj_zen','cheque_usado_sem_baixa','cheque_codigo_desconhecido','venda_sem_dados','mudanca_campos','pci_x_produto','pci12_responsavel','saldo_vs_razao','creditos_anormais');

-- GRANT SELECT ON vw_bmax_cheques, vw_bmax_cheque_itens TO bmax_margem_leitura;   -- (o papel já existe)
-- Reverter: DROP VIEW IF EXISTS vw_bmax_cheque_itens, vw_bmax_cheques; DROP TABLE IF EXISTS bmax_cheque_uso_item, bmax_cheque_uso, bmax_zen_varredura;
--           (a view vw_bmax_inconsistencias_margem volta ao texto de scripts/sql/vw-bmax-comissoes-27-11-2026.sql; as colunas novas de bmax_venda_nf podem ficar)
