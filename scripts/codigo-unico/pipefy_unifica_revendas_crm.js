// Unifica o campo "Revenda/Loja" do pipe CRM BOXER SOLDAS (Pipefy) com os nomes únicos do código único (24/11/2026).
// Usa PIPEFY_TOKEN_ADMIN do .env (token de administrador, só na máquina local — nunca vai para a Vercel).
// Fluxo: acrescenta os nomes corretos que faltam -> renomeia os cards que usam nome antigo -> tira da lista as opções antigas SEM card.
// Opção antiga sem loja correspondente e COM card fica na lista (reportada). Uso: node scripts/codigo-unico/pipefy_unifica_revendas_crm.js [--aplicar]
const path = require("path"); const fs = require("fs");
const ROOT = path.resolve(__dirname, "../.."); process.chdir(ROOT); require("dotenv").config({ quiet: true });
const { sbSistemasService } = require(ROOT + "/src/config/supabaseSistemas"); const { codigoDe, norm, limparCache } = require(ROOT + "/src/services/codigoUnico.service");
const T = process.env.PIPEFY_TOKEN_ADMIN; if (!T) { console.error("PIPEFY_TOKEN_ADMIN não está no .env"); process.exit(1); }
const PIPE_ID = "307242360", CAMPO = "revenda_loja", APLICAR = process.argv.includes("--aplicar");
const gql = async (query, variables) => { const r = await fetch("https://api.pipefy.com/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + T }, body: JSON.stringify({ query, variables }) }); const j = await r.json(); if (j.errors) throw new Error(j.errors.map(e => e.message).join("; ")); return j.data; };
const SEM_REVENDA = "Sem revenda";   // grafia aceita pelo pipe (alias do Portal: "Sem Revenda" <-> "Sem revenda")

async function cardsComValor(valor) {
  let cursor = null, todos = [];
  for (;;) {
    const d = await gql(`query($p:ID!,$c:String!,$v:String!,$a:String){ findCards(pipeId:$p, search:{fieldId:$c, fieldValue:$v}, first:50, after:$a){ edges{ node{ id title } } pageInfo{ hasNextPage endCursor } } }`, { p: PIPE_ID, c: CAMPO, v: valor, a: cursor });
    todos = todos.concat(d.findCards.edges.map(e => e.node));
    if (!d.findCards.pageInfo.hasNextPage) break; cursor = d.findCards.pageInfo.endCursor;
  }
  return todos;
}

(async () => {
  limparCache();
  const campo = (await gql(`query($id:ID!){ pipe(id:$id){ start_form_fields{ id uuid label options } } }`, { id: PIPE_ID })).pipe.start_form_fields.find(f => f.id === CAMPO);
  const opcoes = campo.options || [];
  const lojas = await sbSistemasService("/comercial_revendas_bmax?ativo=eq.true&select=id,nome,nome_rd,grupo_id");
  const grupos = new Map((await sbSistemasService("/comercial_bmax_grupos?select=id,nome")).map(g => [g.id, g.nome]));
  const todasLojas = new Map((await sbSistemasService("/comercial_revendas_bmax?select=id,nome,nome_rd,ativo")).map(l => [l.id, l]));
  const esperados = new Map(); for (const l of lojas) { const n = String(l.nome_rd || l.nome || "").trim(); if (n) esperados.set(norm(n), n); }
  esperados.set(norm(SEM_REVENDA), SEM_REVENDA);
  const traduzir = async op => {
    if (esperados.has(norm(op))) return esperados.get(norm(op));
    const c = await codigoDe(op, "revenda");
    if (c.grupo_id && grupos.get(c.grupo_id) && esperados.has(norm(grupos.get(c.grupo_id)))) return esperados.get(norm(grupos.get(c.grupo_id)));
    if (c.revenda_id) { const l = todasLojas.get(c.revenda_id); if (l && l.ativo) return String(l.nome_rd || l.nome).trim(); }
    return null;
  };
  const legado = opcoes.filter(o => !esperados.has(norm(o)));
  const faltam = [...esperados.values()].filter(n => !opcoes.some(o => norm(o) === norm(n)));
  console.log(`opções hoje: ${opcoes.length} | corretas esperadas: ${esperados.size} | antigas: ${legado.length} | faltam: ${faltam.length}`);

  const itens = [];
  for (const op of legado) { const alvo = await traduzir(op); const cards = await cardsComValor(op); itens.push({ antiga: op, alvo, cards }); }
  const renomear = itens.filter(i => i.alvo && i.cards.length), manter = itens.filter(i => !i.alvo && i.cards.length), remover = itens.filter(i => !i.cards.length);
  console.log("ACRESCENTAR:", faltam.join(" | "));
  console.log("RENOMEAR CARDS:", renomear.map(i => `${i.antiga} -> ${i.alvo} (${i.cards.length})`).join(" | ") || "nenhum");
  console.log("FICAM (sem loja e com cards):", manter.map(i => `${i.antiga} (${i.cards.length}: ${i.cards.slice(0, 3).map(c => c.title).join("; ")})`).join(" | ") || "nenhuma");
  console.log(`REMOVER da lista (nenhum card): ${remover.length}`);
  if (!APLICAR) return;

  const bk = path.resolve(ROOT, "../Documentação/Backups_Banco/pipefy_crm_revenda_loja_ANTES_24-11-2026.json");
  fs.writeFileSync(bk, JSON.stringify({ opcoes, renomear: renomear.map(i => ({ antiga: i.antiga, alvo: i.alvo, cards: i.cards })) }, null, 1)); console.log("backup:", bk);
  const setOpcoes = async lista => gql(`mutation($id:ID!,$uuid:ID!,$label:String!,$options:[String]){ updatePhaseField(input:{id:$id, uuid:$uuid, label:$label, options:$options}){ phase_field{ id } } }`, { id: CAMPO, uuid: campo.uuid, label: campo.label, options: lista });
  let atuais = [...opcoes, ...faltam]; if (faltam.length) { await setOpcoes(atuais); console.log("acrescentadas:", faltam.length); }
  let ok = 0, falhou = 0;
  for (const i of renomear) for (const c of i.cards) {
    try { await gql(`mutation($c:ID!,$f:ID!,$v:[UndefinedInput]){ updateCardField(input:{card_id:$c, field_id:$f, new_value:$v}){ success } }`, { c: c.id, f: CAMPO, v: i.alvo }); ok++; }
    catch (e) { falhou++; console.log("falhou card", c.id, e.message); }
  }
  console.log(`cards renomeados: ${ok} | falharam: ${falhou}`);
  // confere e tira só as opções antigas que ficaram sem card
  const sair = new Set();
  for (const i of itens) { if (!i.alvo && i.cards.length) continue; const restam = (await cardsComValor(i.antiga)).length; if (!restam) sair.add(i.antiga); else console.log("ainda tem card, mantida:", i.antiga, restam); }
  const novas = atuais.filter(o => !sair.has(o)); await setOpcoes(novas);
  const depois = (await gql(`query($id:ID!){ pipe(id:$id){ start_form_fields{ id options } } }`, { id: PIPE_ID })).pipe.start_form_fields.find(f => f.id === CAMPO).options;
  console.log(`opções removidas: ${sair.size} | opções agora: ${depois.length} | alvo: ${novas.length}`);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
