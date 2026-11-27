// SOMENTE LEITURA. Lista os cards de venda do Portal BMax que NÃO bateram com a nota do ZEN (sem nota, valor acima de 1%, produto diferente),
// usando a mesma checagem do auditor diário. Uso: node scripts/lista-cards-sem-bater-zen-27-11-2026.js "../bmax-motor/.env" [saida.xlsx]
require("dotenv").config({ quiet: true });
// O CRM é o PIPEFY (desde 23/11/2026). Sem isto o Portal cai no padrão "rd" e lê o RD antigo (ids hex, dados parados).
process.env.CRM_PROVIDER = "pipefy";
process.env.PIPEFY_TOKEN = process.env.PIPEFY_TOKEN || process.env.PIPEFY_TOKEN_ADMIN || "";
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
for (const l of fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/)) { const m = l.match(/^(ZEN_[A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const SAIDA = process.argv[3] || path.join(__dirname, "..", "..", "Documentação", "Cards_sem_bater_com_NF_ZEN_27-11-2026.xlsx");
const A = require("../src/services/auditor.service");
const rd = require("../src/services/rd.leads.service");

(async () => {
  const cards = (await rd.getLeads("admin", "adm")).map(d => ({
    id: String(d.id || d._id), nome: d.name, pci: rd.getCustomField(d, "PERFIL PCI"), revenda: rd.getCustomField(d, "REVENDA/LOJA"), representante: rd.getCustomField(d, "REPRESENTANTE"),
    responsavel: d.user && d.user.name || "", valor: Number(d.amount_total || 0), etapaId: d.deal_stage && d.deal_stage.id, cnpj: String(rd.getCustomField(d, "CNPJ") || "").replace(/\D/g, ""),
    maquina: rd.getCustomField(d, "MÁQUINA DE INTERESSE"), segmento: rd.getCustomField(d, "SEGMENTO DE PRODUTO"), criadoEm: d.created_at, fechadoEm: d.closed_at || d.updated_at }));
  const porId = new Map(cards.map(c => [c.id, c]));
  const ctx = { dryRun: true, avisos: [], cards: async () => cards, zen: require("../src/services/zenNf.service") };
  const achados = await A.checarVendasZen(ctx);
  const nomes = { venda_sem_nota_zen: "Sem nota no ZEN", venda_valor_zen: "Valor diferente (mais de 1%)", venda_produto_zen: "Produto diferente" };
  const linhas = achados.map(a => {
    const c = porId.get(a.detalhe.card) || {}, d = a.detalhe;
    return { problema: nomes[a.checagem], gravidade: a.severidade, cliente: d.nome, cnpj: d.cnpj, valorCard: d.valorCard, fechado: d.fechadoEm, pci: c.pci || "", revenda: d.revenda || "", representante: c.representante || "", responsavel: d.responsavel,
      maquinaCard: c.maquina || "", nota: d.nota || "", notaData: d.notaData || "", valorNota: d.notaTotal != null ? d.notaTotal : "", diferenca: d.diferenca != null ? d.diferenca : "", pct: d.pct != null ? d.pct : "", valorSugerido: d.valorSugerido != null ? d.valorSugerido : "",
      itensNota: (d.itens || []).join("; "), oQueFazer: a.acao, link: a.link || "", card: d.card };
  }).sort((x, y) => String(x.problema).localeCompare(String(y.problema)) || String(y.valorCard).localeCompare(String(x.valorCard), undefined, { numeric: true }));
  const wb = new ExcelJS.Workbook();
  const colunas = [["Problema", "problema", 26], ["Gravidade", "gravidade", 10], ["Cliente", "cliente", 38], ["CNPJ", "cnpj", 17], ["Valor no card", "valorCard", 14], ["Fechado em", "fechado", 11], ["PCI", "pci", 9], ["Revenda", "revenda", 18], ["Representante", "representante", 16], ["Responsável", "responsavel", 18],
    ["Máquina no card", "maquinaCard", 24], ["NF do ZEN", "nota", 10], ["Data da NF", "notaData", 11], ["Valor da NF", "valorNota", 14], ["Diferença (R$)", "diferenca", 14], ["Diferença (%)", "pct", 11], ["Valor sugerido", "valorSugerido", 14], ["Itens da NF", "itensNota", 50], ["O que fazer", "oQueFazer", 60], ["Link do card", "link", 38], ["ID do card", "card", 13]];
  const aba = (nome, lista) => {
    const ws = wb.addWorksheet(nome);
    ws.columns = colunas.map(([header, key, width]) => ({ header, key, width }));
    lista.forEach(r => { const row = ws.addRow(r); if (r.link) row.getCell("link").value = { text: "abrir no Pipefy", hyperlink: r.link }; });
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D327B" } };
    ws.views = [{ state: "frozen", ySplit: 1 }]; ws.autoFilter = { from: "A1", to: ws.getRow(1).getCell(colunas.length).address };
    ["valorCard", "valorNota", "diferenca", "valorSugerido"].forEach(k => { ws.getColumn(k).numFmt = "#,##0.00"; }); ws.getColumn("pct").numFmt = "0.0%";
  };
  const resumo = wb.addWorksheet("Resumo");
  resumo.columns = [{ header: "Problema", key: "k", width: 40 }, { header: "Cards", key: "n", width: 10 }, { header: "Valor dos cards (R$)", key: "v", width: 22 }];
  const cont = {}; linhas.forEach(l => { const c = cont[l.problema] = cont[l.problema] || { n: 0, v: 0 }; c.n++; c.v += Number(l.valorCard) || 0; });
  Object.entries(cont).forEach(([k, c]) => resumo.addRow({ k, n: c.n, v: c.v })); resumo.getRow(1).font = { bold: true }; resumo.getColumn("v").numFmt = "#,##0.00";
  const vendaStages = new Set([require("../src/config/constants").RD_STAGE_VENDIDO, require("../src/config/constants").RD_STAGE_VENDA_EFETIVADA, require("../src/config/constants").RD_STAGE_ENTREGA_TECNICA]);
  const universo = cards.filter(c => vendaStages.has(c.etapaId) && c.valor > 0 && !/teste/i.test(c.nome || "")).length;
  resumo.addRow({}); resumo.addRow({ k: "Regras: todas as vendas do escopo do Portal; nota no mesmo CNPJ; valor aceito até 1% de diferença; soma de 2 a 6 notas; produto pela família da máquina e Tabela BMax. Cards de teste e PCI12a ficam de fora." });
  aba("Todos", linhas);
  for (const n of Object.values(nomes)) aba(n, linhas.filter(l => l.problema === n));
  await wb.xlsx.writeFile(SAIDA);
  console.log("cards de venda no escopo (sem teste):", universo, "| com problema:", linhas.length, JSON.stringify(cont));
  console.log("planilha:", SAIDA);
  process.exit(0);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
