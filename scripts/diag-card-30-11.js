// Diagnóstico somente leitura de um card do RD (uso: node scripts/diag-card-30-11.js <cnpj-formatado>)
require("dotenv").config({ quiet: true });
const T = process.env.RD_CRM_TOKEN;
const g = async p => (await fetch(`https://crm.rdstation.com/api/v1${p}${p.includes("?") ? "&" : "?"}token=${T}`)).json();
(async () => {
  const cnpj = process.argv[2];
  let achados = [];
  for (let page = 1; page <= 60 && !achados.length; page++) {
    const r = await g(`/deals?limit=200&page=${page}`);
    const ds = r.deals || [];
    if (!ds.length) break;
    achados = ds.filter(d => JSON.stringify(d.deal_custom_fields || []).includes(cnpj));
  }
  for (const d of achados) {
    const id = d._id || d.id;
    const cf = {}; (d.deal_custom_fields || []).forEach(f => { cf[f.custom_field && f.custom_field.label || f.custom_field_id] = f.value; });
    console.log("=== DEAL", id, "|", d.name);
    console.log("pipeline:", d.deal_stage && d.deal_stage.name, "| owner:", d.user && d.user.name, "| criado:", d.created_at, "| atualizado:", d.updated_at, "| win:", d.win, "| prediction", d.prediction_date);
    console.log("campos:", JSON.stringify(cf));
    const t = await g(`/tasks?deal_id=${id}&limit=50`);
    console.log("tarefas:", JSON.stringify((t.tasks || []).map(x => ({ n: x.subject || x.name, notes: (x.notes || "").slice(0, 120), done: x.done, date: x.date, users: (x.users || []).map(u => u.name), created: x.created_at }))));
    const a = await g(`/activities?deal_id=${id}&limit=50`);
    console.log("atividades:", JSON.stringify((a.activities || []).map(x => ({ t: x.type, text: String(x.text || "").slice(0, 140), u: x.user && x.user.name, at: x.created_at }))));
  }
  if (!achados.length) console.log("nao achou nas 60 paginas");
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
