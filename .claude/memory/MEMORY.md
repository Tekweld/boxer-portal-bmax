## BMax — arquivos que existem NESTE repo (leia primeiro o estado de 25/11)

- [project_bmax_estado_2026_11_25.md](project_bmax_estado_2026_11_25.md) — **ESTADO REAL em 25/11/2026 (fonte de verdade)**: Pipefy em produção, funil por etiqueta "RD: Indústria", cashback = só o razão (nunca estimativa), PCI manda na comissão, PCI12/PCI X, pendências. Vence qualquer memória de set/out.
- [project_bmax_auditor_diario.md](project_bmax_auditor_diario.md) — Auditor diário (publicado 25/11/2026): só lê e avisa o André por e-mail, 2x/dia; 8 checagens, tabelas, crons e o que falta
- [feedback_bmax_cache_pipefy_preaquecer.md](feedback_bmax_cache_pipefy_preaquecer.md) — Mudou a consulta/filtro do Pipefy? Refazer o cache no banco LOCALMENTE antes (leitura completa = 139 s > 60 s da Vercel; incidente do painel vazio 25/11)
- [feedback_portal_bmax_logica.md](feedback_portal_bmax_logica.md) — Portal BMax: PCI12 (48h→12b, 60d 12a→Prazo Vencido), escopo consumíveis, vínculo rep/RD, nomes de revenda/grupos, sem migration tooling, 504 em varredura; 28/10: PCI 13/14/15 pelo produto + "quem atende", nome único da revenda, travas CNPJ/nome+cidade
- [project_bmax_portal.md](project_bmax_portal.md) — Portal BMax: Vercel+Supabase+RD V1 (visão geral até 05/11; o CRM agora é Pipefy, ver estado 25/11)
- [project_bmax_motor.md](project_bmax_motor.md) — BMax Motor PCI: 16 PCIs, Diamante operacional, somente-leitura em cadastro (RLS), só o Portal escreve
- [project_bmax_modelo_revenda_grupo.md](project_bmax_modelo_revenda_grupo.md) — 27-28/10: código único de revenda/grupo juntando lojas/CNPJs (hoje também carteira de cashback por grupo)
- [project_bmax_pendencias.md](project_bmax_pendencias.md) — HISTÓRICO até 05/11 (cashback automático por NF em pausa etc.). **Pendências atuais: `Documentação/Registro_Mudancas_Portal_BMax_23-25-11-2026.md` §6.**
- [project_bmax_whatsapp.md](project_bmax_whatsapp.md) — Avisos WhatsApp: só aviso+link do Portal (Twilio), sem botão; textos aprovados 14/10; falta número+Twilio+cron
- [project_bmax_api_fields.md](project_bmax_api_fields.md) — custom fields do deal no RD V1; "REPRESENTANTE " tem espaço no fim
- [project_bmax_docs.md](project_bmax_docs.md) — `BMAX CRITERIOS.xlsx` (aba REVENDA) é a fonte mestra de classe/rep/e-mail
- [project_bmax_comissoes_auditoria.md](project_bmax_comissoes_auditoria.md) — 14/09: auditoria de comissões, Segmento/Origem por PCI, dedup de reps (e-mail, não nome), fix do upsert `?on_conflict=`
- [feedback_bmax_supabase_keys.md](feedback_bmax_supabase_keys.md) — `comercial_revendas_bmax` mora no **boxer-sistemas**: usar `sbSistemas`, NUNCA `sbBmax`; verificar com consulta ao vivo antes de confiar (esta regra já foi escrita errada 3 vezes)
- [project_bmax_pci12_owner_switch.md](project_bmax_pci12_owner_switch.md) — HISTÓRICO 14–17/09 do PCI12. Superado por `DOCUMENTACAO_TECNICA.md` §6 (48 horas úteis, 60 dias do 12a, desfecho).
- [project_bmax_email_setup.md](project_bmax_email_setup.md) — e-mail transacional via Resend funcionando; caindo em spam até SPF/DKIM/DMARC
- [project_bmax_export_features.md](project_bmax_export_features.md) — exportação de leads (alertas, colunas Data/Oportunidade, filtro); formato real hoje é .xlsx
- [project_bmax_audit_ratelimit.md](project_bmax_audit_ratelimit.md) — trilha de auditoria completa e rate limits
- [project_bmax_validations_improvements.md](project_bmax_validations_improvements.md) — permissões de filial, validações CNPJ/e-mail/CEP/telefone, audit log
- [project_bmax_filiais.md](project_bmax_filiais.md) — revenda com várias filiais; matriz criada automaticamente
- [project_bmax_cep_autofill.md](project_bmax_cep_autofill.md) — cadastro de revenda/filial começa pelo CEP (ViaCEP)
- [project_bmax_graphify.md](project_bmax_graphify.md) — grafo de conhecimento do código (`.claude/graph/graphify-out/graph.html`)

## Fora deste repo (memória pessoal do André — os arquivos abaixo NÃO estão aqui)

Este bloco veio de uma cópia do índice pessoal. Os links não abrem a partir do repositório. Serve só de pista do que existe na memória pessoal.

### Perfil e preferências
- user_andre.md — André Coelho, gestor comercial Boxer, sem admin Windows, contatos-chave
- feedback_tecnico.md — Python 3.11, ZEN API sequencial, json.dumps, MSAL OAuth, armadilhas conhecidas
- feedback_bav_deploy_local.md — CRÍTICO: sync bsis.db antes de regen local BAV; mtime NÃO prova frescor, checar MAX(data)
- feedback_doc_tecnico.md — REGRA: toda alteração BMax atualiza todos os docs na mesma sessão
- feedback_docx_generation.md — DOCX: regenerar do zero (python-docx ou docx-js), NUNCA editar XML
- feedback_deploy_completo.md — REGRA: sempre commit+push/deploy, nunca perguntar; confirmar via gh run list que um run NOVO iniciou pós-push
- feedback_no_reread.md — NUNCA reler arquivos inteiros; usar memória + grep pontual
- feedback_memory_update_cycle.md — REGRA: atualizar memória no INÍCIO de sessão continuada e após /compact
- feedback_pptx_bmax_style.md — Padrão PPTX BMax: dark theme, cyan/vermelho, estrutura 6 blocos
- feedback_m8_sellers_coerencia.md — M8 "Sellers Ativos" = distintos no período; coerência BAV↔apresentação
- feedback_entidade_grupo_cliente.md — identidade+nomeação: entidade=grupo→CNPJ-raiz→cliente; CNPJ nunca exibido
- feedback_bav_k3_forecast.md — K3 Forecast: qty-first, tendência 360d, export Excel
- BOXER_CONTEXTO_PUBLICACAO.md — Infra Boxer: credenciais CF/Azure/SharePoint/Vercel/Supabase, o que NÃO funciona
- feedback_bav_agrupar_deploys.md — REGRA (18/09): não disparar atualizar_diario.yml a cada commit
- feedback_vercel_preview_testing.md — sessão de IA não roda segredo real local; testar via Preview deploy
- feedback_rd_station_v1_activities_endpoint.md — RD CRM v1: anotação é `POST /activities` (type:'note'), NÃO `/annotations` (404 silencioso)
- feedback_gvx_deploy_vercel_cli.md — GVX: deploy = `vercel --prod` local; push não publica

### Outros projetos
- project_bav.md, project_bav_grupo_importador.md, project_bav_modulo_produto.md — BAV
- project_gvx.md, feedback_gvx_simplicidade_padrao.md, reference_gvx_memory_relatorios.md — GVX
- project_bforce.md, project_bforce_core_sos.md, project_bforce_fase_a.md — BFORCE
- project_comissoes.md — Validação de Comissões (Python+ZEN API)
- project_politica_online_pipeline.md — Portal Política Online
- reference_graphify.md — Graphify CLI

## Regras críticas (BMax)

- Motor PCI: Diamante é OPERACIONAL, não classificatório — os 16 PCIs nunca mudam por causa do Diamante
- Portal BMax: PCI 12a = BOX>REV (revenda atende), PCI 12b = BOX+REV>IND (Boxer vende) — NUNCA inverter
- Portal BMax: caminho PCI12 (12a e 12b) NUNCA muda de funil, só de etapa
- Portal BMax: o CRM é o **Pipefy** desde 23/11/2026 (`CRM_PROVIDER=pipefy`); id do card tem DOIS valores (Pipefy e `rd_deal_id`) e todo cálculo precisa casar pelos dois
- Portal BMax: só cards com etiqueta "RD: Indústria" entram no painel, na comissão, na exportação e no WhatsApp
- Portal BMax: nunca mostrar estimativa de cashback — só o que está no razão
- Portal BMax: o auditor diário SÓ LÊ E AVISA; nunca corrige saldo, card ou qualquer dado de negócio
- Portal BMax: leitura completa do pipe do Pipefy (~139 s) estoura os 60 s da Vercel; ao mudar a consulta ou um filtro por campo novo, refazer o cache no banco localmente ANTES de publicar (senão o painel mostra 0 leads)
- Portal BMax: `git push` = deploy automático em produção (Vercel+GitHub)
- Portal BMax: editar `public/js/*.js` sem bumpar `?v=` em `index.html` = navegador serve versão antiga em cache
- Portal BMax: sem migration tooling — mudar model Sequelize NUNCA muda o Postgres real sozinho (já quebrou 2x); aplicar DDL junto com o deploy
- Portal BMax: helmet injeta `script-src-attr 'none'` se `scriptSrcAttr` não for definido — trava todo `onclick` inline. Teste de tela = clicar no navegador, não só chamar a API
- Portal BMax: pra cadastrar/classificar revenda (classe, rep, e-mail), SEMPRE checar `Documentação\BMAX CRITERIOS.xlsx` (aba REVENDA) primeiro
- Portal BMax: varredura completa do funil (renomear/reatribuir em massa) tem que ser chunked/retomável (`maxMs`+`cursor`) — síncrono numa request já deu 504
- Portal BMax: rotas em `admin.routes.js` usam `service_role` do Supabase boxer-sistemas, nunca `anon`
- Portal BMax: visibilidade de lead é many-to-one via `Revendas.name` — vários logins podem ter o mesmo nome e ver os mesmos leads
- RD CRM v1 (qualquer projeto): nota num deal é `POST /activities` com `type:'note'`; `/annotations` dá 404 (página HTML, não erro de API)

## Regras críticas (outros projetos, preservadas do índice anterior)

- Todo novo bloco no BAV DEVE responder a 100% dos filtros ativos (fbar + pbar + ctx de clique) e acionar `setCtx()`
- BAV: `drilldown.json` é buscado incondicionalmente no boot da página (antes do 1º render) — qualquer pipeline que gere `BoxerAppVendas.html` fora do `atualizar_diario.yml` (ex. `relatorio_m4.yml`) precisa gerar TAMBÉM `drilldown.json` e `mcubo_prod.json` ao lado, senão aparece banner de erro "Unexpected token '<'" visível na tela/PDF
- BAV: Playwright gerando PDF de uma página com Chart.js — sempre `Chart.defaults.animation = false` via `page.evaluate()` logo após `page.goto()`, ANTES de qualquer gráfico ser criado. Qualquer mudança de layout feita depois (ocultar elementos, trocar aba) dispara o resize responsivo do Chart.js e reanima o gráfico; sem isso o PDF pode capturar a animação pela metade (eixo certo, barras curtas)
- MSAL Token renovado 29/07/2026 (ambos repos) — estimativa de expiração ~26/09/2026 já passou, mas CI (`relatorio_m4.yml`, `atualizar_diario.yml`) seguia rodando verde em 02/10/2026; a estimativa de ~60 dias é aproximada, renovar só se algum workflow começar a falhar com erro de auth
- GVX: só `api/index.js` existe/roda (17/09: `index.mjs` e a cópia Netlify removidos — eram código morto). Writes Supabase via `supabase db query --linked` (pasta GVX linkada); MCP execute_sql é read-only
- GVX: "Criar no RD" aceita `rd_owner_name` no body → usa RD_OWNERS_MAP. "Marcar Perdido" move etapa no RD. Auto-sync RD ao salvar relatório (rdSyncDealVisit)
