## Perfil e preferências

- [user_andre.md](user_andre.md) — André Coelho, gestor comercial Boxer, sem admin Windows, contatos-chave
- [feedback_tecnico.md](feedback_tecnico.md) — Python 3.11, ZEN API sequencial, json.dumps, MSAL OAuth, armadilhas conhecidas
- [feedback_bav_deploy_local.md](feedback_bav_deploy_local.md) — CRÍTICO: sync bsis.db antes de regen local BAV; mtime NÃO prova frescor, checar MAX(data)
- [feedback_doc_tecnico.md](feedback_doc_tecnico.md) — REGRA: toda alteração BMax atualiza todos os docs na mesma sessão
- [feedback_docx_generation.md](feedback_docx_generation.md) — DOCX: regenerar do zero (python-docx ou docx-js), NUNCA editar XML
- [feedback_deploy_completo.md](feedback_deploy_completo.md) — REGRA: sempre commit+push/deploy, nunca perguntar; sempre confirmar via gh run list que um run NOVO iniciou pós-push
- [feedback_no_reread.md](feedback_no_reread.md) — NUNCA reler arquivos inteiros — usar memória + grep pontual, economizar tokens
- [feedback_memory_update_cycle.md](feedback_memory_update_cycle.md) — REGRA: atualizar memória no INÍCIO de sessão continuada e após /compact
- [feedback_pptx_bmax_style.md](feedback_pptx_bmax_style.md) — Padrão PPTX BMax: dark theme, cyan/vermelho, estrutura 6 blocos
- [feedback_m8_sellers_coerencia.md](feedback_m8_sellers_coerencia.md) — M8 "Sellers Ativos" = distintos no período (união); regra coerência BAV↔apresentação
- [feedback_entidade_grupo_cliente.md](feedback_entidade_grupo_cliente.md) — REGRA de identidade+nomeação: entidade=grupo→CNPJ-raiz→cliente; nome ZEN→Excel→nameCalc; CNPJ nunca exibido
- [feedback_portal_bmax_logica.md](feedback_portal_bmax_logica.md) — Portal BMax: PCI12 48h->12b auto + 60d 12a->Prazo Vencido, escopo (consumível), vínculo rep/RD, PCI 12a/12b, upsert `?on_conflict=`, sem migration tooling, dedupe RD case-insensitive, 504 em varredura grande, admin usa service_role. 28/10: PCI 13/14/15 pelo produto + "quem atende", nome da revenda único, travas CNPJ/nome+cidade, lição PowerShell (usar Write p/ scripts), push = deploy
- [feedback_bav_k3_forecast.md](feedback_bav_k3_forecast.md) — K3 Forecast (planejamento): qty-first, tendência 360d máximo disponível, colunas qty/valor média, indicadores gerenciais por categoria, export Excel
- [BOXER_CONTEXTO_PUBLICACAO.md](BOXER_CONTEXTO_PUBLICACAO.md) — Infra Boxer: credenciais CF/Azure/SharePoint/Vercel/Supabase, o que NÃO funciona
- [feedback_bav_agrupar_deploys.md](feedback_bav_agrupar_deploys.md) — REGRA (18/09): não disparar atualizar_diario.yml a cada commit, só ao fim do bloco de trabalho
- [feedback_vercel_preview_testing.md](feedback_vercel_preview_testing.md) — Sessão de IA não roda segredo real local (redigido ao gravar em arquivo); testar via Preview deploy + bypass Deployment Protection
- [feedback_rd_station_v1_activities_endpoint.md](feedback_rd_station_v1_activities_endpoint.md) — RD CRM v1: anotação é `POST /activities` (type:'note'), NÃO `/annotations`/`/deal_annotations` (404 silencioso) — vale p/ GVX e Portal BMax

## Projetos

- [project_bav.md](project_bav.md) — BAV: stack, CI/CD, 9 módulos, ZEN importador. S43 (13/10): filtros M1 combináveis (Produto/Cliente/Operação), clientes distintos, Top10 via cubo ENT, correção slide Top10 clientes; deploy no cron 14/10
- [project_gvx.md](project_gvx.md) — GVX = "Gestão de Visita eXterna Boxer". 02/10: dono do RD via rdResolveRealOwnerId (nunca default), status Novo→Prospecção na 1ª anotação, campos obrigatórios, bloqueio CNPJ já no RD, Acompanhamento no desktop. 08-09/10: cadastro por CNPJ, encaminhar cria card RD, aba Encaminhados, desempenho SDR no dashboard. Pendente: medir perf do gestor, testar fluxo Lorena
- [project_bforce_core_sos.md](project_bforce_core_sos.md) — **BFORCE ESTADO ATUAL (28/10)**: Core x SOS, roteamento, fases A–G no ar, padrão Boxer de resultados, e-mails, varredura 4x/dia, infra e PENDÊNCIAS (D, H, visão geral, SOS, Pipefy, testes, limpeza)
- [project_bforce.md](project_bforce.md) — BFORCE histórico: origem e plano v3 de 15/10 (superado)
- [project_bforce_fase_a.md](project_bforce_fase_a.md) — BFORCE Fase A (27/10): decisões do André sobre pré-visita, aceite do cliente e pagamento (continuam valendo)
- [feedback_gvx_simplicidade_padrao.md](feedback_gvx_simplicidade_padrao.md) — GVX/BFORCE: simples e padronizado (mesma linguagem Core/SOS/gestor), consolidar antes de criar tela nova, gestor por exceção
- [reference_gvx_memory_relatorios.md](reference_gvx_memory_relatorios.md) — Memória GVX da sessão OneDrive-Relatorios: analytics build Fases 1-3, rep aliases, inventário projetos
- [project_comissoes.md](project_comissoes.md) — Validação de Comissões: Python+ZEN API, runner boxer-windows-01
- [project_bmax_motor.md](project_bmax_motor.md) — BMax Motor PCI: 16 PCIs, Diamante (operacional). 21/09: virou somente-leitura em cadastro (RLS), só Portal escreve — ver Doc Técnico. 28/10: Consulta de Lead avisa CNPJ inválido e filial na mesma cidade; workflow diário falhou 28/10
- [project_bmax_portal.md](project_bmax_portal.md) — Portal BMax: Vercel+Supabase+RD V1. 02/10: 3 nomes (login/cadastro/RD) unificados, bug sync case-insensitive, 504 chunking, vários logins por revenda
- [project_bmax_whatsapp.md](project_bmax_whatsapp.md) — Avisos WhatsApp do Portal BMax: só aviso+endereço do Portal (sem botão), Twilio, chip pré-pago novo; textos PCI12/resumo aprovados 14/10, incentivo = fase 2; prévia pronta, falta número+Twilio+cron
- [project_bmax_pendencias.md](project_bmax_pendencias.md) — LEMBRAR a cada sessão (atualizado 05/11; cashback automático por NF EM PAUSA c/ histórico, falta decidir vínculo NF↔card): ABERTO André = planilha v2 do agrupamento de revendas, nome único do rep Victor (Lantyer×VLM), Carthoms/Mecalor, WhatsApp, trocar senha, testar formulários; ABERTO Claude = cashback automático por NF do ZEN, modelo revenda c/ código único (4 logins extras), aplicar planilha, workflow diário do Motor falhou; entregues 14-28/10 resumidos
- [project_bmax_modelo_revenda_grupo.md](project_bmax_modelo_revenda_grupo.md) — 27-28/10: código único de revenda/grupo juntando lojas (CNPJs); RD mostra só o nome da revenda; login e representante (multi) por código; já feito: revenda+login juntos, nome único, alerta revenda sem login; falta: planilha v2, login por código (destrava 4 logins), rep multi
- [project_bmax_api_fields.md](project_bmax_api_fields.md) — RD CRM V1 deal fields: 10 custom + top-level, "REPRESENTANTE " tem trailing space
- [project_bmax_docs.md](project_bmax_docs.md) — Docs BMax: `BMAX CRITERIOS.xlsx` (aba REVENDA) = fonte mestra classe/rep/e-mail; Política V5, Bíblia V5 pendente
- [project_politica_online_pipeline.md](project_politica_online_pipeline.md) — Portal Política Online: CF Pages, DOCX upload, mammoth.js, versões
- [project_bav_grupo_importador.md](project_bav_grupo_importador.md) — RESOLVIDO/prod 07/09/2026: base por CNPJ (dim_cliente+carimbo), identidade unificada por entidade (`entidade_label`) em todos módulos. Billing GH Actions Tekweld é RECORRENTE (voltou 24/09)
- [project_bav_modulo_produto.md](project_bav_modulo_produto.md) — Módulo Produto EM PRODUÇÃO. K.3 forecast redesenhado 10/09 (estoque valida sem capar qty, tendência 20/50/30, cliente YoY). Só K.4 (Supabase) falta

## Ferramentas

- [reference_graphify.md](reference_graphify.md) — Graphify CLI: knowledge graph de codebases, queries inteligentes, 25+ linguagens

## Regras críticas

- Todo novo bloco no BAV DEVE responder a 100% dos filtros ativos (fbar + pbar + ctx de clique) e acionar `setCtx()`
- BAV: `drilldown.json` é buscado incondicionalmente no boot da página (antes do 1º render) — qualquer pipeline que gere `BoxerAppVendas.html` fora do `atualizar_diario.yml` (ex. `relatorio_m4.yml`) precisa gerar TAMBÉM `drilldown.json` e `mcubo_prod.json` ao lado, senão aparece banner de erro "Unexpected token '<'" visível na tela/PDF
- BAV: Playwright gerando PDF de uma página com Chart.js — sempre `Chart.defaults.animation = false` via `page.evaluate()` logo após `page.goto()`, ANTES de qualquer gráfico ser criado. Qualquer mudança de layout feita depois (ocultar elementos, trocar aba) dispara o resize responsivo do Chart.js e reanima o gráfico; sem isso o PDF pode capturar a animação pela metade (eixo certo, barras curtas)
- MSAL Token renovado 29/07/2026 (ambos repos) — estimativa de expiração ~26/09/2026 já passou, mas CI (`relatorio_m4.yml`, `atualizar_diario.yml`) seguia rodando verde em 02/10/2026; a estimativa de ~60 dias é aproximada, renovar só se algum workflow começar a falhar com erro de auth
- Motor PCI: Diamante é OPERACIONAL, não classificatório — os 16 PCIs nunca mudam por causa do Diamante
- Portal BMax: PCI 12a = BOX>REV (revenda atende), PCI 12b = BOX+REV>IND (Boxer vende) — NUNCA inverter
- Portal BMax: caminho PCI12 (12a e 12b) NUNCA muda de pipeline no RD (só de etapa, dentro de Indústria Interno) — mudar de funil faz o card desaparecer do painel pra sempre
- Portal BMax: RD Station CRM V1 (token simples), NÃO mais V2 OAuth — migração concluída 12/08/2026
- Portal BMax: `git push` = deploy automático em produção (Vercel+GitHub) — não existe "só commitar local com segurança", confirmar com André antes
- Portal BMax: editar `public/js/*.js` sem bumpar `?v=` em `index.html` = navegador serve versão antiga em cache
- Portal BMax: sem migration tooling — mudar model Sequelize (coluna/tabela/enum novo) NUNCA muda o Postgres real sozinho, já quebrou 2x (RevendaFiliais, enum funcionario) — aplicar DDL em produção junto com o deploy
- GVX: só `api/index.js` existe/roda (17/09: `index.mjs` e a cópia Netlify removidos — eram código morto). Writes Supabase via `supabase db query --linked` (pasta GVX linkada); MCP execute_sql é read-only
- GVX: "Criar no RD" aceita `rd_owner_name` no body → usa RD_OWNERS_MAP. "Marcar Perdido" move etapa no RD. Auto-sync RD ao salvar relatório (rdSyncDealVisit)
- RD CRM v1 (qualquer projeto): anotação/nota num deal é `POST /activities` com `type:'note'` — `/annotations` e `/deal_annotations` dão 404 (página HTML, não erro de API), fácil de mascarar com `.catch()`
- Portal BMax: pra cadastrar/classificar revenda (classe, rep, e-mail), SEMPRE checar `Documentação\BMAX CRITERIOS.xlsx` (aba REVENDA) primeiro — é a fonte mestra, não inferir do Supabase
- Portal BMax: varredura completa do funil do RD (renomear/reatribuir em massa) tem que ser chunked/retomável (`maxMs`+`cursor`) — rodar síncrono numa request só já deu 504 real com revenda de muitos leads
- Portal BMax: rotas em `admin.routes.js` usam chave `service_role` do Supabase boxer-sistemas, nunca `anon` — já são protegidas por JWT próprio, e GRANT/RLS pra `anon` lá é instável (401 intermitente)
- Portal BMax: visibilidade de lead é many-to-one via `Revendas.name` (Postgres) — vários logins podem ter o mesmo nome e ver os mesmos leads, não precisa duplicar cadastro Supabase pra isso
- [feedback_gvx_deploy_vercel_cli.md](feedback_gvx_deploy_vercel_cli.md) — GVX: deploy = `vercel --prod` local; push não publica; build via Git quebra (package.json ignorado)
