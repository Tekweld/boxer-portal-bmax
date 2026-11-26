---
name: project-bmax-auditor-diario
description: Agente auditor diário do Portal BMax (publicado 25/11/2026): só lê e avisa por e-mail ao André, 2x/dia; lista de checagens, tabelas, crons, regras e o que falta fazer.
metadata:
  type: project
---

# Auditor diário do Portal BMax (publicado em 25/11/2026)

**Regra do André:** o auditor NUNCA corrige nada. Só sinaliza a divergência; depois o André e eu corrigimos juntos. Não há correção automática de saldo nem de card.

## Como funciona
- Roda 2x/dia por cron: `/api/cron/auditor?rodada=manha` às 09:00 UTC (06h Brasília) e `?rodada=tarde` às 16:00 UTC (13h Brasília), no `vercel.json`. Autenticado por `CRON_SECRET` ou `CRON_TRIGGER_KEY`. `?dry=1` simula sem gravar nem enviar.
- E-mail SÓ para `EMAIL_AUDITOR` (variável da Vercel, produção = e-mail do André) e SÓ quando há achado novo ou lembrete semanal (7 dias) de achado antigo. Sem achado novo, não há e-mail.
- Cada achado tem chave estável. Estados: novo, persistente, resolvido (some sozinho quando a checagem roda bem e não o encontra mais). Checagem que FALHA ao rodar vira achado `auditor_checagem_falhou:<id>` e nunca resolve os achados dela. Rodada agendada que não aconteceu (mais de 20h desde a anterior) vira achado `auditor_rodada_perdida`.
- Aba **Gestão > Auditor diário**: achados abertos/resolvidos, últimas execuções e botão "Rodar simulação agora" (sem gravar nem enviar). Achados de PCI12a trazem "ver os N card(s)" com link do Pipefy. E-mail e aba usam a mesma ordem de temas: saldo, créditos anormais, checagens/rodadas do auditor, robôs, vendas com dados faltando, mudanças de PCI/produto/classe, PCI x produto, cobrança PCI12a.

## Checagens ativas (9 funções)
1. `saldo_vs_razao`: `bmax_saldo` x soma de `bmax_transacoes` (tolerância R$ 0,01).
2. `creditos_anormais`: mais de 40 créditos ou R$ 25 mil em 24h (limites de `roboMonitor`).
3. `robos`: robô de `ESPERADOS` sem sucesso no prazo, ou última execução falha.
4. `venda_sem_dados`: venda (Vendido, Venda Efetivada, Entrega Técnica, valor > 0) sem PCI, produto, classe, revenda ou representante. Sem PCI/classe = alta (a comissão não é creditada). "Sem Revenda" e representante "N/D" são respostas válidas.
5. `pci_x_produto`: PCI incompatível com o produto do card (Robô = 1,2,3,13; Laser = 4,5,6,14; Máquinas = 7 a 12b e 15; PCI16 e PCI X ficam de fora). Sem produto no card, usa a "máquina de interesse" só como indício (gravidade baixa).
6. `mudancas_campos`: mudança de PCI/produto/classe contra o retrato anterior (`bmax_auditoria_cards_ultimo`). A primeira rodada real só grava a linha de base (311 cards em 25/11). Vazio->preenchido e PCI12->12a/12b não contam. Alta se a venda já foi creditada. Fica aberta 3 dias.
7. `pci12a_sem_resposta`: PCI12a em aberto sem desfecho e sem andamento da revenda (nenhum andamento, ou último status Pendente/Sem retorno), agrupado por revenda e representante, para cobrança. Casa os DOIS ids do card (Pipefy e RD). Alta a partir de 50 dias (prazo é 60).
8. `rodada_perdida`: descrita acima.
9. `pci12_responsavel` (26/11): PCI12/12a em aberto (não vendido) com responsável diferente de André Coelho. Só avisa.

## Tabelas (DDL em `scripts/create-auditor-tables.js`, aplicado em produção 25/11)
`bmax_auditoria_achados`, `bmax_auditoria_execucoes`, `bmax_auditoria_cards_ultimo`, `bmax_auditoria_card_mudancas`. O auditor só escreve nelas.

## Código
`src/services/auditor.service.js` (checagens, reconciliar, e-mail, rodarAuditoria), `auditorCards.service.js` (regras puras de cards), `src/routes/auditor.routes.js`, `public/js/auditor.js`. Commits 0fe2e6a, 776ad7e, 55a5941, 3b5d009. Testes: `auditor.service.test.js` e `auditorCards.service.test.js`.

## Primeira simulação em produção (25/11, 38 achados), conferida pelo André
2 robôs parados (`pci12a-prazo`, `pcix-prazo`), 10 vendas com dado faltando (uma de R$ 197.900 sem PCI), 13 PCI x produto, 13 revendas com PCI12a sem resposta (21 cards; a Eletro Solda estava a 10 dias do prazo). O André validou 3 achados de PCI x produto e vendas sem PCI como corretos.

## O que falta
- **A primeira rodada real NÃO aconteceu em 26/11** (a manhã de 06h Brasília): a Vercel não disparou o cron (ver "Ocorrências"). Conferir a rodada "tarde" (16:00 UTC) de 26/11: linha em `bmax_auditoria_execucoes`, e-mail recebido, linha de base gravada.
- Depois da 1a rodada real OK, incluir `auditor` em `ESPERADOS` (`roboMonitor.service.js`). Antes disso o vigia acusaria falha de um robô que nunca rodou.
- Investigar por que `pci12a-prazo` e `pcix-prazo` não rodaram em 25/11 (a Vercel pulou chamadas de cron de 11h a 13h UTC; também faltaram `sync-consulta-lead` e `recalcular-comissoes` nessa janela). Se repetir, mover os crons críticos para um agendador com horário exato.
- Checagens ainda não feitas: cards duplicados, ids órfãos, status x etapa residual, etiqueta ausente, prazos 12/12a/PCI X parados, pessoas (revenda sem login, representante sem e-mail), nomes fora do padrão.
- Ficar 1 a 2 semanas só em modo aviso antes de ampliar o que o auditor olha.

**Why:** o André quer ser avisado cedo de divergência de dinheiro e de dado de card, sem e-mail de ruído e sem nada sendo corrigido às escuras.
**How to apply:** nova checagem = função em `CHECAGENS` com `cobre` (tipos de achado que ela pode resolver) + tema em `TEMAS` (`auditor.service.js`) e em `AUDITOR_TEMAS` (`public/js/auditor.js`). Nunca fazer o auditor gravar em tabela de negócio.
## Ocorrências
- **26/11/2026, cron do auditor não disparou.** Entre 21:30 UTC de 25/11 e 12:28 UTC de 26/11 não rodou nenhum robô agendado, exceto `status-x-etapa`: faltaram `vigia-robos` (22:30), auditor (09:00), `expirar-cashback`, `sync-revenda-rep-rd` e `pci12-followup` (10:00), `pci12a-prazo` (11:00) e `pcix-prazo` (11:30). Sem registro em `bmax_robo_execucoes` nem em `bmax_auditoria_execucoes`: a chamada nem chegou ao app (falha do app deixaria registro de falha). Os crons estavam registrados na Vercel (23 definições, ativos, atualizadas em 25/11 20:19 UTC). `recalcular-comissoes` (12:00) só rodou às 12:55 UTC.
- **Plano da Vercel passou de Hobby para Pro em 26/11/2026** (o time `boxer-soldas1` consta como `pro`). No Hobby o cron dispara em qualquer momento da hora e a Vercel pulou execuções; a Vercel não reexecuta cron que falhou. No Pro o cron deve sair no minuto agendado e `maxDuration` pode subir até 300 s (não alterado). Pendente: confirmar a pontualidade dos crons depois da troca; se os crons registrados sob as regras antigas continuarem atrasados, fazer um deploy (mesmo vazio) para a Vercel registrá-los de novo.
- **Como inspecionar os crons registrados (Git Bash):** `MSYS_NO_PATHCONV=1 vercel api "/v9/projects/boxer-portal-bmax" --raw --scope boxer-soldas1` e ler `crons.definitions`, `crons.updatedAt`. Sem `MSYS_NO_PATHCONV=1` o caminho vira caminho do Windows e o comando falha. O log da Vercel (`vercel logs`) guarda só cerca de 1 hora; diagnóstico de cron perdido tem que ser feito pelas tabelas `bmax_robo_execucoes` e `bmax_auditoria_execucoes`.

