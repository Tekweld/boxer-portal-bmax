// Aplica o plano de correção de nomes de revenda aprovado pelo André em 09/10/2026
// (Documentação/Plano_correcao_nomes_revenda_09-10-2026.md). Sem --aplicar só mostra o plano.
//   node scripts/aplicar-plano-nomes-revenda-09-10-2026.js [--aplicar]
require("dotenv").config({ quiet: true });
const fs = require("fs");
const l = require("../src/services/rd.leads.service");
const C = require("../src/config/constants");
const { sbSistemasService: sv } = require("../src/config/supabaseSistemas");
const db = require("../src/database");
const { QueryTypes } = require("sequelize");

const APLICAR = process.argv.includes("--aplicar");
const meta = { editado_em: new Date().toISOString(), editado_por: "script-plano-nomes-09-10-2026" };
const n = s => String(s || "").trim().toLowerCase();

(async () => {
    const [cad, opcoes, logins, grupos] = await Promise.all([
        sv("/comercial_revendas_bmax?select=*&limit=1000"),
        l.getOpcoesRevendaRD(),
        db.sequelize.query(`SELECT u.id, u.username, r.name FROM "Users" u LEFT JOIN "Revendas" r ON r.user_id=u.id WHERE u.role='revenda'`, { type: QueryTypes.SELECT }),
        db.sequelize.query(`SELECT * FROM bmax_grupos`, { type: QueryTypes.SELECT })
    ]);
    const optSet = new Set(opcoes.map(n));
    const existe = nome => optSet.has(n(nome));
    const acoes = []; // { tipo, desc, run }
    const cadPor = nomeLike => cad.filter(c => n(c.nome) === n(nomeLike) || n(c.nome_rd) === n(nomeLike));

    // 1) renomeios de deals no RD (valores EXATOS como estão no RD -> nome que o login enxerga)
    const renomeios = [
        ["28977, Viasoldas Comercio De Produtos Para Solda Ltda", "Via Soldas"],
        ["30601, Technofer Solucoes Industriais Ltda", "Technofer"],
        ["25932, A Alugaasolda Aluguel De Solda Ltda", "AlugaASoldas"],
        ["Luitex Sumare", "Luitex Sumaré"],
        ["Eletrosolda Limeira", "Eletro Solda"],
        ["D. SOLDAS", "Aldesoldas"],
        ["D. Soldas", "Aldesoldas"]
    ];
    const mapaRenome = new Map();
    renomeios.forEach(([de, para]) => {
        const ok = existe(para);
        console.log(`renomear deals: "${de}" -> "${para}" ${ok ? "" : "  !!! destino NÃO existe no picklist: PULADO"}`);
        if (ok) mapaRenome.set(de, para);
    });

    // 2) cadastros
    const patches = [];
    const patch = (c, campos, motivo) => patches.push({ id: c.id, nome: c.nome, antes: Object.fromEntries(Object.keys(campos).map(k => [k, c[k]])), campos, motivo });
    for (const [alvo, nomeRd] of [["30601, Technofer Solucoes Industriais Ltda", "Technofer"], ["Luitex Sumare", "Luitex Sumaré"]]) {
        cadPor(alvo).filter(c => c.ativo !== false).forEach(c => { if (n(c.nome_rd) !== n(nomeRd) && existe(nomeRd)) patch(c, { nome_rd: nomeRd }, "nome no RD = nome do login"); });
    }
    const eletroLogin = logins.find(u => n(u.name) === "eletro solda");
    cad.filter(c => n(c.nome) === "eletrosolda limeira" && c.ativo !== false).forEach(c => patch(c, { nome_rd: "Eletro Solda", ...(eletroLogin ? { user_id: eletroLogin.id } : {}) }, "mesma empresa do login Eletro Solda"));
    const dSoldas = cad.filter(c => /^(\d+,\s*)?d\.?\s*soldas\b/i.test(c.nome) && c.ativo !== false);
    dSoldas.forEach(c => patch(c, { ativo: false }, "inativar D. Soldas (trabalhar a Aldesoldas no lugar)"));
    // 6 cadastros divergentes: Nome no RD = nome do login (sem reativar inativos)
    for (const u of logins) {
        if (!u.name || !existe(u.name)) continue;
        const vinc = cad.filter(c => c.user_id === u.id);
        if (!vinc.length || vinc.some(c => n(c.nome_rd || c.nome) === n(u.name))) continue;
        const outro = cad.find(c => c.user_id !== u.id && n(c.nome_rd) === n(u.name));
        if (outro) { console.log(`  pulado (conflito de nome_rd): login ${u.username} "${u.name}" já é nome_rd de "${outro.nome}"`); continue; }
        patch(vinc[0], { nome_rd: u.name }, `nome no RD = nome do login ${u.username}`);
    }
    console.log("\ncadastros a alterar:", patches.length);
    patches.forEach(p => console.log(`  ${p.nome} | ${JSON.stringify(p.antes)} -> ${JSON.stringify(p.campos)} | ${p.motivo}`));

    // 3) grupo Diafer
    const lojas = ["Diafer Itapeva", "Diafer Itapeva Matriz", "Diafer Cd", "Diafer Ponta Grossa", "Diafer Itararé", "Diafer Capão", "Diafer Jaguariaiva", "Diafer Jaguariáiva", "DIAFER"];
    const jaNoGrupo = new Set(grupos.map(g => n(g.revenda_rd)));
    const incluir = lojas.filter(x => existe(x) && !jaNoGrupo.has(n(x)));
    const resp = grupos.find(g => g.grupo === "Diafer")?.email_responsavel || null;
    console.log("\ngrupo Diafer — incluir:", incluir.join(" | ") || "(nada)", "| fora do picklist (ignoradas):", lojas.filter(x => !existe(x)).join(", ") || "-");

    if (!APLICAR) { console.log("\n(simulação — use --aplicar)"); process.exit(0); }

    fs.writeFileSync(`scripts/backups/plano-nomes-${Date.now()}.json`, JSON.stringify({ patches, grupos, renomeios: [...mapaRenome] }, null, 1));
    for (const p of patches) await sv(`/comercial_revendas_bmax?id=eq.${p.id}`, "PATCH", { ...p.campos, ...meta });
    console.log("cadastros alterados:", patches.length);
    for (const x of incluir) await db.sequelize.query(`INSERT INTO bmax_grupos (revenda_rd, grupo, email_responsavel) VALUES (:x, 'Diafer', :r) ON CONFLICT (revenda_rd) DO NOTHING`, { replacements: { x, r: resp } });
    console.log("grupo Diafer: incluídas", incluir.length);

    const r = await l.varrerEAtualizarDealsNoRD(
        [C.RD_PIPELINE_INDUSTRIA, C.RD_PIPELINE_BMAX_INTERNO, C.RD_PIPELINE_REVENDAS],
        d => mapaRenome.has(l.getCustomField(d, "REVENDA/LOJA")),
        d => ({ "revenda-loja": mapaRenome.get(l.getCustomField(d, "REVENDA/LOJA")) }),
        { errorMsg: "Erro ao renomear revenda no deal (plano 09/10)" }
    );
    console.log("deals renomeados no RD:", JSON.stringify({ total: r.total, updated: r.updated, failed: r.failed }));
    process.exit(0);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
