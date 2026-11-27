---
name: project-bmax-margem-fatos-2026-11-27
description: Visão de margem de contribuição (27/11/2026): tabelas e views de fatos da venda Pipefy x ZEN, comissão por venda, cheques de cashback x pedido do ZEN, auditor, regras de reconhecimento e pagamento. Resumo do que foi construído e onde está.
metadata:
  type: project
---

# Margem de contribuição: fatos da venda, comissão e cheques (27/11/2026)

**Pedido do André:** outro Claude (de outra pessoa da empresa) monta a visão de margem de contribuição. O Portal deve **só guardar e deixar fácil de ler** o que o Pipefy, o ZEN e o razão dizem, **sem calcular nada**, para os agentes nunca divergirem. Arquivo entregue a essa pessoa: `Documentação/Base_Conhecimento_Comissoes_BMax_para_Margem_27-11-2026.md` (versão final de 27/11).

## O que existe (tudo no ar, no Postgres boxer-bmax)
- **Razão de comissão:** `bmax_transacoes`/`bmax_saldo` (antigos). Views: `vw_bmax_comissao_lancamentos` (classifica crédito, ajuste, expiração, estorno, saque), `vw_bmax_comissao_por_venda` (custo líquido por card e agente, ids normalizados), `vw_bmax_inconsistencias_margem`.
- **Fatos da venda:** `bmax_cliente_zen` (cliente pelo CNPJ), `bmax_venda_vinculo` (estado: ok, ok_soma, valor_diverge, sem_nota, sem_cnpj), `bmax_venda_card_nf`, `bmax_venda_nf` (nota + pedido), `bmax_venda_nf_item` (itens com preço, desconto, imposto, frete em `outros_valores`). Views: `vw_bmax_cards_venda`, `vw_bmax_vendas`, `vw_bmax_venda_itens`. Preenchidas pelo auditor (checagem `vendas_zen`, `vendaNfSync.service.js`).
- **Cheques de cashback:** `bmax_cheque_uso`, `bmax_cheque_uso_item`, `bmax_zen_varredura`; views `vw_bmax_cheques`, `vw_bmax_cheque_itens`. Preenchidas pelo robô `cheques-zen` (`chequeUso.service.js`).
- **Acesso:** papel `bmax_margem_leitura` (SELECT nas views, sem login, opcional); a pessoa já tem acesso aos dois projetos do Supabase.
- **SQL versionado:** `scripts/sql/` (índice em `scripts/sql/LEIA-ME.md`); backup do mapa de ids em `Documentação/Backups_Banco/bmax_rd_pipefy_map_ANTES_27-11-2026.json`.

## Regras decididas pelo André
- Valor do card = total final da NF (só impostos, sem frete). **Diferença acima de 1% é erro** (entre 1% e 4% o aviso traz o valor sugerido). Soma de 2 a 6 notas fecha o valor. Cards de teste ("teste" no nome) não entram em nada. **Card vendido sem CNPJ válido = gravidade ALTA** (invalida qualquer conferência com o ZEN).
- Canal no ZEN = Categoria 1 do vendedor (Industria, Varejo, Representante ou vazio): é pista, não filtro.
- **Comissão da revenda:** reconhecida no crédito; só consome a margem quando usada. **Uso = saque que gera cheque** (`BMAX-AAAA-NNNNN`, bonificação ou desconto, 30 dias). O pedido do ZEN que aplica o cheque cita o código na observação; **custo do uso entra na margem desse pedido**. Bonificação = pedido de perfil Brinde OU Bonificação; desconto = pedido de venda comum. O Portal não filtra por perfil.
- **Representante e vendedor interno:** pagos no mês do crédito.

## O que o ZEN entrega e o que não entrega (verificado)
Frete só em 8 de 178 itens (`outros_valores.freightValue`); impostos só como dois totais por item; `costTotalValue` do pedido só em 2 de 99 pedidos (0 nos recentes); só 11 de 99 notas têm a tag `bmax`; o ZEN NÃO filtra pela observação do pedido e leva 11 a 27 s por 100 pedidos (uns 180 pedidos por dia).

## Como retomar
1. Pendências da margem: seção F de `project_bmax_pendencias_atuais.md`. 2. Para qualquer número, ler as views, não recalcular. 3. Para mudar um robô/cron, ver `feedback_bmax_scripts_locais_e_crons.md`.
