// Renomeia TODOS os cards de uma opção (ou mais) de um campo de seleção do CRM BOXER SOLDAS para outra opção existente e tira as antigas da lista.
// Uso: node scripts/codigo-unico/pipefy_renomeia_opcao_crm.js <campo_id> "<destino>" "<antiga1>" ["<antiga2>" ...] [--aplicar]
const path = require("path"); const fs = require("fs"); const ROOT = path.resolve(__dirname, "../.."); process.chdir(ROOT); require("dotenv").config({ quiet: true });
const T = process.env.PIPEFY_TOKEN_ADMIN, PIPE_ID = "307242360"; const args = process.argv.slice(2).filter(a => a !== "--aplicar"); const APLICAR = process.argv.includes("--aplicar");
const [CAMPO, DESTINO, ...ANTIGAS] = args;
const gql = async (query, variables) => { const r = await fetch("https://api.pipefy.com/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + T }, body: JSON.stringify({ query, variables }) }); const j = await r.json(); if (j.errors) throw new Error(j.errors.map(e => e.message).join("; ")); return j.data; };
const cards = async v => { let c = null, t = []; for (;;) { const d = await gql(`query($p:ID!,$c:String!,$v:String!,$a:String){ findCards(pipeId:$p, search:{fieldId:$c, fieldValue:$v}, first:50, after:$a){ edges{ node{ id title } } pageInfo{ hasNextPage endCursor } } }`, { p: PIPE_ID, c: CAMPO, v, a: c }); t = t.concat(d.findCards.edges.map(e => e.node)); if (!d.findCards.pageInfo.hasNextPage) break; c = d.findCards.pageInfo.endCursor; } return t; };
(async () => {
  const campo = (await gql(`query($id:ID!){ pipe(id:$id){ start_form_fields{ id uuid label options } } }`, { id: PIPE_ID })).pipe.start_form_fields.find(f => f.id === CAMPO);
  if (!campo.options.includes(DESTINO)) throw new Error(`destino "${DESTINO}" não existe na lista do campo`);
  const mapa = new Map(); for (const a of ANTIGAS) for (const c of await cards(a)) mapa.set(c.id, c);   // as grafias (D. Soldas / D. SOLDAS) acham os mesmos cards
  console.log(`${mapa.size} cards -> "${DESTINO}":`, [...mapa.values()].map(c => c.title).join("; "));
  if (!APLICAR) return;
  fs.writeFileSync(path.resolve(ROOT, `../Documentação/Backups_Banco/pipefy_${CAMPO}_renomeia_ANTES_24-11-2026.json`), JSON.stringify({ campo: CAMPO, destino: DESTINO, antigas: ANTIGAS, cards: [...mapa.values()], opcoes: campo.options }, null, 1));
  for (const c of mapa.values()) await gql(`mutation($c:ID!,$f:ID!,$v:[UndefinedInput]){ updateCardField(input:{card_id:$c, field_id:$f, new_value:$v}){ success } }`, { c: c.id, f: CAMPO, v: DESTINO });
  const sair = []; for (const a of ANTIGAS) if (!(await cards(a)).length) sair.push(a); else console.log("ainda tem card:", a);
  if (sair.length) await gql(`mutation($id:ID!,$uuid:ID!,$label:String!,$options:[String]){ updatePhaseField(input:{id:$id, uuid:$uuid, label:$label, options:$options}){ phase_field{ id } } }`, { id: CAMPO, uuid: campo.uuid, label: campo.label, options: campo.options.filter(o => !sair.includes(o)) });
  console.log("removidas da lista:", sair);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
