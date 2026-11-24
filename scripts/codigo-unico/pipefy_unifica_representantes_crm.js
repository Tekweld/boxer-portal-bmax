// Unifica o campo "Representante" do CRM BOXER SOLDAS com o cadastro (nome do representante) via código único/apelidos.
// Mesmo fluxo da revenda: acrescenta os que faltam -> renomeia cards de nomes antigos -> tira da lista só as opções SEM card.
// Uso: node scripts/codigo-unico/pipefy_unifica_representantes_crm.js [--aplicar]
const path = require("path"); const fs = require("fs"); const ROOT = path.resolve(__dirname, "../.."); process.chdir(ROOT); require("dotenv").config({ quiet: true });
const { sbSistemasService } = require(ROOT + "/src/config/supabaseSistemas"); const { codigoDe, norm, limparCache } = require(ROOT + "/src/services/codigoUnico.service");
const T = process.env.PIPEFY_TOKEN_ADMIN, PIPE_ID = "307242360", CAMPO = "representante", APLICAR = process.argv.includes("--aplicar"), SEM = "Sem representante";
const gql = async (query, variables) => { const r = await fetch("https://api.pipefy.com/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + T }, body: JSON.stringify({ query, variables }) }); const j = await r.json(); if (j.errors) throw new Error(j.errors.map(e => e.message).join("; ")); return j.data; };
const cards = async v => { let c = null, t = []; for (;;) { const d = await gql(`query($p:ID!,$c:String!,$v:String!,$a:String){ findCards(pipeId:$p, search:{fieldId:$c, fieldValue:$v}, first:50, after:$a){ edges{ node{ id title } } pageInfo{ hasNextPage endCursor } } }`, { p: PIPE_ID, c: CAMPO, v, a: c }); t = t.concat(d.findCards.edges.map(e => e.node)); if (!d.findCards.pageInfo.hasNextPage) break; c = d.findCards.pageInfo.endCursor; } return t; };
(async () => {
  limparCache();
  const campo = (await gql(`query($id:ID!){ pipe(id:$id){ start_form_fields{ id uuid label options } } }`, { id: PIPE_ID })).pipe.start_form_fields.find(f => f.id === CAMPO);
  const reps = await sbSistemasService("/comercial_representantes_bmax?select=id,nome,ativo"); const porId = new Map(reps.map(r => [r.id, r]));
  const esperados = new Map(); reps.filter(r => r.ativo).forEach(r => esperados.set(norm(r.nome), r.nome)); esperados.set(norm(SEM), SEM);
  const opcoes = campo.options; const exato = o => [...esperados.values()].includes(o);
  const legado = opcoes.filter(o => !exato(o)); const faltam = [...esperados.values()].filter(n => !opcoes.includes(n));
  const itens = [];
  for (const o of legado) { let alvo = esperados.get(norm(o)) || null; if (!alvo) { const c = await codigoDe(o, "representante"); const r = c.representante_id && porId.get(c.representante_id); if (r && r.ativo) alvo = r.nome; } itens.push({ antiga: o, alvo, cards: await cards(o) }); }
  const renomear = itens.filter(i => i.alvo && i.cards.length), manter = itens.filter(i => !i.alvo && i.cards.length), remover = itens.filter(i => !i.cards.length);
  console.log(`opções: ${opcoes.length} | corretas: ${esperados.size} | antigas: ${legado.length} | faltam: ${faltam.length} (${faltam.join(", ")})`);
  console.log("RENOMEAR CARDS:", renomear.map(i => `${i.antiga} -> ${i.alvo} (${i.cards.length})`).join(" | ") || "nenhum");
  console.log("FICAM (sem representante no cadastro e COM cards):", manter.map(i => `${i.antiga} (${i.cards.length}: ${i.cards.slice(0, 2).map(c => c.title).join("; ")})`).join(" | ") || "nenhuma");
  console.log(`REMOVER (sem card): ${remover.length} -> ${remover.map(i => i.antiga).join(" | ")}`);
  if (!APLICAR) return;
  fs.writeFileSync(path.resolve(ROOT, "../Documentação/Backups_Banco/pipefy_crm_representante_ANTES_24-11-2026.json"), JSON.stringify({ opcoes, renomear: renomear.map(i => ({ antiga: i.antiga, alvo: i.alvo, cards: i.cards })) }, null, 1));
  const set = l => gql(`mutation($id:ID!,$uuid:ID!,$label:String!,$options:[String]){ updatePhaseField(input:{id:$id, uuid:$uuid, label:$label, options:$options}){ phase_field{ id } } }`, { id: CAMPO, uuid: campo.uuid, label: campo.label, options: l });
  const atuais = [...opcoes, ...faltam]; if (faltam.length) await set(atuais);
  for (const i of renomear) for (const c of i.cards) await gql(`mutation($c:ID!,$f:ID!,$v:[UndefinedInput]){ updateCardField(input:{card_id:$c, field_id:$f, new_value:$v}){ success } }`, { c: c.id, f: CAMPO, v: i.alvo });
  const sair = []; for (const i of itens) { if (!i.alvo && i.cards.length) continue; if (!(await cards(i.antiga)).length) sair.push(i.antiga); }
  await set(atuais.filter(o => !sair.includes(o))); console.log("removidas:", sair.length, "| renomeados:", renomear.reduce((s, i) => s + i.cards.length, 0));
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
