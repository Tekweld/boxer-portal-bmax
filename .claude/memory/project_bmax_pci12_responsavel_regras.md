---
name: project-bmax-pci12-responsavel-regras
description: Regras de responsável por PCI12/12a/12b, consumíveis e vendas (confirmadas pelo André em 26/11/2026) e o que foi corrigido no Pipefy e no robô de 48h
metadata:
  type: project
---

Regras confirmadas pelo André em 26/11/2026 (valem para Pipefy e para o auditor):

- **PCI12 pendente e PCI12a**: responsável = André Coelho (nos dois campos `Responsável` e `Responsável `). Vendedor Boxer como responsável de lead da revenda faz o vendedor querer vender o que é da revenda.
- **PCI12b**: responsável = quem vendeu/atende (Carlos, Max, Lucas...), NUNCA André. Venda 12b mantém o responsável.
- **PCI12 puro nunca pode estar em venda**: só conclui como 12a (André) ou 12b. O auditor acusa (`pci12_em_venda`).
- **Perdido/histórico**: responsável fica como está.
- **Lead que veio da revenda**: PCI13/14/15 por produto (Robô/Laser/Máquinas), nunca 12x. Thibra, Novoletto e Unidral viraram PCI 13 em 26/11.
- **Consumível** (e Migflex, produto fora da tabela BMax): venda não é permitida no BMax. Card vai para Sem PCI, Sem revenda, Sem representante, mantém o responsável e leva comentário "venda de consumível não é permitida no BMax". Não aparece para nenhuma revenda, indicador nem cashback (`escopoBmax.service.js`, regra de 08/10/2026).

**Why:** em 19/11 uma ação fora do Portal trocou o responsável de 43 cards PCI12/12a para vendedores Boxer; as vendas de consumível com PCI12 puro apareciam como venda de revenda.
**How to apply:** nunca corrigir sozinho; o auditor só avisa. Antes de mexer no Pipefy, gravar backup em `Documentação/Backups_Banco/` e conferir depois de gravar (reaplicar o mesmo valor num campo de responsável pode limpar o assignee: usar `updateCardAssignees`). O token do Pipefy em scripts locais está em `PIPEFY_TOKEN_ADMIN` do `.env`.

**Mecanismo de 48 h (corrigido em 26/11, commit 6964d61):** `pci12-followup` aplica o 12b automático e `sync-revenda-rep-rd` detecta PCI12 novo. No Pipefy o dono do RD vem como nome e o membro como e-mail: `PIPEFY_EMAIL_POR_DONO_RD`/`donoRdPorEmail` em `constants.js` fazem a ponte e o detector passa o card para o André. Não testado de ponta a ponta: conferir no 1º ciclo real. Ver [[project-bmax-auditor-diario]] e [[project-bmax-pendencias-atuais]].
