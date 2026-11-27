---
name: feedback-bmax-scripts-locais-e-crons
description: Armadilhas aprendidas em 27/11/2026: script local sem CRM_PROVIDER=pipefy lê o RD parado; mapa de ids do Pipefy só na Vercel; Vercel perde disparos de cron (despachante); outras.
metadata:
  type: feedback
---

- **Script local que lê cards precisa de `process.env.CRM_PROVIDER = "pipefy"` antes de carregar os serviços.** Sem isso o código usa o padrão "rd" e lê o RD Station, **parado desde 23/11/2026** (ids hex, dados velhos). Uma simulação "venda x NF" feita assim foi descartada em 27/11. **Why:** o André avisou "cuidado em usar RD, agora trabalhamos com Pipefy". **How to apply:** nos scripts de `scripts/` já forçado; mesmo assim o mapa de ids (`PIPEFY_MAPA_JSON`) só existe na Vercel, e `vercel env pull` foi bloqueado pelo classificador. Para ver o que o Portal vê do Pipefy: ler o resultado do auditor em produção (`bmax_auditoria_achados`, views) ou rodar o cron pelo painel da Vercel.
- **A Vercel perde disparos de cron de forma aleatória por entrada**, mesmo no Pro, e não tenta de novo. O **despachante** (cron a cada 10 min) recupera. **How to apply:** ao criar ou mudar um cron, atualizar a agenda em `src/services/despachante.service.js` E o `vercel.json` (um teste falha se divergirem); marcar `soAusente` se o robô manda e-mail sem controle de repetição; janela de recuperação menor que o intervalo até a rodada seguinte.
- **Robô que varre o ZEN precisa ser incremental e retomável** (orçamento de tempo + cursor), porque o ZEN leva 11 a 27 s por 100 pedidos e a função tem no máximo 300 s.
- **Aplicar DDL em produção só com autorização do André**, depois de validar numa transação desfeita (`BEGIN ... ROLLBACK`) com dados reais; o sistema não tem migration automática.
- **Edição de arquivo por script JS:** não use `String.replace` com texto que contenha `$'` ou `$&` (duplica o arquivo); use função ou `split/join`. Para texto longo, crie o script com a ferramenta Write em vez de heredoc de shell.
- **Não esperar tarefa longa com `sleep` no shell:** rode em segundo plano e leia a notificação.
