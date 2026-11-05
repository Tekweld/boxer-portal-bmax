// SIMULAÇÃO SOMENTE LEITURA do fechamento automático de venda por NF (fase 2). Não escreve no RD, ZEN nem banco.
// Uso: node scripts/simulacao-cashback-nf-5-11-2026.js <.env com ZEN_EMAIL/ZEN_SENHA> [saida.xlsx]
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
for (const linha of fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/)) { const m = linha.match(/^(ZEN_[A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const ExcelJS = require("exceljs");
const { simular } = require("../src/services/cashbackNf.service");
const SAIDA = process.argv[3] || path.join(__dirname, "..", "..", "Documentação", "Simulacao_fechamento_por_NF_05-11-2026.xlsx");
(async () => {
  const r = await simular();
  console.log("candidatos:", r.candidatos, JSON.stringify(r.resumo));
  const wb = new ExcelJS.Workbook();
  const cols = [["Decisão", "decisao", 12], ["Motivo / alertas", "motivo", 46], ["Cliente (RD)", "nome", 34], ["CNPJ", "cnpj", 16], ["Revenda", "revenda", 22], ["PCI", "pci", 8], ["Classe", "classe", 7], ["Etapa atual", "etapa", 16], ["Valor atual no card", "valorAtual", 16], ["Valor das NFs", "valorNf", 14], ["Cashback estimado (total)", "cashbackEstimado", 18], ["NFs", "notas", 60], ["Ação planejada", "acao", 70], ["Card criado em", "criadoEm", 12], ["Responsável RD", "responsavel", 18], ["Deal id", "dealId", 26]];
  const ws = wb.addWorksheet("Simulação"); ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
  const ordem = { FECHARIA: 0, REVISAR: 1, ERRO: 2, AGUARDAR: 3 };
  r.lista.sort((a, b) => (ordem[a.decisao] ?? 9) - (ordem[b.decisao] ?? 9)).forEach(x => ws.addRow(x));
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D327B" } };
  ws.views = [{ state: "frozen", ySplit: 1 }]; ws.autoFilter = { from: "A1", to: ws.getRow(1).getCell(cols.length).address };
  ["valorAtual", "valorNf", "cashbackEstimado"].forEach(k => { ws.getColumn(k).numFmt = "#,##0.00"; });
  const rs = wb.addWorksheet("Resumo");
  rs.columns = [{ header: "Decisão", key: "k", width: 50 }, { header: "Cards", key: "n", width: 10 }];
  const legenda = { FECHARIA: "FECHARIA = NF com tag bmax, PCI e Classe ok: seria fechado automaticamente", REVISAR: "REVISAR = NF sem tag, várias notas, sem Classe, sem regra ou CNPJ inválido: humano decide", AGUARDAR: "AGUARDAR = ainda sem NF do cliente (normal)", ERRO: "ERRO = falha ao consultar o ZEN" };
  Object.entries(r.resumo).forEach(([k, n]) => rs.addRow({ k: legenda[k] || k, n }));
  await wb.xlsx.writeFile(SAIDA);
  console.log("gravado:", SAIDA);
  r.lista.filter(x => x.decisao === "FECHARIA" || x.decisao === "REVISAR").slice(0, 30).forEach(x => console.log(x.decisao, "|", x.nome, "|", x.revenda, "|", x.pci, "cl", x.classe || "-", "| NF R$", x.valorNf, "|", x.motivo));
  process.exit(0);
})().catch(e => { console.error("ERRO", e.stack || e.message); process.exit(1); });
