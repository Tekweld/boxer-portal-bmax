// Quem pode ver cada PCI no Portal (planilha mestre BMAX CRITERIOS, linha "PORTAL BMAX - perfis que devem ver o Lead", confirmado pelo André em 25/11/2026).
//   TODOS (admin + representante + revenda): PCI 6, 9, 12b, 13, 14, 15      -> aqui também PCI 12 (revenda escolhe o caminho), PCI 12a (é da revenda) e PCI X
//   ADM + REP:                                PCI 2, 3, 5, 8, 11
//   SÓ ADMIN:                                 PCI 1, 4, 7, 10 (e 16)
//   Lead SEM PCI preenchido: só admin/representante/funcionário — nunca a revenda.
// Admin e funcionário veem tudo. Esta é a ÚNICA fonte da regra: painel, exportação, resumo de WhatsApp e o agente auditor usam este módulo.
const norm = p => String(p || "").replace(/\s/g, "").toUpperCase();
const SEM_PCI = new Set(["", "SEMPCI", "N/D", "?????"]);
// PCI 3 (lead Boxer de venda de Robô) a revenda VÊ por transparência (25/11/2026), mas ele NÃO gera cashback para ela.
const REVENDA_VE = new Set(["PCI3", "PCI6", "PCI9", "PCI12", "PCI12A", "PCI12B", "PCI13", "PCI14", "PCI15", "PCIX"]);
const REP_VE = new Set([...REVENDA_VE, "PCI2", "PCI5", "PCI8", "PCI11"]);
// A COMISSÃO é decidida pelo PCI (não por quem aparece no card): só estes PCIs geram cashback para a revenda (política PCI x Classe).
const REVENDA_RECEBE_COMISSAO = new Set(["PCI6", "PCI9", "PCI12B", "PCI13", "PCI14", "PCI15"]);
const semCashbackParaRevenda = pci => norm(pci) === "PCI3";   // visível, mas sinalizado: "lead Boxer, não gera cashback"


function podeVerPci(role, pci) {
    if (role === "revenda") return REVENDA_VE.has(norm(pci));          // sem PCI fica de fora
    if (role === "representante") return SEM_PCI.has(norm(pci)) || REP_VE.has(norm(pci));
    return true;                                                       // admin / funcionário
}

module.exports = { podeVerPci, REVENDA_VE, REP_VE, REVENDA_RECEBE_COMISSAO, semCashbackParaRevenda, norm };
