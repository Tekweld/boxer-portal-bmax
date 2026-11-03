// Devolve o card Telha Fabrica (CNPJ 23.872.299/0001-70) ao PCI 12a que a revenda escolheu em 08/10/2026 e que o
// robô de 48h desfez. Simulação por padrão; --aplicar executa. Backup do estado atual em scripts/backups/.
require("dotenv").config({ quiet: true });
const fs = require("fs");
const l = require("../src/services/rd.leads.service");
const C = require("../src/config/constants");
const { registrarAssumido, buscarDataAssumidoNaAuditoria } = require("../src/services/pci12Tracking.service");

const DEAL = "6abc56b04e38b80001ad9877";
const aplicar = process.argv.includes("--aplicar");
const T = process.env.RD_CRM_TOKEN;
const rd = async (p, m = "GET", b) => {
  const r = await fetch(`https://crm.rdstation.com/api/v1${p}${p.includes("?") ? "&" : "?"}token=${T}`, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
};

(async () => {
  const deal = await l.getDealById(DEAL);
  const tarefas = (await rd(`/tasks?deal_id=${DEAL}&limit=50`)).tasks || [];
  const prazo = tarefas.find(t => (t.subject || t.name) === "Prazo de 48h expirou" && !t.done);
  const quando = await buscarDataAssumidoNaAuditoria(DEAL);
  console.log("antes:", { pci: l.getCustomField(deal, "PERFIL PCI"), dono: deal.user && deal.user.name, etapa: deal.deal_stage && deal.deal_stage.name, tarefaPrazoAberta: !!prazo, escolheuEm: quando });
  fs.mkdirSync(__dirname + "/backups", { recursive: true });
  fs.writeFileSync(__dirname + "/backups/telha-fabrica-3-11-2026.json", JSON.stringify({ deal, tarefas }, null, 1));
  if (!aplicar) return console.log("SIMULAÇÃO: voltaria PCI 12a, dono Revenda, encerraria a tarefa 'Prazo de 48h expirou' e registraria o prazo de 60 dias. Use --aplicar.");

  await l.updateLead(DEAL, { data: { owner_id: `${C.RD_OWNERS["Revenda"]}`, custom_fields: { "perfil-pci": "PCI 12a" } } });
  if (prazo) await rd(`/tasks/${prazo._id || prazo.id}`, "PUT", { task: { done: true } });
  await registrarAssumido(DEAL, quando);
  const dep = await l.getDealById(DEAL);
  console.log("depois:", { pci: l.getCustomField(dep, "PERFIL PCI"), dono: dep.user && dep.user.name, etapa: dep.deal_stage && dep.deal_stage.name });
  process.exit(0);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
