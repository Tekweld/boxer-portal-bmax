# SQL do Portal BMax (Postgres boxer-bmax, Supabase)

O projeto **não tem migration automática**: tabelas e views novas são criadas aplicando estes arquivos à mão, com autorização do André, depois de validar numa transação desfeita. Todos usam `IF NOT EXISTS`/`OR REPLACE` e têm o comando de reverter no fim. **Ao mudar uma tabela ou view, atualize o arquivo e esta lista.**

| Arquivo | O que cria | Aplicado em produção |
|---|---|---|
| `vendas-nf-27-11-2026.sql` | `bmax_cliente_zen`, `bmax_venda_vinculo`, `bmax_venda_card_nf`, `bmax_venda_nf`, `bmax_venda_nf_item`; views `vw_bmax_cards_venda`, `vw_bmax_vendas`, `vw_bmax_venda_itens` | 27/11/2026 |
| `vw-bmax-comissoes-27-11-2026.sql` | views `vw_bmax_comissao_lancamentos`, `vw_bmax_comissao_por_venda`, `vw_bmax_inconsistencias_margem`; papel `bmax_margem_leitura` (criado sem login por comando à parte) | 27/11/2026 |
| `cheques-uso-27-11-2026.sql` | colunas `pedido_observacao` e `pedido_perfil` em `bmax_venda_nf`; `bmax_zen_varredura`, `bmax_cheque_uso`, `bmax_cheque_uso_item`; views `vw_bmax_cheques`, `vw_bmax_cheque_itens`; recria `vw_bmax_inconsistencias_margem` com os 2 achados de cheque | 27/11/2026 |
| `despachante-27-11-2026.sql` | `bmax_robo_disparo` (reserva de rodadas do despachante dos robôs) | 27/11/2026 |
| `termos-fase1.sql` | tabelas dos Termos BPartner (projeto boxer-sistemas) | 06/11/2026 |

**Dados corrigidos junto (fora destes arquivos):** `bmax_rd_pipefy_map` recebeu 98 vínculos em 27/11/2026 (backup em `Documentação/Backups_Banco/bmax_rd_pipefy_map_ANTES_27-11-2026.json`). O papel `bmax_margem_leitura` tem `SELECT` nas 8 views de leitura e foi criado sem login.

**Onde cada coisa mora:** o razão, as tabelas de fatos, de cheque, do despachante e as views ficam no projeto **boxer-bmax**; a matriz de comissão (`comercial_bmax_config`) e a Tabela de Preços (`produtos`) ficam no **boxer-sistemas**. A pasta `supabase/` do repositório só guarda o vínculo do CLI (`.temp`); não há migrations nela.
