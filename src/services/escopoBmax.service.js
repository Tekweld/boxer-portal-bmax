// Escopo do Portal BMax — quais leads PODEM aparecer (e, por consequência, gerar
// cashback). Regra do André (08/10/2026): "só calculamos cashback de cards/leads
// que são visíveis no portal". Por isso o filtro vive em getLeads(), a fonte única
// de cards, export, recálculo de comissão e crédito retroativo.
//
// Fica FORA do Portal:
//  1) Consumíveis — "Máquina de interesse" com o texto "consum".
//  2) Produto que NÃO é da linha BMax — o texto cita um produto conhecido de fora
//     da Tabela de Preços BMax (boxer-sistemas, tabela id=2 "Automação") e não cita
//     nenhuma família BMax.
// Na dúvida o lead FICA: texto vazio, genérico ou abreviação desconhecida nunca
// esconde nada (esconder também derruba o cashback, então o erro caro é esconder
// errado, não mostrar a mais).
//
// Reforço pelo campo "Segmento de produto" (RD: Laser / Máquinas / Robô — não existe
// valor "consumível"): Laser ou Robô são sempre BMax, então protegem o lead de ser
// escondido pela regra 2. "Máquinas" NÃO protege, porque o Portal preenche esse valor
// sozinho ao definir caminho PCI12 (caminhoVenda.service.js), mesmo p/ não-BMax.
//
// O time escreve texto livre e abreviado ("hard450", "160 mig flex", "LQ 1250"). A
// comparação é feita no texto COMPACTADO (sem acento, espaço, hífen ou pontuação) e
// com apelidos de abreviação para as famílias da tabela.
//
// Famílias BMax = modelos da Tabela de Preços BMax (consulta de 08/10/2026):
// DURAMAX, HARDMIG, TIGON, ALUTIG, Q25, HARDCUT, ALUMIG/M500 (mig duplo pulsado),
// RM/B500 (robôs e fontes), LQ (laser) + acessórios dessas linhas.
// Para incluir/excluir um produto, edite APENAS as listas abaixo.

// Padrões sobre o texto compactado (ex.: "hard 450" -> "hard450").
const FAMILIAS_BMAX = [
    "duramax", "dura\\d",                 // Duramax 326 / dura326
    "hardmig", "hardcut", "hard\\d",      // hard450 = Hardmig 450 (Hardcut sempre vem escrito)
    "tigon", "alutig", "alumig", "alu\\d", "m500", "q25",
    "b500", "rm\\d", "lq\\d", "laser",
    "robo", "robot", "cabecote", "posicionador", "troly", "chiller", "rtb"
];

// Produtos que o time cadastra no RD mas NÃO estão na Tabela de Preços BMax.
const FORA_DA_TABELA_BMAX = [
    "migflex", "optiarc", "flama", "spectra", "mascara", "regulador",
    "tochamig", "bancodecarga"
];

const SEGMENTOS_SEMPRE_BMAX = ["laser", "robo"];

function compactar(txt) {
    return String(txt || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const reBmax = new RegExp(FAMILIAS_BMAX.join("|"));
const reFora = new RegExp(FORA_DA_TABELA_BMAX.join("|"));

const ehPciXTxt = pci => compactar(pci) === "pcix";

// MÓDULO PCI X: PREPARADO, MAS DESLIGADO (André, 26/11/2026). Só liga com PCIX_ATIVO=1 na Vercel, depois que o agente que grava o PCI certo
// no Pipefy existir. Desligado, o escopo funciona exatamente como antes (produto fora da tabela BMax fica fora do Portal, com ou sem PCI X).
const pcixAtivo = () => process.env.PCIX_ATIVO === "1";
const PCIX_CORTE = "2026-11-23";   // só vale para card criado a partir desta data e ainda em aberto (nada vendido nem perdido)
// Devolve "PCI X" se o card pode usar a liberação do PCI X; senão "". aberto = false para vendido/perdido.
function pciParaEscopo(pci, criadoEm, aberto) {
    if (!pcixAtivo() || !ehPciXTxt(pci) || !aberto || !criadoEm) return pci && !ehPciXTxt(pci) ? pci : "";
    return String(criadoEm).slice(0, 10) >= PCIX_CORTE ? "PCI X" : "";
}

// Retorna null (dentro do escopo) ou o motivo pelo qual o lead fica fora.
// PCI X (26/11/2026): é exatamente o PCI do produto que NÃO é BMax (máquina fora da tabela e máscara), que a revenda vende do próprio
// estoque, sem cashback. Por isso o PCI X libera o "produto fora da tabela BMax", mas NUNCA o consumível (venda de consumível não é permitida).
function motivoForaDoEscopo(maquinaInteresse, segmentoProduto, pci) {
    const t = compactar(maquinaInteresse);
    if (!t) return null;
    if (t.includes("consum")) return "consumivel";
    if (reFora.test(t) && !reBmax.test(t) && !SEGMENTOS_SEMPRE_BMAX.includes(compactar(segmentoProduto)) && !(pcixAtivo() && ehPciXTxt(pci))) {
        return "produto_fora_da_tabela_bmax";
    }
    return null;
}

// Tipo do produto pelo texto da máquina de interesse, para conferir o PCI X: "bmax" (família BMax), "consumivel", "nao_bmax"
// (fora da tabela ou máscara) ou "" (vazio/genérico: não dá para julgar).
function tipoDoProduto(maquinaInteresse) {
    const t = compactar(maquinaInteresse);
    if (!t) return "";
    if (t.includes("consum")) return "consumivel";
    if (reBmax.test(t)) return "bmax";
    return reFora.test(t) ? "nao_bmax" : "";
}

module.exports = { motivoForaDoEscopo, tipoDoProduto, ehPciXTxt, pcixAtivo, pciParaEscopo, PCIX_CORTE, compactar, FAMILIAS_BMAX, FORA_DA_TABELA_BMAX };
