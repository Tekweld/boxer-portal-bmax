const A = require("./auditorCards.service");

describe("normalização dos campos", () => {
    test("PCI: tira espaço e maiúscula; 'Sem PCI' e vazio contam como não preenchido", () => {
        expect(A.pciKey("PCI 12a")).toBe("PCI12A");
        expect(A.pciKey("PCI X")).toBe("PCIX");
        for (const v of ["", "Sem PCI", "sem pci", null, undefined, "  "]) expect(A.pciKey(v)).toBe("");
    });
    test("Classe: só o número; 'Sem Classe' e vazio contam como não preenchido", () => {
        expect(A.classeKey("Classe 6")).toBe("6");
        for (const v of ["", "Sem Classe", "sem classe", null]) expect(A.classeKey(v)).toBe("");
    });
    test("Produto: Máquinas/Laser/Robô com e sem acento; 'Não se aplica' não dá para julgar", () => {
        expect(A.produtoKey("Máquinas")).toBe("maquinas");
        expect(A.produtoKey("Laser")).toBe("laser");
        expect(A.produtoKey("Robo")).toBe("robo");
        expect(A.produtoKey("Robô")).toBe("robo");
        for (const v of ["", "Não se aplica", null]) expect(A.produtoKey(v)).toBe("");
    });
});

describe("venda sem dados", () => {
    const completo = { pci: "PCI 6", segmento: "Laser", classe: "Classe 3", revenda: "Luitex Sumaré", representante: "Victor VLM" };
    test("tudo preenchido: nada falta", () => expect(A.camposFaltandoNaVenda(completo)).toEqual([]));
    test("aponta PCI, produto e classe vazios (incluindo os neutros 'Sem PCI'/'Sem Classe')", () => {
        expect(A.camposFaltandoNaVenda({ ...completo, pci: "Sem PCI", segmento: "", classe: "Sem Classe" })).toEqual(["PCI", "Produto (segmento)", "Classe de preço"]);
    });
    test("revenda e representante em branco ou '?????' contam como falta", () => {
        expect(A.camposFaltandoNaVenda({ ...completo, revenda: "?????", representante: "" })).toEqual(["Revenda", "Representante"]);
    });
    test("'Sem Revenda' e 'N/D' (representante) são respostas válidas, não falta", () => {
        expect(A.camposFaltandoNaVenda({ ...completo, revenda: "Sem Revenda", representante: "N/D" })).toEqual([]);
    });
    test("revenda 'N/D' é inválida (não é opção de revenda)", () => {
        expect(A.camposFaltandoNaVenda({ ...completo, revenda: "N/D" })).toEqual(["Revenda"]);
    });
});

describe("PCI incompatível com o produto", () => {
    test("PCI de Robô com produto Laser é incompatível; PCI de Laser com Laser está certo", () => {
        expect(A.pciIncompativelComProduto({ pci: "PCI 13", segmento: "Laser" })).toEqual({ esperado: "robo", encontrado: "laser", origem: "segmento" });
        expect(A.pciIncompativelComProduto({ pci: "PCI 14", segmento: "Laser" })).toBeNull();
    });
    test("12, 12a, 12b e 15 são de Máquinas", () => {
        for (const p of ["PCI 12", "PCI 12a", "PCI 12b", "PCI 15", "PCI 7", "PCI 11"]) expect(A.pciIncompativelComProduto({ pci: p, segmento: "Máquinas" })).toBeNull();
        expect(A.pciIncompativelComProduto({ pci: "PCI 12a", segmento: "Laser" })).not.toBeNull();
    });
    test("PCI16, PCI X, sem PCI e sem produto: não dá para julgar, nunca acusa", () => {
        expect(A.pciIncompativelComProduto({ pci: "PCI 16", segmento: "Laser" })).toBeNull();
        expect(A.pciIncompativelComProduto({ pci: "PCI X", segmento: "Robô" })).toBeNull();
        expect(A.pciIncompativelComProduto({ pci: "Sem PCI", segmento: "Laser" })).toBeNull();
        expect(A.pciIncompativelComProduto({ pci: "PCI 6", segmento: "Não se aplica", maquina: "" })).toBeNull();
    });
    test("sem produto no card, usa a máquina de interesse só como indício (origem 'maquina')", () => {
        expect(A.pciIncompativelComProduto({ pci: "PCI 9", segmento: "", maquina: "LQ 1250" })).toEqual({ esperado: "maquinas", encontrado: "laser", origem: "maquina" });
        expect(A.pciIncompativelComProduto({ pci: "PCI 9", segmento: "", maquina: "Hardmig 450" })).toBeNull();
    });
    test("com produto no card, a máquina de interesse é ignorada", () => {
        expect(A.pciIncompativelComProduto({ pci: "PCI 9", segmento: "Máquinas", maquina: "LQ 1250" })).toBeNull();
    });
});

describe("mudança significativa de campos", () => {
    const base = { pci: "PCI6", produto: "laser", classe: "3" };
    test("sem alteração: nada", () => expect(A.diffCampos(base, { ...base })).toEqual([]));
    test("PCI, produto e classe trocados são mudanças", () => {
        expect(A.diffCampos(base, { pci: "PCI9", produto: "maquinas", classe: "5" }).map(m => m.campo)).toEqual(["pci", "produto", "classe"]);
    });
    test("campo preenchido que foi apagado é mudança", () => {
        expect(A.diffCampos(base, { ...base, classe: "" })).toEqual([{ campo: "classe", de: "3", para: "" }]);
    });
    test("vazio -> preenchido é preenchimento normal, não mudança", () => {
        expect(A.diffCampos({ pci: "", produto: "", classe: "" }, base)).toEqual([]);
    });
    test("PCI12 -> PCI12A/PCI12B (decisão da revenda ou robô de 48h) é normal", () => {
        expect(A.diffCampos({ ...base, pci: "PCI12" }, { ...base, pci: "PCI12A" })).toEqual([]);
        expect(A.diffCampos({ ...base, pci: "PCI12" }, { ...base, pci: "PCI12B" })).toEqual([]);
        expect(A.diffCampos({ ...base, pci: "PCI12A" }, { ...base, pci: "PCI12B" }).length).toBe(1);   // trocar 12a por 12b NÃO é normal
    });
});

describe("PCI12a sem resposta, por revenda e representante", () => {
    test("sem andamento, ou último status Pendente/Sem retorno, é sem resposta", () => {
        expect(A.semRespostaDaRevenda(null)).toBe(true);
        expect(A.semRespostaDaRevenda({ tipo: "status", status: "Pendente" })).toBe(true);
        expect(A.semRespostaDaRevenda({ tipo: "status", status: "Sem retorno" })).toBe(true);
    });
    test("quem já informou andamento de verdade respondeu", () => {
        expect(A.semRespostaDaRevenda({ tipo: "status", status: "Em contato" })).toBe(false);
        expect(A.semRespostaDaRevenda({ tipo: "perda", status: null })).toBe(false);
    });
    test("agrupa por revenda com contagem por representante e o card mais antigo, maior primeiro", () => {
        const g = A.agruparSemResposta([
            { id: "1", nome: "A", revenda: "Luitex Sumaré", representante: "Victor VLM", dias: 10 },
            { id: "2", nome: "B", revenda: "Luitex Sumaré", representante: "Victor VLM", dias: 38 },
            { id: "3", nome: "C", revenda: "Luitex Sumaré", representante: "Caio P Mancini", dias: 5 },
            { id: "4", nome: "D", revenda: "WST", representante: "", dias: 50 },
        ]);
        expect(g.map(x => x.revenda)).toEqual(["Luitex Sumaré", "WST"]);
        expect(g[0]).toMatchObject({ total: 3, maisAntigoDias: 38, representantes: { "Victor VLM": 2, "Caio P Mancini": 1 } });
        expect(g[1].representantes).toEqual({ "(sem representante)": 1 });
    });
});
