process.env.SUPABASE_SERVICE_KEY_SISTEMAS = "teste";
const T = require("./termos.service");

describe("validações", () => {
    it("CNPJ e CPF com dígito verificador", () => {
        expect(T.cnpjValido("11.222.333/0001-81")).toBe(true);
        expect(T.cnpjValido("11222333000182")).toBe(false);
        expect(T.cnpjValido("11111111111111")).toBe(false);
        expect(T.cpfValido("529.982.247-25")).toBe(true);
        expect(T.cpfValido("52998224726")).toBe(false);
        expect(T.cpfValido("11111111111")).toBe(false);
    });
    it("CEP e formatação", () => {
        expect(T.cepValido("13874-439")).toBe(true);
        expect(T.cepValido("1387")).toBe(false);
        expect(T.fmtCep("13874439")).toBe("13874-439");
        expect(T.fmtCnpj("11222333000181")).toBe("11.222.333/0001-81");
    });
    it("loja: tudo obrigatório, mensagens por campo", () => {
        const v = T.validarLoja({}, "Loja A");
        expect(v.erros.length).toBeGreaterThanOrEqual(7);
        const ok = T.validarLoja({ razao_social: "Alphabras Ltda", cnpj: "11.222.333/0001-81", logradouro: "Rua A", numero: "10", bairro: "Centro", cep: "13874-439", cidade: "São João", estado: "sp" }, "Loja A");
        expect(ok.erros).toEqual([]);
        expect(ok.dados.cnpj).toBe("11222333000181");
        expect(ok.dados.cep).toBe("13874439");
        expect(ok.dados.estado).toBe("SP");
    });
});

describe("elegibilidade", () => {
    const loja = (o) => ({ nome: "L", classe: "Ouro", estado: "PR", mesorregiao_ibge: "X", ...o });
    it("Ouro exige classe Ouro", () => {
        expect(T.avaliarElegibilidade({ programa: "bpartner_ouro", lojas: [loja()] }).ok).toBe(true);
        expect(T.avaliarElegibilidade({ programa: "bpartner_ouro", lojas: [loja({ classe: "Prata" })] }).ok).toBe(false);
    });
    it("Diamante: Ouro ou já Diamante, fora de SP, mesma classe", () => {
        expect(T.avaliarElegibilidade({ programa: "bpartner_diamante", lojas: [loja()] }).ok).toBe(true);
        expect(T.avaliarElegibilidade({ programa: "bpartner_diamante", lojas: [loja({ classe: "Prata" })] }).ok).toBe(false);
        expect(T.avaliarElegibilidade({ programa: "bpartner_diamante", lojas: [loja({ estado: "SP" })] }).ok).toBe(false);
        expect(T.avaliarElegibilidade({ programa: "bpartner_diamante", lojas: [loja(), loja({ classe: "Diamante" })] }).ok).toBe(false);
    });
    it("sem checagem de exclusividade por mesorregião", () => {
        const r = T.avaliarElegibilidade({ programa: "bpartner_diamante", lojas: [loja()] });
        expect(JSON.stringify(r)).not.toMatch(/exclusiv/i);
    });
});

describe("texto do termo", () => {
    const corpo = { titulo: "Termo", clausulas: [{ titulo: "Objeto", texto: "Grupo {{grupo}} nível {{nivel}}.{{lojas}}" }] };
    it("preenche grupo, nível e lojas (informadas > cadastro) e o hash muda com os dados", () => {
        const lojasCad = [{ cad_nome: "Loja 1", cad_cnpj: "11222333000181", cad_endereco: "Rua X, 1", cad_cep: "13874439", cad_cidade: "SJBV", cad_estado: "SP" }];
        const a = T.renderTexto(corpo, { grupo: "G", programa: "bpartner_ouro", lojas: lojasCad });
        expect(a).toContain("Grupo G nível Ouro.");
        expect(a).toContain("CNPJ 11.222.333/0001-81");
        expect(a).toContain("CEP 13874-439");
        const b = T.renderTexto(corpo, { grupo: "G", programa: "bpartner_ouro", lojas: [{ ...lojasCad[0], inf_cnpj: "11222333000181", inf_razao_social: "Loja 1 Ltda", inf_logradouro: "Rua Y", inf_numero: "9", inf_bairro: "Centro", inf_cep: "13874000", inf_cidade: "SJBV", inf_estado: "SP" }] });
        expect(b).toContain("Rua Y, 9 - Centro");
        expect(T.sha256(a)).not.toBe(T.sha256(b));
        expect(T.sha256(a)).toBe(T.sha256(a));
    });
});

// ── Banco em memória que imita o suficiente do PostgREST ──
function criarBanco(seed) {
    const t = JSON.parse(JSON.stringify(seed));
    let seq = 0;
    const parse = (path) => {
        const [tabela, qs = ""] = path.slice(1).split("?");
        const filtros = [];
        for (const par of qs.split("&").filter(Boolean)) {
            const i = par.indexOf("="); const k = decodeURIComponent(par.slice(0, i)); const v = decodeURIComponent(par.slice(i + 1));
            if (["select", "order", "limit"].includes(k)) continue;
            filtros.push([k, v]);
        }
        return { tabela, filtros };
    };
    const casa = (row, [k, v]) => {
        const x = row[k];
        if (v.startsWith("eq.")) return String(x) === v.slice(3);
        if (v.startsWith("in.(")) return v.slice(4, -1).split(",").map(s => s.replace(/^"|"$/g, "")).includes(String(x));
        if (v.startsWith("lt.")) return x != null && String(x) < v.slice(3);
        if (v.startsWith("gte.")) return x != null && String(x) >= v.slice(4);
        if (v.startsWith("lte.")) return x != null && String(x) <= v.slice(4);
        if (v.startsWith("ilike.")) return String(x || "").toLowerCase() === v.slice(6).toLowerCase();
        if (v === "not.is.null") return x != null;
        return true;
    };
    return {
        tabelas: t,
        get: async (p) => { const { tabela, filtros } = parse(p); return (t[tabela] || []).filter(r => filtros.every(f => casa(r, f))).map(r => ({ ...r })); },
        post: async (p, b) => { const { tabela } = parse(p); const arr = Array.isArray(b) ? b : [b]; t[tabela] = t[tabela] || []; const out = arr.map(r => ({ id: `id-${++seq}`, criado_em: new Date().toISOString(), ...r })); t[tabela].push(...out); return out; },
        patch: async (p, b) => { const { tabela, filtros } = parse(p); const alvo = (t[tabela] || []).filter(r => filtros.every(f => casa(r, f))); alvo.forEach(r => Object.assign(r, b)); return alvo; }
    };
}

describe("fluxo completo do termo", () => {
    let banco, notificados, hoje;
    const LOJA1 = { id: "loja-1", nome: "Casa A", cnpj: "11222333000181", cep: "87069013", endereco: null, cidade: "Maringa", estado: "PR", classe: "Ouro", grupo: "Casa X", rep: "Hugo", ativo: true, user_id: 36, mesorregiao_ibge: null, lat: 1, lng: 1 };
    const LOJA2 = { id: "loja-2", nome: "Casa B", cnpj: "72295793000124", cep: "86010-190", endereco: "Av. Duque", cidade: "Londrina", estado: "PR", classe: "Ouro", grupo: "Casa X", rep: "Hugo", ativo: true, user_id: null, mesorregiao_ibge: null, lat: 2, lng: 2 };
    const admin = { id: 1, email: "andre@boxer.com", nome: "Andre", username: "andre@boxer.com", role: "adm" };
    const revUser = { id: 36, username: "casa@x.com", role: "revenda" };
    const repUser = { id: 50, username: "hugo@x.com", role: "representante" };
    const lojaInfo = (id, cnpj, extra = {}) => ({ id, razao_social: "Casa Ltda", cnpj, logradouro: "Avenida Colombo", numero: "4738", bairro: "Zona 07", cep: "87030-121", cidade: "Maringá", estado: "PR", ...extra });
    const dadosRevenda = (lojas) => ({ nome: "João da Silva", cargo: "Sócio", cpf: "529.982.247-25", aceite: true, lojas });

    beforeEach(() => {
        banco = criarBanco({
            comercial_bmax_config: [{ id: "c1", chave: "termos_ativo", valor: "true" }],
            comercial_revendas_bmax: [{ ...LOJA1 }, { ...LOJA2 }],
            comercial_bmax_cobertura: [{ cidade: "Maringá", estado: "PR", mesorregiao: "Norte Central Paranaense" }, { cidade: "Londrina", estado: "PR", mesorregiao: "Norte Central Paranaense" }],
            comercial_bmax_conteudos_programa: [{ id: "cont-d", programa: "bpartner_diamante", tema: "termo_adesao", versao: 1, ativo: true, corpo: { titulo: "T", clausulas: [{ titulo: "Objeto", texto: "{{grupo}} {{nivel}}{{lojas}}" }] } },
                { id: "cont-o", programa: "bpartner_ouro", tema: "termo_adesao", versao: 1, ativo: true, corpo: { titulo: "T", clausulas: [{ titulo: "Objeto", texto: "{{grupo}} {{nivel}}{{lojas}}" }] } }]
        });
        notificados = []; hoje = new Date("2026-11-10T12:00:00Z");
        T.__setDeps({
            ...banco, now: () => hoje,
            resolverRepresentante: async () => ({ userId: 50, username: "hugo@x.com", email: "hugo@x.com" }),
            consultarCep: async () => ({ estado: "PR", cidade: "Maringá" }),
            geocode: async () => ({ lat: -23.4, lng: -51.9 }),
            notificar: async (ev) => { notificados.push(ev); },
            gerarComprovante: async () => Buffer.from("pdf"), guardarComprovante: async (id) => `2026/${id}/comprovante.pdf`, invalidarCache: () => {}
        });
    });
    afterAll(() => T.__setDeps(null));

    it("recurso desligado bloqueia a emissão", async () => {
        banco.tabelas.comercial_bmax_config[0].valor = "false";
        await expect(T.emitir({ grupo: "Casa X", programa: "bpartner_ouro" }, admin)).rejects.toThrow(/desligado/);
    });

    it("Ouro: emissão → revenda → testemunha → Boxer; cadastro atualizado (CNPJ/CEP/endereço/geo/mesorregião)", async () => {
        const termo = await T.emitir({ grupo: "Casa X", programa: "bpartner_ouro" }, admin);
        expect(termo.status).toBe("aguardando_revenda");
        const lojas = banco.tabelas.comercial_bmax_termo_lojas;
        expect(lojas).toHaveLength(2);

        // validação: CEP em formato errado e CPF inválido não passam
        await expect(T.revendaConfirmar(termo.id, revUser, dadosRevenda([lojaInfo(lojas[0].id, "11222333000181", { cep: "123" }), lojaInfo(lojas[1].id, "72295793000124")]))).rejects.toThrow(/CEP inválido/);
        await expect(T.revendaConfirmar(termo.id, revUser, { ...dadosRevenda([]), cpf: "111" })).rejects.toThrow();
        // quem não é do grupo não confirma
        await expect(T.revendaConfirmar(termo.id, { id: 999, role: "revenda" }, dadosRevenda([]))).rejects.toThrow(/Acesso negado/);

        const r1 = await T.revendaConfirmar(termo.id, revUser, dadosRevenda([lojaInfo(lojas[0].id, "11.222.333/0001-81"), lojaInfo(lojas[1].id, "72.295.793/0001-24", { cep: "86010-190", cidade: "Londrina" })]), { ip: "1.2.3.4" });
        expect(r1.status).toBe("aguardando_representante");
        const t1 = banco.tabelas.comercial_bmax_termos[0];
        expect(t1.texto_renderizado).toContain("Avenida Colombo, 4738 - Zona 07");
        expect(t1.hash_sha256).toBe(T.sha256(t1.texto_renderizado));
        expect(banco.tabelas.comercial_bmax_termo_aprovacoes[0].cpf).toBe("52998224725");

        // só o representante designado testemunha
        await expect(T.testemunhar(termo.id, { id: 51, role: "representante" }, { aceite: true })).rejects.toThrow(/Somente o representante/);
        await T.testemunhar(termo.id, repUser, { aceite: true });
        expect(banco.tabelas.comercial_bmax_termos[0].status).toBe("aguardando_boxer");

        const sim = await T.boxerAprovar(termo.id, admin, { simular: true });
        expect(sim.simulacao).toBe(true);
        expect(banco.tabelas.comercial_revendas_bmax[0].endereco).toBeNull(); // simulação não grava

        const r = await T.boxerAprovar(termo.id, admin, {});
        expect(r.status).toBe("aprovado");
        const c1 = banco.tabelas.comercial_revendas_bmax[0];
        expect(c1.cnpj).toBe("11222333000181");
        expect(c1.cep).toBe("87030121");
        expect(c1.endereco).toBe("Avenida Colombo, 4738 - Zona 07");
        expect(c1.lat).toBe(-23.4);
        expect(c1.mesorregiao_ibge).toBe("Norte Central Paranaense");
        expect(c1.nome).toBe("Casa A");           // nome nunca muda
        expect(c1.classe).toBe("Ouro");           // Ouro não muda de classe
        expect(banco.tabelas.comercial_bmax_termos[0].comprovante_path).toContain("comprovante.pdf");
        expect(notificados).toEqual(expect.arrayContaining(["emitido", "revenda_confirmou", "testemunhou", "aprovado"]));
        const evs = banco.tabelas.comercial_bmax_termo_auditoria.map(a => a.evento);
        expect(evs).toEqual(expect.arrayContaining(["criado", "etapa_concluida", "cadastro_atualizado", "comprovante_gerado"]));
    });

    it("loja adicional informada pela revenda não é criada sozinha: fica pendente de cadastro", async () => {
        const termo = await T.emitir({ grupo: "Casa X", programa: "bpartner_ouro" }, admin);
        const lojas = banco.tabelas.comercial_bmax_termo_lojas;
        await T.revendaConfirmar(termo.id, revUser, { ...dadosRevenda([lojaInfo(lojas[0].id, "11222333000181"), lojaInfo(lojas[1].id, "72295793000124")]), novas: [lojaInfo(null, "34028316000103")] });
        await T.testemunhar(termo.id, repUser, { aceite: true });
        await T.boxerAprovar(termo.id, admin, {});
        expect(banco.tabelas.comercial_revendas_bmax).toHaveLength(2);
        const aud = banco.tabelas.comercial_bmax_termo_auditoria.find(a => a.evento === "cadastro_atualizado");
        expect(aud.detalhes.pendentesCadastro).toHaveLength(1);
    });

    it("Diamante (upgrade): fica Ouro até confirmar a compra; prazo de 30 dias", async () => {
        const termo = await T.emitir({ grupo: "Casa X", programa: "bpartner_diamante" }, admin);
        const lojas = banco.tabelas.comercial_bmax_termo_lojas;
        await T.revendaConfirmar(termo.id, revUser, dadosRevenda([lojaInfo(lojas[0].id, "11222333000181"), lojaInfo(lojas[1].id, "72295793000124")]));
        await T.testemunhar(termo.id, repUser, { aceite: true });
        await expect(T.boxerAprovar(termo.id, admin, {})).rejects.toThrow(/capacitação/);
        const r = await T.boxerAprovar(termo.id, admin, { checklist: { capacitacao: true, funcionario_dedicado: true } });
        expect(r.status).toBe("aguardando_compra");
        expect(r.compra_prazo_ate).toBe("2026-12-10");
        expect(banco.tabelas.comercial_revendas_bmax.every(l => l.classe === "Ouro")).toBe(true);

        await expect(T.confirmarCompra(termo.id, admin, { notas: "" })).rejects.toThrow(/NFs/);
        await T.confirmarCompra(termo.id, admin, { notas: "NF 150001 e 150002" });
        expect(banco.tabelas.comercial_revendas_bmax.every(l => l.classe === "Diamante")).toBe(true);
        expect(banco.tabelas.comercial_bmax_termos[0].status).toBe("aprovado");
    });

    it("Diamante sem compra em 30 dias: encerra e o grupo segue Ouro", async () => {
        const termo = await T.emitir({ grupo: "Casa X", programa: "bpartner_diamante" }, admin);
        const lojas = banco.tabelas.comercial_bmax_termo_lojas;
        await T.revendaConfirmar(termo.id, revUser, dadosRevenda([lojaInfo(lojas[0].id, "11222333000181"), lojaInfo(lojas[1].id, "72295793000124")]));
        await T.testemunhar(termo.id, repUser, { aceite: true });
        await T.boxerAprovar(termo.id, admin, { checklist: { capacitacao: true, funcionario_dedicado: true } });
        hoje = new Date("2026-12-05T12:00:00Z");
        expect(await T.processarPrazos()).toEqual({ encerrados: 0, lembretes: 1 });
        hoje = new Date("2026-12-11T12:00:00Z");
        expect((await T.processarPrazos()).encerrados).toBe(1);
        expect(banco.tabelas.comercial_bmax_termos[0].status).toBe("encerrado_sem_compra");
        expect(banco.tabelas.comercial_revendas_bmax.every(l => l.classe === "Ouro")).toBe(true);
    });

    it("não emite dois termos abertos do mesmo grupo/programa e cancelar libera", async () => {
        const t = await T.emitir({ grupo: "Casa X", programa: "bpartner_ouro" }, admin);
        await expect(T.emitir({ grupo: "Casa X", programa: "bpartner_ouro" }, admin)).rejects.toThrow(/em andamento/);
        await T.cancelar(t.id, admin, "teste");
        await expect(T.emitir({ grupo: "Casa X", programa: "bpartner_ouro" }, admin)).resolves.toBeTruthy();
    });

    it("pendências: revenda do grupo e representante designado enxergam; outros não", async () => {
        banco.tabelas.comercial_revendas_bmax[0].user_id = 36;
        const t = await T.emitir({ grupo: "Casa X", programa: "bpartner_ouro" }, admin);
        expect((await T.minhas(revUser)).map(x => x.id)).toEqual([t.id]);
        expect(await T.minhas({ id: 999, role: "revenda" })).toEqual([]);
        expect(await T.minhas(repUser)).toEqual([]); // ainda não é a vez dele
    });
});
