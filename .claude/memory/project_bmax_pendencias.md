---
name: project-bmax-pendencias
description: "Pendências abertas do Portal BMax/Motor (o que o André decide, o que o Claude faz) + o que foi entregue em 14-28/10/2026; lembrar a cada sessão até concluir"
metadata:
  node_type: memory
  type: project
  originSessionId: 87fa48d5-0558-4034-9609-8fbcde3f3b32
  modified: 2026-10-28T21:01:18.823Z
---

André pediu (15 e 28/10/2026): **me lembrar das pendências a cada sessão até concluirmos** e dizer o que ele precisa fazer. Última atualização: 28/10/2026 (fim do dia).

## ABERTO — depende do André
1. **Planilha de agrupamento das revendas** — `Projeto BMax/Documentação/Proposta_agrupamento_revendas_v2_27-10-2026.xlsx` (abas Revendas → Lojas → Cards RD → Logins; ele revisa aba por aba e avisa quando concluir). As respostas da v1 nunca chegaram (arquivo no disco não mudou): pedir o arquivo salvo `_respondida`. Decisão já tomada: o RD mostra SÓ o nome da revenda (sem filial). Cadastros inativos com login/cards (Ipanema, Locsoldas, Tamoyo, AP Máquinas…) entram na v2 como REV-036+ ("reativar?").
2. **Nome único do representante no RD:** Victor tem "Victor Lantyer" (212 cards) e "Victor VLM" (175). Escolher 1 (sugestão: Victor VLM) → Claude padroniza os cards e o Portal passa a gravar só esse (hoje `resolverRepresentanteDaRevenda` grava o alias).
3. **Carthoms:** manter o card da Cris (Indústria); depois corrigir o CNPJ dele para o válido 04.280.516/0001-98 e fechar o do Victor (BMAX); definir a origem (rep × revenda Luitex).
4. **Mecalor** (CNPJ truncado 49.031.776/0001-6): André confere à mão. Pares com mesmo CNPJ restantes: Asmontec × Departamento Compras (01.117.710/0001-69) — "são negociações diferentes", deixou.
5. **WhatsApp** (detalhes em [[project-bmax-whatsapp]]): chip pré-pago → sender na Twilio → 2 modelos (sem botão, Utilidade) aprovados (códigos `HX...`) → celulares das revendas (3 de 63 válidos) e aceite → Claude faz o cron de envio com dedupe.
6. **Trocar a senha dele** (passou pelo chat em 15/10/2026); conferir visualmente o Playbook novo (2 páginas) e o formulário como revenda e como representante (Claude não tem esses logins — fazer 1 negociação de teste de cada e o Claude confere o resultado no RD).
7. **Dois cards perdidos antigos** (Gabriele de Paula Alves; José Otávio de Faria): o RD exige classe de preço/segmento — André disse "pode ignorar". Cards de TESTE ("Teste Integração BMAX n", TESTE_*) abertos no BMAX: "pode deixar por enquanto".

## ABERTO — o Claude faz (próxima rodada, ordem sugerida)
a. **Cashback automático pela NF do ZEN** quando a revenda atende (ela não informa; Boxer fatura direto no CNPJ do lead; a classe de preço é preenchida à mão pelo vendedor Boxer). Fluxo proposto: job (GitHub Actions, credenciais ZEN do BAV) grava notas faturadas por CNPJ no Supabase; robô do Portal casa CNPJ+equipamento+60 dias e move o card p/ Vendido com o valor real; ambiguidade → fila do admin; devolução estorna. O boxer-hub já lê NF do ZEN (`api/sync-financeiro.js`: `receivable/outgoingInvoice` direto, `fiscal.OutgoingInvoice`, corte 01/03/2025, DANFE template 1119) — reaproveitar. Falta: validar com leitura do ZEN se a NF traz CNPJ/itens/classe.
b. **Modelo de revenda com código único** (ver [[project-bmax-modelo-revenda-grupo]]): coluna nova + campo "Revenda" na tela + filtro por código; representante com múltipla escolha. Destrava os **4 logins extras** pedidos (loja@alugaasolda.com.br→AlugaASoldas, fernando@casadosoldador.com.br→Casa do Soldador, Joaocandiotto005@gmail.com→Cascavel Soldas, compras@casadosparafusos.com.br→"A Bittencourt (Casa dos Parafusos)", classe Ouro) — bloqueados porque `Revendas.cnpj` é UNIQUE.
c. **Aplicar a planilha** (depois que o André devolver): simulação → backup → renomear cards p/ nome único, retirar nomes antigos (39 sem cards) das listas do RD, reativar cadastros decididos, trava nome obrigatório+único no banco.
d. **Workflow "Atualizar BMax (diário)" do Motor FALHOU em 28/10 17:02Z** (run 40731844205, etapa "Sincronizar Excel → Supabase", 21 s) — investigar.
e. **Playbook/Regras:** nada pendente; se a tabela de comissão mudar, atualizar o modal "Regras e cashback" (valores digitados no HTML).

## ENTREGUE (em produção) — resumo
- 14–15/10: prazos 24h/48h só em dias úteis (60 dias do 12a corridos); robôs 07/10/14/17h; Playbook da revenda 2 páginas; orçamento obrigatório (1–3 arquivos, Supabase Storage, nota com link fixo no card).
- 27–28/10: contato do cliente no PCI12A sem organização (`getContatoPrincipal`); botão "Regras e cashback"; link "Esqueci minha senha"; Editar revenda rápido; Brasolda (Diamante) e Trianorte (Ouro) ativadas; login da Ultra Máquinas (CEP 13040-001); cadastro de revenda + login juntos com nome único; caso Heitor/Suprimig (6 de 8 cards corrigidos, 12 renomeados, robô de 48h não conta prazo de revenda sem login, alerta admin "Revenda sem login" + e-mail); Nova Negociação: PCI por produto (13/14/15), perguntas Produto/Caminho/Quem atende (revenda + representante/admin, campo Funil removido), representante preenchido pelo cadastro (9 cards antigos), trava CNPJ inválido + nome igual na cidade, aviso de filial na mesma cidade (Portal + Motor); cards: Tecnoservice (Carlos) cancelado, Volt duplicado fechado, Technofer com Victor VLM + estado SP, SCOTTECH (MAQSOLDAS) virou PCI 14 com a revenda atendendo; Gas Cat finalizado pelo André.
- GitHub: `andreboxer` voltou a ter escrita (28/10); `git push origin main` publica sozinho na Vercel (Portal) e no Cloudflare Pages (Motor).

## Decisões do André (valem)
- CNPJ repetido: o Portal BLOQUEIA (melhorar depois; "dono do cliente + várias negociações" é só ideia).
- Portal não mostra cards em etapa perdido/excluído (`getLeads` exclui RD_STAGE_PERDIDO e RD_STAGE_EXCLUIDO).
- PCI do lead da revenda é sempre o da regra do projeto pelo produto (Máquinas 15, Laser 14, Robô 13), independente de quem vende/atende; 12a/12b só para lead enviado PELA Boxer. "Revenda atende" → o card NÃO aparece p/ vendedor Boxer; "Boxer atende" → vendedor da região/Responsável escolhido.

**Why:** o André usa o Claude como gerente de projeto das pendências; esquecer item aberto custa retrabalho.
**How to apply:** no início de cada sessão do BMax, listar o que continua aberto e o próximo passo do André; marcar como feito só quando ele confirmar. Ver também [[feedback-portal-bmax-logica]].
