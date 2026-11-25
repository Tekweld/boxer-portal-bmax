// Regras PURAS (sem banco, sem CRM) das checagens de cards do Auditor diário. Cada função recebe valores já lidos do card e devolve a decisão,
// para ser testada isoladamente. A leitura dos cards e das tabelas fica em auditor.service.js.

const semAcento = s => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "");
const txt = s => String(s == null ? "" : s).trim();

// PCI como chave: "PCI 12a" -> "PCI12A"; "Sem PCI" e vazio -> "" (não preenchido)
function pciKey(raw) {
    const k = txt(raw).replace(/\s/g, "").toUpperCase();
    return !k || k === "SEMPCI" ? "" : k;
}
// Classe de preço como número: "Classe 6" -> "6"; "Sem Classe" e vazio -> ""
function classeKey(raw) {
    const t = semAcento(raw).toLowerCase();
    if (!t.trim() || /sem\s*classe/.test(t)) return "";
    return t.replace(/\D/g, "");
}
// Produto do card (campo "Segmento de produto"): maquinas | laser | robo. "Não se aplica"/vazio -> "" (não dá para julgar)
function produtoKey(raw) {
    const t = semAcento(raw).toLowerCase().trim();
    if (/^maquina/.test(t)) return "maquinas";
    if (/^laser/.test(t)) return "laser";
    if (/^robo/.test(t)) return "robo";
    return "";
}

// Produto esperado por PCI (Registro de 25/11, regra 4: Robô = 1,2,3,13; Laser = 4,5,6,14; Máquinas = 7 a 12b e 15).
// PCI16 (qualquer produto, lead da revenda) e PCI X (produto não BMax) não têm produto fixo e ficam de fora.
const PRODUTO_POR_PCI = {
    PCI1: "robo", PCI2: "robo", PCI3: "robo", PCI13: "robo",
    PCI4: "laser", PCI5: "laser", PCI6: "laser", PCI14: "laser",
    PCI7: "maquinas", PCI8: "maquinas", PCI9: "maquinas", PCI10: "maquinas", PCI11: "maquinas", PCI12: "maquinas", PCI12A: "maquinas", PCI12B: "maquinas", PCI15: "maquinas",
};
const ROTULO_PRODUTO = { maquinas: "Máquinas", laser: "Laser", robo: "Robô" };

// Texto livre da "Máquina de interesse" -> produto provável (só usado quando o segmento do card está vazio). Família LQ = laser; RM/robô = robô.
function produtoDaMaquina(textoLivre) {
    const t = semAcento(textoLivre).toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!t) return "";
    if (/laser|lq\d{3,4}/.test(t)) return "laser";
    if (/robo|cobot|colaborativ|rm\d{3,4}/.test(t)) return "robo";
    return "";
}

// Devolve { esperado, encontrado, origem } quando o PCI não combina com o produto do card; null quando combina ou não dá para julgar.
function pciIncompativelComProduto({ pci, segmento, maquina }) {
    const k = pciKey(pci);
    const esperado = PRODUTO_POR_PCI[k];
    if (!esperado) return null;
    const doSegmento = produtoKey(segmento);
    if (doSegmento) return doSegmento === esperado ? null : { esperado, encontrado: doSegmento, origem: "segmento" };
    const daMaquina = produtoDaMaquina(maquina);   // sem segmento: indício mais fraco
    return daMaquina && daMaquina !== esperado ? { esperado, encontrado: daMaquina, origem: "maquina" } : null;
}

// Venda concluída: o que falta preencher. "Sem Revenda" e "N/D" (representante) são respostas válidas ("não há"), não falta.
const REPRESENTANTE_NAO_PREENCHIDO = ["", "?????", "?", "Vazio"];
const REVENDA_NAO_PREENCHIDA = ["", "?????", "?", "Vazio", "N/D"];
function camposFaltandoNaVenda({ pci, segmento, classe, revenda, representante }) {
    const faltando = [];
    if (!pciKey(pci)) faltando.push("PCI");
    if (!produtoKey(segmento)) faltando.push("Produto (segmento)");
    if (!classeKey(classe)) faltando.push("Classe de preço");
    if (REVENDA_NAO_PREENCHIDA.includes(txt(revenda))) faltando.push("Revenda");
    if (REPRESENTANTE_NAO_PREENCHIDO.includes(txt(representante))) faltando.push("Representante");
    return faltando;
}

// Mudança significativa de PCI, produto ou classe entre o último retrato e agora.
//  - vazio -> preenchido é preenchimento normal: não é mudança.
//  - PCI12 (pendente) -> PCI12A/PCI12B é a decisão da revenda ou o robô de 48h: também normal.
// Valores aqui já normalizados (pciKey/produtoKey/classeKey).
function diffCampos(antes, agora) {
    const mudancas = [];
    for (const campo of ["pci", "produto", "classe"]) {
        const de = antes[campo] || "", para = agora[campo] || "";
        if (de === para || !de) continue;
        if (campo === "pci" && de === "PCI12" && (para === "PCI12A" || para === "PCI12B")) continue;
        mudancas.push({ campo, de, para });
    }
    return mudancas;
}
const ROTULO_CAMPO = { pci: "PCI", produto: "Produto", classe: "Classe de preço" };
const mostrarValor = (campo, v) => !v ? "(vazio)" : campo === "produto" ? (ROTULO_PRODUTO[v] || v) : campo === "classe" ? `Classe ${v}` : v;

// PCI12a em aberto sem resposta da revenda: nenhum andamento registrado, ou último status "Pendente"/"Sem retorno".
const STATUS_SEM_RESPOSTA = ["Pendente", "Sem retorno"];
function semRespostaDaRevenda(ultimoAndamento) {
    if (!ultimoAndamento) return true;
    return ultimoAndamento.tipo === "status" && STATUS_SEM_RESPOSTA.includes(ultimoAndamento.status);
}

// cards: [{ id, nome, revenda, representante, dias }] já filtrados (PCI12a, em aberto, sem resposta). Agrupa por revenda, com a contagem por
// representante, para a cobrança (quem cobrar e de quem).
function agruparSemResposta(cards) {
    const porRevenda = new Map();
    for (const c of cards) {
        const revenda = txt(c.revenda) || "(sem revenda)";
        const rep = txt(c.representante) || "(sem representante)";
        const g = porRevenda.get(revenda) || { revenda, total: 0, maisAntigoDias: 0, representantes: {}, cards: [] };
        g.total++;
        g.maisAntigoDias = Math.max(g.maisAntigoDias, c.dias || 0);
        g.representantes[rep] = (g.representantes[rep] || 0) + 1;
        g.cards.push({ id: c.id, nome: c.nome, dias: c.dias, representante: rep });
        porRevenda.set(revenda, g);
    }
    return [...porRevenda.values()].sort((a, b) => b.total - a.total || b.maisAntigoDias - a.maisAntigoDias);
}

module.exports = {
    pciKey, classeKey, produtoKey, produtoDaMaquina, PRODUTO_POR_PCI, ROTULO_PRODUTO, ROTULO_CAMPO, mostrarValor,
    pciIncompativelComProduto, camposFaltandoNaVenda, diffCampos, semRespostaDaRevenda, agruparSemResposta,
};
