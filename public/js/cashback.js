let CASHBACK_EXTRATO = [];
let CASHBACK_SALDO = 0;
let CASHBACK_SAQUES = [];
let CASHBACK_EXPIRANDO = [];
// Admin não tem carteira: consulta (somente leitura) a de uma revenda escolhida no seletor.
let EXTRATO_REVENDA_ALVO = "";

function cashbackQs() {
    return session.role === "adm" && EXTRATO_REVENDA_ALVO ? `?revenda=${encodeURIComponent(EXTRATO_REVENDA_ALVO)}` : "";
}

// Nome do lead = o mesmo (`deal.name`) que o card mostra no painel. Sem lead
// (saque, expiração) mantém a descrição original.
function descricaoMovimentacao(t) {
    if (!t.lead_id) return esc(t.descricao || "");
    const resto = (t.descricao || "").split(t.lead_id).join("").replace(/\s+/g, " ").trim();
    const nome = t.lead_nome
        ? `<strong>${esc(t.lead_nome)}</strong>`
        : `<strong style="color:#718096">Lead nao localizado no RD</strong>`;
    return `${nome}<div style="font-size:11px;color:#718096">${esc(resto)}</div>`;
}

async function carregarSeletorRevendaExtrato() {
    const sel = $("extratoRevendaSel");
    const wrap = $("extratoRevendaWrap");
    if (!sel || !wrap) return;
    wrap.classList.toggle("hidden", session.role !== "adm");
    if (session.role !== "adm" || sel.options.length > 1) return;
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/comissoes/agentes?tipo=revenda`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const agentes = await res.json();
        sel.innerHTML = '<option value="">Selecione uma revenda...</option>' +
            agentes.map(a => `<option value="${esc(a.nome)}">${esc(a.nome)} — R$ ${fmtBRL(a.saldo)}</option>`).join("");
        sel.value = EXTRATO_REVENDA_ALVO;
    } catch (e) { console.error("Erro ao carregar revendas do extrato:", e); }
}

async function trocarRevendaExtrato(nome) {
    EXTRATO_REVENDA_ALVO = nome || "";
    await refreshCashback();
}

function fmtBRL(v) { return Number(v).toLocaleString("pt-BR", {minimumFractionDigits:2, maximumFractionDigits:2}); }

async function loadCashbackSaldo() {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/cashback/saldo${cashbackQs()}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return 0;
        const data = await res.json();
        CASHBACK_SALDO = data.saldo || 0;
        return CASHBACK_SALDO;
    } catch (e) { return 0; }
}

async function loadCashbackExtrato() {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/cashback/extrato${cashbackQs()}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        CASHBACK_SALDO = data.saldo || 0;
        CASHBACK_EXTRATO = data.transacoes || [];
    } catch (e) {
        console.error("Erro ao carregar extrato:", e);
    }
}

async function loadCashbackExpirando() {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/cashback/expirando${cashbackQs()}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return;
        CASHBACK_EXPIRANDO = await res.json();
    } catch (e) {
        console.error("Erro ao carregar expirando:", e);
    }
}

async function loadCashbackSaques() {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/cashback/saques${cashbackQs()}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return;
        CASHBACK_SAQUES = await res.json();
    } catch (e) {
        console.error("Erro ao carregar saques:", e);
    }
}

function renderExtrato() {
    const wrap = $("extratoBody");
    if (!wrap) return;

    const saldoEl = $("extratoSaldo");
    if (saldoEl) saldoEl.textContent = `R$ ${fmtBRL(CASHBACK_SALDO)}`;

    if (!CASHBACK_EXTRATO.length) {
        wrap.innerHTML = session.role === "adm" && !EXTRATO_REVENDA_ALVO
            ? '<div class="empty-state">Selecione uma revenda acima para ver o extrato dela.</div>'
            : '<div class="empty-state">Nenhuma movimentacao registrada.</div>';
        return;
    }

    let html = `<table class="extrato-table">
        <thead><tr>
            <th>Data</th>
            <th>Tipo</th>
            <th>Lead / Descricao</th>
            <th style="text-align:right">Valor</th>
            <th style="text-align:right">Saldo</th>
        </tr></thead><tbody>`;

    for (const t of CASHBACK_EXTRATO) {
        const data = new Date(t.criado_em).toLocaleDateString("pt-BR");
        const isCredito = t.tipo === "credito";
        const cls = isCredito ? "extrato-credito" : "extrato-debito";
        const sinal = isCredito ? "+" : "-";
        const expira = t.expira_em ? ` <span class="expira-tag">exp ${new Date(t.expira_em).toLocaleDateString("pt-BR")}</span>` : "";

        html += `<tr class="${cls}">
            <td>${data}</td>
            <td><span class="tipo-badge ${t.tipo}">${t.tipo}</span></td>
            <td>${descricaoMovimentacao(t)}${expira}</td>
            <td style="text-align:right;font-weight:600">${sinal} R$ ${fmtBRL(t.valor)}</td>
            <td style="text-align:right;color:#718096">R$ ${fmtBRL(t.saldo_apos)}</td>
        </tr>`;
    }
    html += "</tbody></table>";
    wrap.innerHTML = html;
}

function renderSaques() {
    const wrap = $("saquesBody");
    if (!wrap) return;

    if (!CASHBACK_SAQUES.length) {
        wrap.innerHTML = '<div class="empty-state">Nenhum saque registrado.</div>';
        return;
    }

    const isRep = session.role === "representante" || session.role === "adm";

    let html = `<table class="extrato-table">
        <thead><tr>
            <th>Data</th>
            ${isRep ? "<th>Revenda</th>" : ""}
            <th>Valor</th>
            <th>Tipo</th>
            <th>Status</th>
            <th>Codigo</th>
            <th>Acoes</th>
        </tr></thead><tbody>`;

    for (const s of CASHBACK_SAQUES) {
        const data = new Date(s.criado_em).toLocaleDateString("pt-BR");
        const tipoLabel = s.tipo_uso === "desconto" ? "Desconto 5%" : "Bonificacao 10%";
        const statusCls = {
            pendente: "status-pendente", aprovado: "status-aprovado",
            recusado: "status-recusado", utilizado: "status-utilizado", expirado: "status-expirado"
        }[s.status] || "";

        html += `<tr>
            <td>${data}</td>
            ${isRep ? `<td>${esc(s.revenda || "")}</td>` : ""}
            <td style="font-weight:600">R$ ${fmtBRL(s.valor)}</td>
            <td>${tipoLabel}</td>
            <td><span class="status-badge ${statusCls}">${s.status}</span></td>
            <td>${s.codigo_cheque ? `<code>${esc(s.codigo_cheque)}</code>` : "-"}</td>`;

        if (isRep && s.status === "pendente") {
            html += `<td>
                <button class="btn btn-sm btn-approve" onclick="aprovarSaque('${s.id}')">Aprovar</button>
                <button class="btn btn-sm btn-reject" onclick="recusarSaque('${s.id}')">Recusar</button>
            </td>`;
        } else if (s.status === "aprovado" && s.codigo_cheque) {
            html += `<td><button class="btn btn-sm" onclick='gerarChequePDF(${JSON.stringify(s).replace(/'/g,"&#39;")})'>Cheque PDF</button></td>`;
        } else {
            html += `<td>-</td>`;
        }
        html += "</tr>";
    }
    html += "</tbody></table>";
    wrap.innerHTML = html;
}

function openSaqueModal() {
    const modal = $("saqueModal");
    if (modal) modal.classList.add("show");
    $("saqueValor").value = "";
    $("saqueTipo").value = "desconto";
}

function closeSaqueModal() {
    const modal = $("saqueModal");
    if (modal) modal.classList.remove("show");
}

async function submitSaque() {
    const valor = parseFloat($("saqueValor").value);
    const tipo = $("saqueTipo").value;

    if (!valor || valor <= 0) { toast("Informe um valor valido", "warn"); return; }
    if (valor > CASHBACK_SALDO) { toast(`Saldo insuficiente. Disponivel: R$ ${fmtBRL(CASHBACK_SALDO)}`, "error"); return; }

    const btn = $("btnSubmitSaque");
    btnLoading(btn, true);
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/cashback/saques`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ valor, tipo_uso: tipo })
        });
        const data = await res.json();
        if (!res.ok) { toast(data.error || "Erro ao solicitar saque", "error"); return; }
        toast("Saque solicitado! Aguarde aprovacao do representante.");
        closeSaqueModal();
        await refreshCashback();
    } catch (e) {
        toast("Erro de conexao", "error");
    } finally {
        btnLoading(btn, false);
    }
}

async function aprovarSaque(id) {
    if (!confirm("Aprovar este saque?")) return;
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/cashback/saques/${id}/aprovar`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) { toast(data.error || "Erro ao aprovar", "error"); return; }
        toast(`Saque aprovado! Cheque: ${data.codigo_cheque}`);
        await refreshCashback();
    } catch (e) {
        toast("Erro de conexao", "error");
    }
}

async function recusarSaque(id) {
    if (!confirm("Recusar este saque? Esta acao nao pode ser desfeita.")) return;
    const motivo = prompt("Motivo da recusa (opcional):");
    if (motivo === null) return; // usuario cancelou o prompt — nao prosseguir
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/cashback/saques/${id}/recusar`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ motivo: motivo || "" })
        });
        if (!res.ok) { const d = await res.json(); toast(d.error || "Erro", "error"); return; }
        toast("Saque recusado.");
        await refreshCashback();
    } catch (e) {
        toast("Erro de conexao", "error");
    }
}

async function recalcularComissoes() {
    if (!confirm("Recalcular todas as comissoes com base nas porcentagens atuais do Motor PCI?\n\nIsso ira ajustar creditos ja existentes (diferenca para mais ou para menos).")) return;
    const btn = $("btnRecalcularComissoes");
    btnLoading(btn, true);
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/cashback/recalcular`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) { toast(data.error || "Erro ao recalcular", "error"); return; }
        if (data.ajustados === 0) {
            toast("Nenhum ajuste necessario — todas as comissoes ja estao corretas.");
        } else {
            toast(`${data.ajustados} comissoes ajustadas com sucesso.`);
        }
        await refreshCashback();
    } catch (e) {
        toast("Erro de conexao", "error");
    } finally {
        btnLoading(btn, false);
    }
}

const PROBLEMA_LABEL = {
    sem_pci_no_rd: "Sem PCI no RD",
    sem_classe_no_rd: "Sem Classe de Preço no RD",
    pci_divergente: "PCI mudou desde o crédito",
    classe_divergente: "Classe mudou desde o crédito"
};

async function abrirAuditoriaComissoes() {
    const btn = $("btnAuditoriaComissoes");
    btnLoading(btn, true);
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/cashback/auditoria`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) { toast(data.error || "Erro na auditoria", "error"); return; }
        renderAuditoriaComissoesModal(data);
    } catch (e) {
        toast("Erro de conexao", "error");
    } finally {
        btnLoading(btn, false);
    }
}

function renderAuditoriaComissoesModal(data) {
    const comProblema = data.deals.filter(d => !d.ok);
    const ok = data.deals.filter(d => d.ok);

    const linha = (d) => `
        <tr style="${d.ok ? "" : "background:rgba(227,6,19,.06)"}">
            <td>${esc(d.cliente)}</td>
            <td>${esc(d.pciAtual || "(vazio)")}</td>
            <td>${esc(d.classeAtual || "(vazio)")}</td>
            <td>${esc(d.pciGravado)}</td>
            <td>${esc(d.classeGravada)}</td>
            <td>R$ ${fmtBRL(d.totalCreditado)}</td>
            <td>${d.ok ? "OK" : esc(d.problemas.map(p => PROBLEMA_LABEL[p] || p).join(", "))}</td>
        </tr>`;

    const content = $("adminModalContent");
    content.innerHTML = `
        <h3>Auditoria de Comissões</h3>
        <p style="color:var(--muted);font-size:13px;margin-bottom:12px">
            ${data.total_auditado} vendas já creditadas analisadas &bull;
            <strong style="color:${comProblema.length ? "#e30613" : "#16a34a"}">${comProblema.length} com problema</strong>
        </p>
        <div style="max-height:60vh;overflow:auto">
            <table style="width:100%;font-size:12px;border-collapse:collapse">
                <thead>
                    <tr>
                        <th style="text-align:left;padding:6px">Cliente</th>
                        <th style="text-align:left;padding:6px">PCI (RD hoje)</th>
                        <th style="text-align:left;padding:6px">Classe (RD hoje)</th>
                        <th style="text-align:left;padding:6px">PCI no crédito</th>
                        <th style="text-align:left;padding:6px">Classe no crédito</th>
                        <th style="text-align:left;padding:6px">Total creditado</th>
                        <th style="text-align:left;padding:6px">Status</th>
                    </tr>
                </thead>
                <tbody>${[...comProblema, ...ok].map(linha).join("")}</tbody>
            </table>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeAdminModal()">Fechar</button>
        </div>`;
    $("adminModal").classList.add("show");
}

function renderExpirando() {
    const container = $("extratoExpirando");
    if (!container) return;
    if (!CASHBACK_EXPIRANDO.length) { container.classList.add("hidden"); return; }

    container.classList.remove("hidden");
    const total = CASHBACK_EXPIRANDO.reduce((s, c) => s + Number(c.valor), 0);
    let html = `<div class="expirando-header"><span class="alert-icon" style="color:#e30613">⚠</span> <strong>R$ ${fmtBRL(total)}</strong> em creditos expirando nos proximos 30 dias</div><ul class="expirando-list">`;
    for (const c of CASHBACK_EXPIRANDO) {
        const dias = Math.ceil((new Date(c.expira_em) - Date.now()) / (24 * 60 * 60 * 1000));
        html += `<li><span class="expirando-valor">R$ ${fmtBRL(c.valor)}</span> — ${esc(c.lead_nome || c.descricao || "")} — <span class="expirando-dias ${dias <= 15 ? "urgente" : ""}">${dias} dias restantes</span></li>`;
    }
    html += "</ul>";
    container.innerHTML = html;
}

async function refreshCashback() {
    await carregarSeletorRevendaExtrato();
    await Promise.all([loadCashbackExtrato(), loadCashbackSaques(), loadCashbackExpirando()]);
    renderExtrato();
    renderSaques();
    renderExpirando();
}

function updateDashCashback() {
    if (session.role !== "revenda" && session.role !== "representante") return;   // revenda e representante: só o saldo real do extrato
    const el = $("statCashbackVal");
    if (!el) return;
    el.textContent = `R$ ${fmtBRL(CASHBACK_SALDO)}`;
    el.className = CASHBACK_SALDO > 0 ? "cashback-positive" : "";
}

function gerarChequePDF(saque) {
    const tipoLabel = saque.tipo_uso === "desconto" ? "Desconto (max 5% do pedido)" : "Bonificacao (max 10% do pedido)";
    const expiraFormatted = saque.expira_em ? new Date(saque.expira_em).toLocaleDateString("pt-BR") : "N/D";
    const aprovadoFormatted = saque.aprovado_em ? new Date(saque.aprovado_em).toLocaleDateString("pt-BR") : "—";
    const code = esc(saque.codigo_cheque);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cheque ${code}</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Outfit,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0b1228;color:#e2e8f0}
.cheque{width:680px;background:#0f1a3d;border-radius:16px;overflow:hidden;border:1px solid #1e2f5e;box-shadow:0 0 0 1px rgba(37,187,238,.08),0 24px 80px rgba(0,0,0,.5),0 8px 24px rgba(0,0,0,.3)}
.ch-header{background:linear-gradient(135deg,#1d327b,#0f1a3d);padding:28px 32px 22px;text-align:center;position:relative}
.ch-header::after{content:'';position:absolute;bottom:0;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent,#25bbee,transparent)}
.logo-row{display:flex;align-items:center;justify-content:center;gap:14px}
.logo-icon{width:52px;height:52px;flex-shrink:0}
.logo-text{font-size:36px;font-weight:900;color:#fff;letter-spacing:4px}
.logo-tag{font-size:11px;font-weight:400;color:rgba(255,255,255,.5);letter-spacing:1px;margin-top:2px}
.logo-tag b{font-weight:700;font-style:italic;color:rgba(255,255,255,.7)}
.ch-sub{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:3px;color:#25bbee;margin-top:10px}
.code-band{background:#0a0f22;padding:20px 32px;text-align:center;border-top:1px solid #1e2f5e;border-bottom:1px solid #1e2f5e}
.code-lbl{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:#5a6fa0;margin-bottom:6px}
.code-val{font-family:'JetBrains Mono',monospace;font-size:28px;font-weight:700;color:#25bbee;letter-spacing:4px;text-shadow:0 0 20px rgba(37,187,238,.3)}
.valor-sec{padding:28px 32px 24px;text-align:center;position:relative;overflow:hidden}
.valor-lbl{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:#5a6fa0;margin-bottom:4px}
.valor-amt{font-size:48px;font-weight:800;color:#22c55e;line-height:1.1;font-variant-numeric:tabular-nums;text-shadow:0 0 30px rgba(34,197,94,.25)}
.valor-amt .cur{font-size:24px;font-weight:600;color:#16a34a;vertical-align:super;margin-right:4px}
.wm{position:absolute;right:-20px;top:50%;transform:translateY(-50%);font-size:120px;font-weight:900;color:rgba(37,187,238,.03);letter-spacing:8px;pointer-events:none;user-select:none}
.details{padding:0 32px 24px;display:grid;grid-template-columns:1fr 1fr;gap:0}
.det{padding:14px 0;border-top:1px solid #1e2f5e}
.det:nth-child(odd){padding-right:16px}
.det:nth-child(even){padding-left:16px;border-left:1px solid #1e2f5e}
.det-lbl{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#5a6fa0;margin-bottom:4px}
.det-val{font-size:14px;font-weight:600;color:#e2e8f0}
.det-val.danger{color:#e30613;font-weight:700}
.ch-footer{background:#0a0f22;padding:16px 32px;border-top:1px solid #1e2f5e;display:flex;align-items:flex-start;gap:10px}
.ch-footer svg{flex-shrink:0;width:18px;height:18px;margin-top:1px;color:#25bbee}
.ch-footer .ft{font-size:12px;color:#7b8ec2;line-height:1.5}
.ch-footer .ft strong{color:#25bbee;font-weight:600}
.boxer-bar{padding:10px 32px;background:linear-gradient(90deg,#e30613,#b30510);display:flex;align-items:center;justify-content:center;gap:8px}
.boxer-bar svg{width:16px;height:16px}
.boxer-bar span{font-size:11px;font-weight:600;letter-spacing:1.5px;color:#fff;text-transform:uppercase}
@media print{body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}.cheque{box-shadow:none;border:2px solid #1d327b}@page{margin:1cm}}
</style></head><body>
<div class="cheque">
<div class="ch-header">
<div class="logo-row">
<svg class="logo-icon" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1d327b"/><stop offset="100%" stop-color="#25bbee"/></linearGradient></defs><rect x="10" y="10" width="180" height="180" rx="36" fill="url(#g)"/><line x1="32" y1="32" x2="80" y2="92" stroke="#fff" stroke-width="9" stroke-linecap="round"/><polygon points="100,38 108,78 142,56 117,86 155,90 118,103 145,134 108,116 100,158 92,116 55,134 82,103 45,90 83,86 58,56 92,78" fill="#fff"/></svg>
<div><div class="logo-text">BMAX</div><div class="logo-tag">Uma solucao <b>360&deg; boxer</b></div></div>
</div>
<div class="ch-sub">Cheque Cashback</div>
</div>
<div class="code-band"><div class="code-lbl">Codigo do cheque</div><div class="code-val">${code}</div></div>
<div class="valor-sec"><div class="wm">BMAX</div><div class="valor-lbl">Valor do cheque</div><div class="valor-amt"><span class="cur">R$</span>${fmtBRL(saque.valor)}</div></div>
<div class="details">
<div class="det"><div class="det-lbl">Revenda</div><div class="det-val">${esc(saque.revenda)}</div></div>
<div class="det"><div class="det-lbl">Tipo de uso</div><div class="det-val">${tipoLabel}</div></div>
<div class="det"><div class="det-lbl">Data de aprovacao</div><div class="det-val">${aprovadoFormatted}</div></div>
<div class="det"><div class="det-lbl">Validade</div><div class="det-val danger">Ate ${expiraFormatted}</div></div>
</div>
<div class="ch-footer">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
<div class="ft">Insira o codigo <strong>${code}</strong> no campo Observacao do pedido no ZEN. Este cheque e valido por 30 dias a partir da data de aprovacao.</div>
</div>
<div class="boxer-bar"><svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><polygon points="100,38 108,78 142,56 117,86 155,90 118,103 145,134 108,116 100,158 92,116 55,134 82,103 45,90 83,86 58,56 92,78" fill="#fff"/></svg><span>Boxer Soldas</span></div>
</div>
<script>window.onload=function(){window.print()}<\/script>
</body></html>`;
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); }
    else toast("Popup bloqueado. Permita popups para gerar o cheque.", "error");
}

function showExtratoTab(tab, el) {
    document.querySelectorAll(".extrato-tab-content").forEach(p => p.classList.add("hidden"));
    document.querySelectorAll(".extrato-tab").forEach(t => t.classList.remove("active"));
    $("extrato-" + tab).classList.remove("hidden");
    el.classList.add("active");
}
