// Aba "Auditor diário" (Gestão). Só mostra o que o auditor encontrou e deixa rodar uma simulação; nada aqui corrige dado de negócio.
const AUDITOR_GRUPO = { dinheiro: "Dinheiro", cards: "Cards e ids", prazos: "Prazos", pessoas: "Cadastro e pessoas", robos: "Robôs" };
const AUDITOR_SEV_COR = { alta: "#e30613", media: "#e8890c", baixa: "#6b7280" };
const auditorData = x => (x ? new Date(x).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");

async function auditorFetch(caminho, opts = {}) {
    const token = localStorage.getItem("token");
    const res = await fetch(`${API_URL}/auditor${caminho}`, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
    const corpo = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(corpo.error || `Erro ${res.status}`);
    return corpo;
}

function auditorErroAmigavel(e) {
    return /does not exist|não existe|relation/i.test(e.message || "")
        ? "As tabelas do auditor ainda não foram criadas no banco. Depois que forem criadas, os achados aparecem aqui."
        : (e.message || "Erro ao consultar o auditor");
}

// Mesma ordem de temas do e-mail (auditor.service.js)
const AUDITOR_TEMAS = ["saldo_vs_razao", "creditos_anormais", "auditor_checagem_falhou", "robo_sem_sucesso", "robo_ultima_falhou", "venda_sem_dados", "mudanca_campos", "pci_x_produto", "pci12_responsavel", "pcix_produto", "pcix_resumo", "pci12a_sem_resposta", "venda_sem_nota_zen", "venda_valor_zen", "venda_produto_zen", "venda_sem_cnpj_zen"];
const AUDITOR_SEV_ORDEM = { alta: 0, media: 1, baixa: 2 };
const auditorOrdenar = lista => lista.slice().sort((a, b) => {
    const ta = AUDITOR_TEMAS.indexOf(a.checagem), tb = AUDITOR_TEMAS.indexOf(b.checagem);
    return (ta < 0 ? 99 : ta) - (tb < 0 ? 99 : tb) || (AUDITOR_SEV_ORDEM[a.severidade] ?? 3) - (AUDITOR_SEV_ORDEM[b.severidade] ?? 3);
});

// Achados que listam cards (PCI12a sem resposta): mostra cada card com link para abrir no Pipefy
function auditorCards(a) {
    const cards = a.detalhe && Array.isArray(a.detalhe.cards) ? a.detalhe.cards : [];
    if (!cards.length) return "";
    return `<details style="margin-top:4px"><summary style="cursor:pointer">ver os ${cards.length} card(s)</summary><ul style="margin:4px 0 0;padding-left:18px">${cards.map(c =>
        `<li>${/^\d+$/.test(String(c.id)) ? `<a href="https://app.pipefy.com/open-cards/${esc(c.id)}" target="_blank" rel="noopener">${esc(c.nome)}</a>` : esc(c.nome)} · ${esc(c.dias)} dias · rep.: ${esc(c.representante)} · resp.: ${esc(c.responsavel || "—")}</li>`).join("")}</ul></details>`;
}

function auditorLinhaAchado(a) {
    const link = a.link && /^https?:\/\//.test(a.link) ? ` <a href="${esc(a.link)}" target="_blank" rel="noopener">abrir</a>` : "";
    return `<tr>
        <td style="white-space:nowrap;color:${AUDITOR_SEV_COR[a.severidade] || "inherit"};font-weight:700">${esc((a.severidade || "").toUpperCase())}</td>
        <td>${esc(AUDITOR_GRUPO[a.grupo] || a.grupo)}</td>
        <td>${esc(a.titulo)}${a.acao_sugerida || a.acao ? `<div style="color:var(--muted);font-size:12px;margin-top:2px">O que fazer: ${esc(a.acao_sugerida || a.acao)}</div>` : ""}${link}${auditorCards(a)}</td>
        <td style="white-space:nowrap">${a.primeira_vez ? auditorData(a.primeira_vez) : "—"}</td>
        <td style="white-space:nowrap">${a.resolvido_em ? auditorData(a.resolvido_em) : (a.ultimo_aviso_em ? auditorData(a.ultimo_aviso_em) : "nunca")}</td>
    </tr>`;
}

function auditorTabela(achados, resolvidos) {
    if (!achados.length) return `<p style="color:var(--muted)">${resolvidos ? "Nenhum achado resolvido ainda." : "Nenhum achado aberto. Tudo certo na última rodada."}</p>`;
    return `<table class="extrato-table"><thead><tr><th>Gravidade</th><th>Área</th><th>Achado</th><th>Desde</th><th>${resolvidos ? "Resolvido em" : "Último aviso"}</th></tr></thead><tbody>${(resolvidos ? achados : auditorOrdenar(achados)).map(auditorLinhaAchado).join("")}</tbody></table>`;
}

async function carregarAuditor() {
    const estado = $("auditorEstado").value;
    const achadosEl = $("auditorAchadosBody"), execEl = $("auditorExecucoesBody");
    achadosEl.innerHTML = '<p style="color:var(--muted)">Carregando...</p>';
    try {
        const [achados, execs] = await Promise.all([auditorFetch(`/achados?estado=${estado}`), auditorFetch("/execucoes")]);
        achadosEl.innerHTML = auditorTabela(achados, estado === "resolvidos");
        execEl.innerHTML = execs.length
            ? `<table class="extrato-table"><thead><tr><th>Quando</th><th>Rodada</th><th>Achados</th><th>Novos</th><th>Resolvidos</th><th>E-mail</th><th>Duração</th></tr></thead><tbody>${execs.map(x => `<tr>
                <td style="white-space:nowrap">${auditorData(x.iniciado_em)}</td><td>${esc(x.rodada)}</td><td>${x.total_achados}</td><td>${x.novos}</td><td>${x.resolvidos}</td>
                <td>${x.email_enviado ? "enviado" : (x.erro ? `<span style="color:#e30613">${esc(x.erro)}</span>` : "não precisou")}</td><td>${x.duracao_ms != null ? (x.duracao_ms / 1000).toFixed(1) + " s" : "—"}</td></tr>`).join("")}</tbody></table>`
            : '<p style="color:var(--muted)">O auditor ainda não rodou.</p>';
    } catch (e) {
        achadosEl.innerHTML = `<p style="color:var(--muted)">${esc(auditorErroAmigavel(e))}</p>`;
        execEl.innerHTML = "";
    }
}

async function simularAuditor() {
    const btn = $("btnAuditorSimular"), el = $("auditorSimulacaoBody");
    btn.disabled = true; btn.textContent = "Rodando...";
    try {
        const r = await auditorFetch("/simular", { method: "POST" });
        const tempos = (r.checagens || []).map(c => `${esc(c.id)}: ${c.erro ? `<span style="color:#e30613">falhou (${esc(c.erro)})</span>` : `${c.achados} achado(s)`} em ${c.ms} ms`).join(" · ");
        el.innerHTML = `<div style="border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:14px">
            <strong>Simulação (nada foi gravado nem enviado):</strong> ${r.total} achado(s) agora em ${(r.duracaoMs / 1000).toFixed(1)} s.
            <div style="color:var(--muted);font-size:12px;margin:4px 0 8px">${tempos}${(r.avisos || []).map(a => `<br>${esc(a)}`).join("")}</div>
            ${auditorTabela(r.achados || [], false)}</div>`;
    } catch (e) {
        toast(e.message || "Erro ao simular", "error");
    }
    btn.disabled = false; btn.textContent = "Rodar simulação agora";
}
