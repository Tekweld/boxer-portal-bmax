// Proposta de agrupamento: cada REVENDA (código único) junta N lojas/CNPJs; logins e representantes ligam na revenda.
// SOMENTE LEITURA — gera planilha para revisão, não grava nada.
//   node scripts/gerar-proposta-agrupamento.js
require("dotenv").config({ quiet: true });
const XLSX = require("xlsx");
const l = require("../src/services/rd.leads.service");
const C = require("../src/config/constants");
const { sbSistemasService: sv } = require("../src/config/supabaseSistemas");
const db = require("../src/database");
const { QueryTypes } = require("sequelize");

const n = s => String(s || "").trim().toLowerCase();
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/^\s*\d+\s*,?\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
const STOP = new Set(["ltda", "eireli", "epp", "me", "comercio", "de", "do", "da", "e", "dos", "das", "com", "industria", "servicos"]);
const toks = s => new Set(norm(s).split(" ").filter(t => t.length > 1 && !STOP.has(t)));
const sim = (a, b) => { const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0; let i = 0; A.forEach(t => B.has(t) && i++); return i / Math.min(A.size, B.size); };
const dig = s => String(s || "").replace(/\D/g, "");
const fmtCnpj = s => { const d = dig(s); return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : (s || ""); };

(async () => {
    const [cad, opcoes, todos, logins, grupos] = await Promise.all([
        sv("/comercial_revendas_bmax?select=*&limit=1000"),
        l.getOpcoesRevendaRD(),
        l.fetchAllDealsAllPipelines(),
        db.sequelize.query(`SELECT u.id, u.username, r.name, r.grupo, r.cnpj FROM "Users" u JOIN "Revendas" r ON r.user_id=u.id WHERE u.role='revenda'`, { type: QueryTypes.SELECT }),
        db.sequelize.query(`SELECT revenda_rd, grupo FROM bmax_grupos`, { type: QueryTypes.SELECT })
    ]);
    const deals = todos.filter(d => d._pipelineId === C.RD_PIPELINE_INDUSTRIA || d._pipelineId === C.RD_PIPELINE_BMAX_INTERNO);
    const leadsPor = {};
    deals.forEach(d => { const k = n(l.getCustomField(d, "REVENDA/LOJA")); if (k) leadsPor[k] = (leadsPor[k] || 0) + 1; });

    const ativos = cad.filter(c => c.ativo);
    const canonDe = c => String(c.nome_rd || c.nome).trim();
    const grupoPgDe = nome => (grupos.find(g => n(g.revenda_rd) === n(nome)) || {}).grupo || "";

    // ── união: lojas ficam no mesmo grupo se compartilham grupo declarado, CNPJ-raiz (8 dígitos) ou o mesmo login
    const pai = ativos.map((_, i) => i);
    const raiz = i => (pai[i] === i ? i : (pai[i] = raiz(pai[i])));
    const une = (a, b) => { pai[raiz(a)] = raiz(b); };
    const porChave = {};
    const liga = (chave, i) => { if (!chave) return; if (porChave[chave] !== undefined) une(i, porChave[chave]); else porChave[chave] = i; };
    ativos.forEach((c, i) => {
        liga("g:" + n(c.grupo), c.grupo ? i : null);
        const gp = grupoPgDe(canonDe(c)); liga("gp:" + n(gp), gp ? i : null);
        const d = dig(c.cnpj); liga("r:" + d.slice(0, 8), d.length === 14 ? i : null);
        liga("u:" + c.user_id, c.user_id ? i : null);
    });
    const membros = {};
    ativos.forEach((c, i) => { (membros[raiz(i)] = membros[raiz(i)] || []).push(c); });

    // ── nome e código de cada revenda (grupo)
    const loginDeLoja = c => logins.find(u => u.id === c.user_id) || logins.find(u => n(u.name) === n(canonDe(c)));
    const revendas = Object.values(membros).map(ms => {
        const declarado = ms.map(c => c.grupo || grupoPgDe(canonDe(c))).find(Boolean);
        const principal = ms.slice().sort((a, b) => (leadsPor[n(canonDe(b))] || 0) - (leadsPor[n(canonDe(a))] || 0) || (loginDeLoja(b) ? 1 : 0) - (loginDeLoja(a) ? 1 : 0))[0];
        const nome = declarado || canonDe(principal);
        return { nome, ms, principal };
    }).sort((a, b) => a.nome.localeCompare(b.nome));
    revendas.forEach((r, i) => { r.codigo = "REV-" + String(i + 1).padStart(3, "0"); });
    const revendaDeLoja = new Map();
    revendas.forEach(r => r.ms.forEach(c => revendaDeLoja.set(c.id, r)));

    // ── variantes do RD (opções que não são o nome canônico de nenhuma loja) → loja provável
    const canonSet = new Set(ativos.map(c => n(canonDe(c))));
    const orfas = opcoes.filter(o => !canonSet.has(n(o)) && n(o) !== "sem revenda" && n(o) !== "n/d");
    const DECIDIDOS = { "d. soldas": "Aldesoldas" };
    const atrib = new Map();
    orfas.forEach(o => {
        let melhor = null, ms = 0;
        ativos.forEach(c => { const s = Math.max(sim(o, canonDe(c)), sim(o, c.nome)); if (s > ms) { ms = s; melhor = c; } });
        if (melhor && ms >= 0.7) atrib.set(o, melhor);
        const alvo = DECIDIDOS[n(o)], loja = alvo && ativos.find(c => n(canonDe(c)) === n(alvo)); if (loja) atrib.set(o, loja);
    });

    // ── abas
    const abaRevendas = revendas.map(r => {
        const classes = [...new Set(r.ms.map(c => c.classe).filter(Boolean))];
        const reps = [...new Set(r.ms.map(c => c.rep).filter(Boolean))];
        const lg = logins.filter(u => r.ms.some(c => c.user_id === u.id || n(canonDe(c)) === n(u.name)) || (r.nome && n(u.grupo) === n(r.nome)));
        const leadsTot = r.ms.reduce((s, c) => s + (leadsPor[n(canonDe(c))] || 0), 0) +
            [...atrib.entries()].filter(([, c]) => r.ms.some(m => m.id === c.id)).reduce((s, [o]) => s + (leadsPor[n(o)] || 0), 0);
        const avisos = [];
        if (classes.length > 1) avisos.push("lojas com classes diferentes: " + classes.join("/"));
        if (reps.length > 1) avisos.push("lojas com representantes diferentes: " + reps.join("/"));
        if (!lg.length) avisos.push("nenhum login ligado");
        return {
            "Código proposto": r.codigo, "Revenda (nome proposto)": r.nome, "Qtde lojas/CNPJs": r.ms.length,
            "Classe BPartner": classes.join(" / "), "Representante(s)": reps.join(" / "),
            "Logins hoje": lg.map(u => u.username).join(" | "), "Leads (todas as lojas + variantes)": leadsTot,
            "Avisos": avisos.join(" ; "), "OK? (S/N ou ajuste)": ""
        };
    });

    const abaLojas = revendas.flatMap(r => r.ms.map(c => {
        const canon = canonDe(c);
        const variantes = [...atrib.entries()].filter(([, x]) => x.id === c.id).map(([o]) => `${o} (${leadsPor[n(o)] || 0})`);
        const acoes = [];
        if (!c.nome_rd) acoes.push("preencher Nome no RD");
        if (!opcoes.some(o => n(o) === n(canon))) acoes.push("criar opção no picklist do RD");
        if (variantes.length) acoes.push("renomear cards das variantes");
        if (!dig(c.cnpj)) acoes.push("CNPJ ausente no cadastro");
        return {
            "Código da revenda": r.codigo, "Revenda": r.nome, "Loja (Nome no RD)": canon, "Nome no ZEN": c.nome,
            "CNPJ": fmtCnpj(c.cnpj), "Cidade/UF": [c.cidade, c.estado].filter(Boolean).join("/"),
            "Classe": c.classe || "", "Representante": c.rep || "", "Cards com este nome": leadsPor[n(canon)] || 0,
            "Variantes antigas no RD (cards)": variantes.join(" | "), "Ajustes necessários no RD/cadastro": acoes.join(" ; "), "OK? (S/N ou ajuste)": ""
        };
    }));

    const abaCards = [...orfas].map(o => {
        const c = atrib.get(o), r = c && revendaDeLoja.get(c.id), q = leadsPor[n(o)] || 0;
        return {
            "Nome antigo no RD": o, "Cards (todos os funis)": q,
            "Revenda proposta": r ? `${r.codigo} ${r.nome}` : "(nenhuma parecida)", "Loja proposta (Nome no RD)": c ? canonDe(c) : "",
            "Ação": c ? (q ? `trocar REVENDA/LOJA de ${q} card(s) para "${canonDe(c)}" e retirar o nome antigo das listas` : "sem cards: só retirar das listas") : (q ? "DECIDIR: tem cards e não casa com nenhuma loja ativa" : "sem cards: só retirar das listas"),
            "OK? (S/N ou outra ação)": ""
        };
    }).sort((a, b) => b["Cards (todos os funis)"] - a["Cards (todos os funis)"]);

    const abaLogins = logins.map(u => {
        const c = ativos.find(x => x.user_id === u.id) || ativos.find(x => n(canonDe(x)) === n(u.name)) || ativos.find(x => u.grupo && n(x.grupo) === n(u.grupo));
        const r = c && revendaDeLoja.get(c.id);
        return { "Login": u.username, "Nome atual no login": u.name, "Revenda proposta": r ? `${r.codigo} ${r.nome}` : "(sem revenda ativa — decidir)", "Cards visíveis hoje": leadsPor[n(u.name)] || 0, "OK? (S/N ou ajuste)": "" };
    }).sort((a, b) => a["Revenda proposta"].localeCompare(b["Revenda proposta"]));

    const novosLogins = [
        ["loja@alugaasolda.com.br", "AlugaASoldas (Prata)"], ["fernando@casadosoldador.com.br", "Casa do Soldador (Diamante)"],
        ["Joaocandiotto005@gmail.com", "Cascavel Soldas (Diamante)"], ["compras@casadosparafusos.com.br", "A Bittencourt (Casa dos Parafusos) (Ouro)"]
    ].map(([e, r]) => ({ "Login": e, "Nome atual no login": "(a criar)", "Revenda proposta": r, "Cards visíveis hoje": "", "OK? (S/N ou ajuste)": "" }));

    const resumo = [
        ["Revendas (códigos únicos) propostas", revendas.length], ["Lojas/CNPJs ativos", ativos.length],
        ["Revendas com mais de uma loja", revendas.filter(r => r.ms.length > 1).length],
        ["Revendas com aviso (classe/rep diferentes ou sem login)", abaRevendas.filter(r => r["Avisos"]).length],
        ["Lojas que precisam de ajuste no RD/cadastro", abaLojas.filter(x => x["Ajustes necessários no RD/cadastro"]).length],
        ["Nomes antigos no RD (opções sem loja ativa)", orfas.length],
        ["  ...que casam com uma loja", abaCards.filter(x => x["Loja proposta (Nome no RD)"]).length],
        ["  ...cards a renomear", abaCards.filter(x => x["Loja proposta (Nome no RD)"]).reduce((s, x) => s + x["Cards (todos os funis)"], 0)],
        ["  ...com cards e SEM loja parecida (decidir)", abaCards.filter(x => !x["Loja proposta (Nome no RD)"] && x["Cards (todos os funis)"]).length],
        ["Logins sem revenda ativa", abaLogins.filter(x => x["Revenda proposta"].startsWith("(sem")).length]
    ].map(([k, v]) => ({ "Indicador": k, "Valor": v }));

    const regras = [
        ["Como o agrupamento foi montado", "Lojas ficam na mesma revenda quando têm o mesmo grupo declarado (cadastro/bmax_grupos), o mesmo CNPJ-raiz (8 primeiros dígitos) ou o mesmo login."],
        ["Código", "REV-001... em ordem alfabética, apenas proposta; o código definitivo é gravado quando você aprovar."],
        ["Classe e representantes", "Passam a ser da revenda (grupo). Onde lojas do mesmo grupo têm valores diferentes, a coluna Avisos mostra."],
        ["O que você faz", "Confira as abas Revendas, Lojas, Cards RD e Logins; escreva S, N ou o ajuste na última coluna. Salve como _respondida.xlsx em Documentação."],
        ["O que acontece depois", "Simulação sem gravar, backup, e só então: gravar códigos, preencher/criar nomes no RD, renomear os cards, ligar logins e representantes."]
    ].map(([k, v]) => ({ "Item": k, "Explicação": v }));

    const wb = XLSX.utils.book_new();
    const add = (nome, rows, w) => { const ws = XLSX.utils.json_to_sheet(rows); ws["!cols"] = w.map(x => ({ wch: x })); XLSX.utils.book_append_sheet(wb, ws, nome); };
    add("Resumo", resumo, [60, 14]);
    add("Como ler", regras, [34, 130]);
    add("Revendas", abaRevendas, [14, 40, 10, 14, 30, 50, 14, 60, 22]);
    add("Lojas", abaLojas, [14, 36, 40, 50, 20, 22, 12, 22, 12, 60, 50, 22]);
    add("Cards RD", abaCards, [44, 14, 40, 40, 90, 22]);
    add("Logins", abaLogins.concat(novosLogins), [42, 40, 50, 14, 22]);
    XLSX.writeFile(wb, "../Documentação/Proposta_agrupamento_revendas_27-10-2026.xlsx");

    resumo.forEach(r => console.log(r["Indicador"].padEnd(62), r["Valor"]));
    console.log("\nRevendas com mais de uma loja:");
    revendas.filter(r => r.ms.length > 1).forEach(r => console.log(" ", r.codigo, r.nome, "|", r.ms.length, "lojas"));
    console.log("\nAvisos:");
    abaRevendas.filter(r => r["Avisos"]).slice(0, 25).forEach(r => console.log(" ", r["Código proposto"], r["Revenda (nome proposto)"], "|", r["Avisos"]));
    process.exit(0);
})().catch(e => { console.error("ERR", e.message, e.stack); process.exit(1); });
