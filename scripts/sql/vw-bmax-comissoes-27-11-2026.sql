-- VIEWS DE LEITURA DAS COMISSÕES BMAX (para a visão de margem de contribuição). Preparado em 27/11/2026. NÃO APLICADO em produção até o André autorizar.
-- Banco: Postgres boxer-bmax. Só cria views (nenhuma tabela é alterada). Reversível: DROP VIEW (ver o fim do arquivo).
-- Fonte de verdade = razão (bmax_transacoes). As views NÃO recalculam percentual: só organizam o que já foi lançado.

-- 1) Um lançamento por linha, já classificado e com o card normalizado para o id do Pipefy.
CREATE OR REPLACE VIEW vw_bmax_comissao_lancamentos AS
WITH base AS (
  SELECT t.*,
         -- crédito original apontado pelo texto "Expirado: credito <uuid>"
         NULLIF(substring(t.descricao FROM 'Expirado: credito ([0-9a-fA-F-]{36})'), '')::uuid AS credito_expirado_id
    FROM bmax_transacoes t
)
SELECT
  b.id                                                           AS lancamento_id,
  b.tipo,                                                        -- credito | debito
  CASE
    WHEN b.tipo = 'credito'                  THEN 'credito'      -- inclui os créditos do robô, cuja descrição começa com "Ajuste comissão" ou "Venda"
    WHEN b.descricao LIKE 'Ajuste comissão%' THEN 'debito_ajuste'
    WHEN b.descricao LIKE 'Expirado:%'       THEN 'debito_expiracao'
    WHEN b.descricao LIKE 'Saque %'          THEN 'debito_saque'
    WHEN b.descricao LIKE 'Estorno%'         THEN 'debito_estorno'   -- correção manual de crédito indevido (ex.: R$ 587,48 em "Sem Revenda")
    ELSE 'debito_outro'
  END                                                            AS classe_lancamento,
  b.tipo_agente,                                                 -- revenda | representante | vendedor_interno
  b.revenda                                                      AS carteira,
  b.revenda_id, b.grupo_id, b.representante_id,
  COALESCE(g.grupo, b.revenda)                                   AS grupo_ou_carteira,
  -- card normalizado: id do Pipefy (numérico). Lançamento antigo traz o id do RD (hex) e é convertido pelo mapa.
  COALESCE(m.pipefy_card_id, orig_m.pipefy_card_id, b.lead_id, orig.lead_id) AS card_pipefy_id,
  COALESCE(m.rd_deal_id, orig_m.rd_deal_id)                      AS card_rd_id,
  CASE WHEN COALESCE(m.pipefy_card_id, orig_m.pipefy_card_id, b.lead_id, orig.lead_id) ~ '^[0-9]+$'
       THEN 'pipefy' ELSE 'rd_sem_mapa' END                      AS card_id_tipo,   -- rd_sem_mapa = id antigo do RD sem vínculo no mapa
  b.valor,
  -- efeito no CUSTO de comissão: + crédito, − ajuste para baixo e − expiração; saque é caixa (0)
  CASE
    WHEN b.tipo = 'credito'                  THEN  b.valor
    WHEN b.descricao LIKE 'Ajuste comissão%' THEN -b.valor
    WHEN b.descricao LIKE 'Expirado:%'       THEN -b.valor
    WHEN b.descricao LIKE 'Estorno%'         THEN -b.valor
    ELSE 0
  END                                                            AS efeito_custo,
  -- efeito no CAIXA: crédito não é caixa; só o saque (uso do crédito) é
  CASE WHEN b.descricao LIKE 'Saque %' THEN b.valor ELSE 0 END   AS efeito_caixa_saque,
  b.pci, b.classe_preco, b.comissao_pct,
  b.descricao,
  b.expira_em,
  (b.criado_em AT TIME ZONE 'America/Sao_Paulo')                 AS lancado_em_brt,
  b.criado_em                                                    AS lancado_em_utc
FROM base b
LEFT JOIN bmax_rd_pipefy_map m      ON m.rd_deal_id = b.lead_id
LEFT JOIN bmax_transacoes orig      ON orig.id = b.credito_expirado_id
LEFT JOIN bmax_rd_pipefy_map orig_m ON orig_m.rd_deal_id = orig.lead_id
LEFT JOIN LATERAL (SELECT x.grupo FROM bmax_grupos x WHERE x.revenda_rd = b.revenda OR x.grupo = b.revenda ORDER BY x.id LIMIT 1) g ON true;

-- 2) Comissão por venda (card) e agente: o número que a margem deve usar.
CREATE OR REPLACE VIEW vw_bmax_comissao_por_venda AS
SELECT
  l.card_pipefy_id,
  MAX(l.card_rd_id)                                  AS card_rd_id,
  MAX(l.card_id_tipo)                                AS card_id_tipo,
  l.tipo_agente,
  MAX(l.grupo_ou_carteira)                           AS grupo_ou_carteira,
  MAX(l.carteira)                                    AS carteira,
  MAX(l.pci)                                         AS pci,
  MAX(l.classe_preco)                                AS classe_preco,
  MAX(l.comissao_pct)                                AS comissao_pct_ultimo,
  SUM(l.valor) FILTER (WHERE l.classe_lancamento = 'credito')           AS creditos,
  SUM(l.valor) FILTER (WHERE l.classe_lancamento = 'debito_ajuste')     AS ajustes_para_baixo,
  SUM(l.valor) FILTER (WHERE l.classe_lancamento = 'debito_expiracao')  AS expirado,
  SUM(l.efeito_custo)                                AS comissao_liquida,          -- custo reconhecido (créditos − ajustes − expiração)
  SUM(l.efeito_custo) FILTER (WHERE l.classe_lancamento <> 'debito_expiracao') AS comissao_liquida_sem_expiracao,
  COUNT(*)                                           AS lancamentos,
  MIN(l.lancado_em_brt)                              AS primeiro_lancamento_brt,
  MAX(l.lancado_em_brt)                              AS ultimo_lancamento_brt,
  (SELECT c.card->>'title' FROM bmax_pipefy_cache_cards c WHERE c.card_id = l.card_pipefy_id LIMIT 1) AS cliente
FROM vw_bmax_comissao_lancamentos l
WHERE l.card_pipefy_id IS NOT NULL AND l.classe_lancamento <> 'debito_saque'
GROUP BY l.card_pipefy_id, l.tipo_agente;

-- 3) Inconsistências abertas que podem afetar a margem (achados do auditor diário que ainda não foram resolvidos).
CREATE OR REPLACE VIEW vw_bmax_inconsistencias_margem AS
SELECT
  a.checagem,
  CASE a.checagem
    WHEN 'venda_sem_nota_zen'  THEN 'Venda do CRM sem nota no ZEN (receita não comprovada)'
    WHEN 'venda_valor_zen'     THEN 'Valor do card diferente da nota em mais de 1% (base da comissão errada)'
    WHEN 'cheque_usado_sem_baixa' THEN 'Cheque de cashback usado no ZEN mas não marcado como utilizado no Portal'
    WHEN 'cheque_codigo_desconhecido' THEN 'Pedido do ZEN cita código de cheque que não existe no Portal'
    WHEN 'venda_sem_cnpj_zen'  THEN 'Venda sem CNPJ válido no card (não se liga ao ZEN)'
    WHEN 'venda_produto_zen'   THEN 'Produto do card diferente do vendido na nota (PCI/segmento podem estar errados)'
    WHEN 'venda_sem_dados'     THEN 'Venda sem PCI/classe (comissão não creditada)'
    WHEN 'mudanca_campos'      THEN 'PCI/produto/classe mudou depois do cálculo (comissão pode estar desatualizada)'
    WHEN 'pci_x_produto'       THEN 'PCI não combina com o produto'
    WHEN 'pci12_responsavel'   THEN 'PCI12 com responsável/estado errado (quem recebe comissão pode estar errado)'
    WHEN 'saldo_vs_razao'      THEN 'Saldo diferente do razão'
    WHEN 'creditos_anormais'   THEN 'Créditos anormais nas últimas 24h (possível duplicidade)'
    ELSE a.checagem
  END                                              AS o_que_significa,
  a.severidade, a.titulo, a.acao_sugerida,
  COALESCE(a.detalhe->>'card', a.detalhe->>'pedido')   AS card_pipefy_id,
  a.detalhe->>'nome'                               AS cliente,
  a.detalhe->>'responsavel'                        AS responsavel,
  NULLIF(a.detalhe->>'valorCard','')::numeric      AS valor_card,
  NULLIF(a.detalhe->>'notaTotal','')::numeric      AS valor_nota_zen,
  a.detalhe->>'nota'                               AS nota_zen,
  a.link, a.primeira_vez, a.ultima_vez
FROM bmax_auditoria_achados a
WHERE a.resolvido_em IS NULL
  AND a.checagem IN ('venda_sem_nota_zen','venda_valor_zen','venda_produto_zen','venda_sem_cnpj_zen','cheque_usado_sem_baixa','cheque_codigo_desconhecido','venda_sem_dados','mudanca_campos','pci_x_produto','pci12_responsavel','saldo_vs_razao','creditos_anormais');

-- ─── Acesso somente leitura para o outro Claude (APLICAR SÓ COM AUTORIZAÇÃO; defina a senha fora do chat e guarde no cofre) ───
-- CREATE ROLE bmax_margem_leitura LOGIN PASSWORD '<definir-fora-do-chat>';
-- GRANT USAGE ON SCHEMA public TO bmax_margem_leitura;
-- GRANT SELECT ON vw_bmax_comissao_lancamentos, vw_bmax_comissao_por_venda, vw_bmax_inconsistencias_margem TO bmax_margem_leitura;
-- (as views rodam com o dono; o papel NÃO precisa de acesso às tabelas bmax_*)

-- Reverter:
-- DROP VIEW IF EXISTS vw_bmax_inconsistencias_margem, vw_bmax_comissao_por_venda, vw_bmax_comissao_lancamentos;
