// Proposta de agrupamento v2 (27/10/2026): inclui cadastros INATIVOS que têm login ou cards no RD (ex.: Ipanema, Locsoldas)
// e usa o NOME DA REVENDA (grupo) como nome único no RD (decisão do André: sem filial nos cards).
// Mantém os códigos REV-001..035 da v1; as novas entram como REV-036+. SOMENTE LEITURA.
//   node scripts/gerar-proposta-agrupamento-v2.js
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
    const leadsPor = {}, abertosPor = {};
    deals.forEach(d => {
        const k = n(l.getCustomField(d, "REVENDA/LOJA")); if (!k) return;
        leadsPor[k] = (leadsPor[k] || 0) + 1;
        if (d.win !== true && d.win !== false) abertosPor[k] = (abertosPor[k] || 0) + 1;
    });
    const canonDe = c => String(c.nome_rd || c.nome).trim();
    const grupoPgDe = nome => (grupos.find(g => n(g.revenda_rd) === n(nome)) || {}).grupo || "";
    const loginDe = c => logins.find(u => u.id === c.user_id) || logins.find(u => n(u.name) === n(canonDe(c))) ||
        logins.find(u => sim(u.name, c.nome) >= 0.8 && sim(u.name, c.nome) > 0);
    const cardsDe = c => leadsPor[n(canonDe(c))] || leadsPor[n(c.nome)] || (loginDe(c) ? leadsPor[n(loginDe(c).name)] || 0 : 0);

    // universo: ativos + inativos que têm login ou cards
    const ativos = cad.filter(c => c.ativo);
    const extras = cad.filter(c => !c.ativo && (loginDe(c) || cardsDe(c) > 0));
    const base = [...ativos.map(c => ({ ...c, _ini: false })), ...extras.map(c => ({ ...c, _ini: true }))];

    const agrupa = lista => {
        const pai = lista.map((_, i) => i);
        const raiz = i => (pai[i] === i ? i : (pai[i] = raiz(pai[i])));
        const une = (a, b) => { pai[raiz(a)] = raiz(b); };
        const porChave = {};
        const liga = (k, i) => { if (!k) return; if (porChave[k] !== undefined) une(i, porChave[k]); else porChave[k] = i; };
        lista.forEach((c, i) => {
            if (c.grupo) liga("g:" + n(c.grupo), i);
            const gp = grupoPgDe(canonDe(c)); if (gp) liga("gp:" + n(gp), i);
            const d = dig(c.cnpj); if (d.length === 14) liga("r:" + d.slice(0, 8), i);
            if (c.user_id) liga("u:" + c.user_id, i);
            const lg = loginDe(c); if (lg) liga("lg:" + lg.id, i);
        });
        const m = {};
        lista.forEach((c, i) => { (m[raiz(i)] = m[raiz(i)] || []).push(c); });
        return Object.values(m);
    };
    const montaRevenda = ms => {
        const declarado = ms.map(c => c.grupo || grupoPgDe(canonDe(c))).find(Boolean);
        const principal = ms.slice().sort((a, b) => (a._ini - b._ini) || cardsDe(b) - cardsDe(a))[0];
        // cadastro inativo sem nome no RD: o nome do ZEN é longo/técnico — prefere o nome do login (ex.: "Ipanema Soldas (LT)")
        const nomeInativo = principal._ini && !principal.nome_rd && loginDe(principal) ? String(loginDe(principal).name).trim() : null;
        return { nome: declarado || nomeInativo || canonDe(principal), ms, principal };
    };

    // códigos da v1 (só ativos, ordem alfabética) — preservados
    const v1 = agrupa(ativos).map(montaRevenda).sort((a, b) => a.nome.localeCompare(b.nome));
    const codigoDaLoja = new Map();
    v1.forEach((r, i) => r.ms.forEach(c => codigoDaLoja.set(c.id, "REV-" + String(i + 1).padStart(3, "0"))));

    const grupos2 = agrupa(base).map(montaRevenda);
    let prox = v1.length + 1;
    grupos2.forEach(r => { const cs = r.ms.map(c => codigoDaLoja.get(c.id)).filter(Boolean).sort(); r.codigo = cs[0] || null; });
    grupos2.filter(r => !r.codigo).sort((a, b) => a.nome.localeCompare(b.nome)).forEach(r => { r.codigo = "REV-" + String(prox++).padStart(3, "0"); });
    const revendas = grupos2.sort((a, b) => a.codigo.localeCompare(b.codigo));
    const revendaDeLoja = new Map(); revendas.forEach(r => r.ms.forEach(c => revendaDeLoja.set(c.id, r)));

    // opções do RD → nome final (nome da revenda)
    const nomeFinalDeOpcao = new Map(); // opção -> {r, motivo}
    base.forEach(c => { const r = revendaDeLoja.get(c.id); [canonDe(c), c.nome].forEach(nm => { if (opcoes.some(o => n(o) === n(nm))) nomeFinalDeOpcao.set(opcoes.find(o => n(o) === n(nm)), { r, motivo: "loja da revenda" }); }); const lg = loginDe(c); if (lg) { const o = opcoes.find(x => n(x) === n(lg.name)); if (o) nomeFinalDeOpcao.set(o, { r, motivo: "nome do login" }); } });
    const DECIDIDOS = { "d. soldas": "Aldesoldas" };
    opcoes.filter(o => !nomeFinalDeOpcao.has(o) && n(o) !== "sem revenda" && n(o) !== "n/d").forEach(o => {
        const alvo = DECIDIDOS[n(o)], lj = alvo && base.find(c => n(canonDe(c)) === n(alvo));
        if (lj) { nomeFinalDeOpcao.set(o, { r: revendaDeLoja.get(lj.id), motivo: "decisão anterior do André" }); return; }
        let melhor = null, ms = 0;
        base.forEach(c => { const s = Math.max(sim(o, canonDe(c)), sim(o, c.nome)); if (s > ms) { ms = s; melhor = c; } });
        if (melhor && ms >= 0.7) nomeFinalDeOpcao.set(o, { r: revendaDeLoja.get(melhor.id), motivo: "nome parecido" });
    });
    const opcoesDe = r => [...nomeFinalDeOpcao.entries()].filter(([, v]) => v.r === r).map(([o]) => o);

    // ── abas
    const abaRevendas = revendas.map(r => {
        const classes = [...new Set(r.ms.map(c => c.classe).filter(Boolean))];
        const reps = [...new Set(r.ms.map(c => c.rep).filter(Boolean))];
        const lg = [...new Set(r.ms.map(c => loginDe(c)).filter(Boolean))];
        const ops = opcoesDe(r);
        const cards = ops.reduce((s, o) => s + (leadsPor[n(o)] || 0), 0), abertos = ops.reduce((s, o) => s + (abertosPor[n(o)] || 0), 0);
        const inativa = !r.ms.some(c => !c._ini);
        const avisos = [];
        if (classes.length > 1) avisos.push("lojas com classes diferentes: " + classes.join("/"));
        if (reps.length > 1) avisos.push("lojas com representantes diferentes: " + reps.join("/"));
        if (!lg.length) avisos.push("nenhum login ligado");
        if (inativa) avisos.push("cadastro INATIVO hoje — reativar?");
        return {
            "Código proposto": r.codigo, "Revenda (nome único no RD, Portal e Motor)": r.nome, "Situação hoje": inativa ? "INATIVA (tem " + (lg.length ? "login" : "cards") + ")" : "ativa",
            "Qtde lojas/CNPJs": r.ms.length, "Classe BPartner": classes.join(" / "), "Representante(s)": reps.join(" / "),
            "Logins hoje": lg.map(u => u.username).join(" | "), "Cards (total)": cards, "Cards em aberto": abertos,
            "Avisos": avisos.join(" ; "), "OK? (S/N ou ajuste)": ""
        };
    });

    const abaLojas = revendas.flatMap(r => r.ms.map(c => {
        const acoes = [];
        if (c._ini) acoes.push("cadastro inativo: reativar?");
        if (n(c.nome_rd) !== n(r.nome)) acoes.push(`Nome no RD passa a ser "${r.nome}"`);
        if (!dig(c.cnpj)) acoes.push("CNPJ ausente no cadastro" + (loginDe(c) ? ` (login tem ${fmtCnpj(loginDe(c).cnpj)})` : ""));
        return {
            "Código da revenda": r.codigo, "Revenda (nome único)": r.nome, "Loja (como está hoje no RD/cadastro)": canonDe(c), "Nome no ZEN": c.nome,
            "CNPJ": fmtCnpj(c.cnpj) || (loginDe(c) ? fmtCnpj(loginDe(c).cnpj) : ""), "Cidade/UF": [c.cidade, c.estado].filter(Boolean).join("/"),
            "Classe": c.classe || "", "Representante": c.rep || "", "Situação": c._ini ? "INATIVA" : "ativa",
            "Ajustes necessários": acoes.join(" ; "), "OK? (S/N ou ajuste)": ""
        };
    }));

    const abaCards = opcoes.filter(o => n(o) !== "sem revenda" && n(o) !== "n/d").map(o => {
        const v = nomeFinalDeOpcao.get(o), q = leadsPor[n(o)] || 0, ab = abertosPor[n(o)] || 0;
        let acao;
        if (!v) acao = q ? "DECIDIR: tem cards e não casa com nenhuma revenda" : "sem cards: retirar da lista do RD";
        else if (n(v.r.nome) === n(o)) acao = "manter (já é o nome da revenda)";
        else acao = q ? `trocar ${q} card(s) para "${v.r.nome}" e retirar este nome da lista` : "sem cards: retirar da lista do RD";
        return { "Nome hoje no RD (lista REVENDA/LOJA)": o, "Cards (todos)": q, "Cards em aberto": ab, "Revenda final": v ? `${v.r.codigo} ${v.r.nome}` : "(nenhuma parecida)", "Critério": v ? v.motivo : "", "Ação": acao, "OK? (S/N ou outra ação)": "" };
    }).sort((a, b) => (a["Ação"].startsWith("DECIDIR") ? 0 : 1) - (b["Ação"].startsWith("DECIDIR") ? 0 : 1) || b["Cards (todos)"] - a["Cards (todos)"]);

    const abaLogins = logins.map(u => {
        const c = base.find(x => x.user_id === u.id) || base.find(x => n(canonDe(x)) === n(u.name)) || base.find(x => u.grupo && n(x.grupo) === n(u.grupo)) || base.find(x => loginDe(x) && loginDe(x).id === u.id);
        const r = c && revendaDeLoja.get(c.id);
        return { "Login": u.username, "Nome atual no login": u.name, "Revenda proposta": r ? `${r.codigo} ${r.nome}` : "(sem revenda — decidir)", "Cards hoje": leadsPor[n(u.name)] || 0, "OK? (S/N ou ajuste)": "" };
    }).sort((a, b) => a["Revenda proposta"].localeCompare(b["Revenda proposta"]));
    const novosLogins = [
        ["loja@alugaasolda.com.br", "AlugaASoldas"], ["fernando@casadosoldador.com.br", "Casa do Soldador"],
        ["Joaocandiotto005@gmail.com", "Cascavel Soldas"], ["compras@casadosparafusos.com.br", "A Bittencourt (Casa dos Parafusos)"]
    ].map(([e, nm]) => { const r = revendas.find(x => n(x.nome) === n(nm)); return { "Login": e, "Nome atual no login": "(a criar)", "Revenda proposta": r ? `${r.codigo} ${r.nome}` : nm, "Cards hoje": "", "OK? (S/N ou ajuste)": "" }; });

    const resumo = [
        ["Revendas (códigos únicos) propostas", revendas.length], ["  ...já ativas", abaRevendas.filter(r => r["Situação hoje"] === "ativa").length],
        ["  ...INATIVAS hoje, mas com login ou cards (novas na v2)", abaRevendas.filter(r => r["Situação hoje"] !== "ativa").length],
        ["Lojas/CNPJs na proposta", base.length], ["Revendas com mais de uma loja", revendas.filter(r => r.ms.length > 1).length],
        ["Nomes na lista REVENDA/LOJA do RD hoje", abaCards.length],
        ["  ...a manter", abaCards.filter(x => x["Ação"].startsWith("manter")).length],
        ["  ...a trocar nos cards", abaCards.filter(x => x["Ação"].startsWith("trocar")).length],
        ["  ...cards que serão renomeados", abaCards.filter(x => x["Ação"].startsWith("trocar")).reduce((s, x) => s + x["Cards (todos)"], 0)],
        ["  ...sem cards (retirar da lista)", abaCards.filter(x => x["Ação"].startsWith("sem cards")).length],
        ["  ...a DECIDIR (tem cards e não casa)", abaCards.filter(x => x["Ação"].startsWith("DECIDIR")).length],
        ["Logins sem revenda", abaLogins.filter(x => x["Revenda proposta"].startsWith("(sem")).length]
    ].map(([k, v]) => ({ "Indicador": k, "Valor": v }));

    const regras = [
        ["Decisão de modelo (André, 27/10)", "O RD passa a mostrar SÓ o nome da revenda (sem filial). Lojas do mesmo grupo viram um único nome na lista REVENDA/LOJA e nos cards."],
        ["Como o agrupamento foi montado", "Mesmo grupo declarado, mesmo CNPJ-raiz (8 primeiros dígitos) ou mesmo login. Entram também cadastros INATIVOS que têm login ou cards no RD."],
        ["Código", "REV-001..035 são os da primeira versão (inalterados). REV-036 em diante são as novas (inativas hoje)."],
        ["Aba Revendas", "Confirme nome único e agrupamento (S ou ajuste). Nas INATIVAS, responda se devem ser reativadas."],
        ["Aba Lojas", "Mostra, por loja, o que muda (nome no RD, reativar, CNPJ ausente). Responda S/N."],
        ["Aba Cards RD", "Lista de TODOS os nomes hoje no RD e o que acontece com cada um (manter, trocar cards, retirar da lista, decidir)."],
        ["Aba Logins", "Para cada login, a revenda em que ele vai ficar vinculado."]
    ].map(([k, v]) => ({ "Item": k, "Explicação": v }));

    const wb = XLSX.utils.book_new();
    const add = (nome, rows, w) => { const ws = XLSX.utils.json_to_sheet(rows); ws["!cols"] = w.map(x => ({ wch: x })); XLSX.utils.book_append_sheet(wb, ws, nome); };
    add("Resumo", resumo, [62, 14]);
    add("Como ler", regras, [34, 130]);
    add("Revendas", abaRevendas, [14, 42, 22, 10, 14, 30, 50, 10, 12, 60, 22]);
    add("Lojas", abaLojas, [14, 36, 40, 50, 20, 22, 12, 22, 10, 60, 22]);
    add("Cards RD", abaCards, [46, 12, 12, 42, 24, 90, 22]);
    add("Logins", abaLogins.concat(novosLogins), [42, 40, 50, 10, 22]);
    XLSX.writeFile(wb, "../Documentação/Proposta_agrupamento_revendas_v2_27-10-2026.xlsx");

    resumo.forEach(r => console.log(r["Indicador"].padEnd(64), r["Valor"]));
    console.log("\nNOVAS (inativas):");
    abaRevendas.filter(r => r["Situação hoje"] !== "ativa").forEach(r => console.log(" ", r["Código proposto"], r["Revenda (nome único no RD, Portal e Motor)"], "|", r["Situação hoje"], "| cards", r["Cards (total)"], "abertos", r["Cards em aberto"], "| login:", r["Logins hoje"]));
    console.log("\nA DECIDIR:");
    abaCards.filter(x => x["Ação"].startsWith("DECIDIR")).forEach(x => console.log(" ", x["Nome hoje no RD (lista REVENDA/LOJA)"], x["Cards (todos)"]));
    process.exit(0);
})().catch(e => { console.error("ERR", e.message, e.stack); process.exit(1); });
