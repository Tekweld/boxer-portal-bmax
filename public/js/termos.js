// Termo de Formalização Digital BPartner — interface.
// Admin: Gestão › Termos BPartner (emitir, acompanhar, aprovar, confirmar compra). Revenda: formulário com TODAS as lojas (CNPJ,
// endereço, CEP em destaque). Representante: testemunha. API: /api/termos (src/routes/termos.routes.js).

const TERMO_STATUS = {
    rascunho: ["Rascunho", "#718096"], aguardando_revenda: ["Aguardando a revenda", "#d97706"], aguardando_representante: ["Aguardando a testemunha", "#d97706"],
    aguardando_boxer: ["Aguardando a Boxer", "#1d327b"], aguardando_compra: ["Aguardando compra das máquinas", "#7c3aed"], aprovado: ["Aprovado", "#16a34a"],
    encerrado_sem_compra: ["Encerrado sem compra", "#718096"], cancelado: ["Cancelado", "#e30613"], expirado: ["Expirado", "#718096"]
};
const TERMO_PROGRAMA = { bpartner_prata: "Prata", bpartner_ouro: "Ouro", bpartner_diamante: "Diamante" };
const UFS_TERMO = "AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" ");
let TERMO_ATUAL = null;

async function tApi(path, method = "GET", body = null) {
    const res = await fetch(`${API_URL}/termos${path}`, {
        method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` }, body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "Erro na solicitação"), { erros: data.erros });
    return data;
}

// ─── máscaras e validações (espelham as do servidor) ─────────
const tSoDig = s => String(s || "").replace(/\D/g, "");
const tMaskCep = v => { const d = tSoDig(v).slice(0, 8); return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d; };
const tMaskCnpj = v => { const d = tSoDig(v).slice(0, 14); return d.replace(/^(\d{2})(\d)/, "$1.$2").replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d)/, ".$1/$2").replace(/(\d{4})(\d)/, "$1-$2"); };
const tMaskCpf = v => { const d = tSoDig(v).slice(0, 11); return d.replace(/^(\d{3})(\d)/, "$1.$2").replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d)/, ".$1-$2"); };
function tCnpjOk(v) {
    const c = tSoDig(v); if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
    const dv = b => { let s = 0, p = b.length - 7; for (const d of b) { s += d * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
    return dv(c.slice(0, 12)) == c[12] && dv(c.slice(0, 13)) == c[13];
}
function tCpfOk(v) {
    const c = tSoDig(v); if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
    const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += c[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    return dv(9) == c[9] && dv(10) == c[10];
}
const tDataBr = v => v ? new Date(v).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—";
const tBadge = s => { const [t, c] = TERMO_STATUS[s] || [s, "#718096"]; return `<span style="display:inline-block;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:700;color:#fff;background:${c}">${esc(t)}</span>`; };

function abrirModalTermo(html) { $("termoModalContent").innerHTML = html; $("termoModal").classList.add("show"); }
function fecharModalTermo() { $("termoModal").classList.remove("show"); }

// ═════════════ ADMIN ═════════════
async function carregarTermosAdmin() {
    const box = $("termosAdminBody");
    box.innerHTML = '<p style="color:var(--muted)">Carregando...</p>';
    try {
        const [flag, lista] = await Promise.all([tApi("/flag"), tApi("/")]);
        box.innerHTML = `
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
            <label style="display:flex;gap:8px;align-items:center;font-weight:700"><input type="checkbox" id="termosFlag" ${flag.ativo ? "checked" : ""} onchange="alternarFlagTermos(this.checked)"> Recurso ligado para revendas e representantes</label>
            <button class="btn primary" onclick="abrirEmissaoTermo()">+ Novo termo</button>
          </div>
          <p style="color:var(--muted);font-size:13px;margin-bottom:10px">Enquanto desligado, só você (admin) enxerga a tela; revendas e representantes não veem nenhum termo.</p>
          ${lista.length ? `<table class="extrato-table"><thead><tr><th>Grupo</th><th>Programa</th><th>Situação</th><th>Testemunha</th><th>Criado</th><th>Prazo compra</th><th></th></tr></thead><tbody>
            ${lista.map(t => `<tr><td>${esc(t.grupo)}</td><td>${esc(TERMO_PROGRAMA[t.programa] || t.programa)}</td><td>${tBadge(t.status)}</td><td>${esc(t.representante_nome || "—")}</td><td>${tDataBr(t.criado_em)}</td><td>${esc(t.compra_prazo_ate || "—")}</td><td><button class="btn" onclick="abrirTermoAdmin('${t.id}')">Abrir</button></td></tr>`).join("")}</tbody></table>` : '<p style="color:var(--muted)">Nenhum termo emitido ainda.</p>'}`;
    } catch (e) { box.innerHTML = `<p style="color:#e30613">${esc(e.message)}</p>`; }
}

async function alternarFlagTermos(ativo) {
    try { await tApi("/flag", "PUT", { ativo }); toast(ativo ? "Recurso LIGADO para revendas e representantes" : "Recurso desligado", ativo ? "success" : "warn"); }
    catch (e) { toast(e.message, "error"); carregarTermosAdmin(); }
}

async function abrirEmissaoTermo() {
    try {
        const grupos = await tApi("/grupos");
        abrirModalTermo(`<h3>Novo termo de adesão BPartner</h3>
          <div class="field"><label>Grupo</label><select id="emGrupo" style="width:100%">${grupos.map(g => `<option value="${esc(g.chave)}">${esc(g.grupo)} — ${g.unica ? "loja única" : g.lojas + " loja(s)"}, ${esc(g.classes.join("/"))}${g.temLogin ? "" : " (sem login)"}</option>`).join("")}</select></div>
          <div class="field"><label>Programa</label><select id="emPrograma" style="width:100%"><option value="bpartner_prata">Prata</option><option value="bpartner_ouro">Ouro</option><option value="bpartner_diamante">Diamante (upgrade)</option></select></div>
          <div class="form-actions" style="margin-top:12px"><button class="btn" onclick="fecharModalTermo()">Cancelar</button><button class="btn primary" onclick="conferirEmissaoTermo()">Conferir lojas e elegibilidade</button></div>
          <div id="emPrevia" style="margin-top:14px"></div>`);
    } catch (e) { toast(e.message, "error"); }
}

async function conferirEmissaoTermo() {
    const grupo = $("emGrupo").value, programa = $("emPrograma").value, box = $("emPrevia");
    box.innerHTML = "Conferindo...";
    try {
        const p = await tApi(`/previa?grupo=${encodeURIComponent(grupo)}&programa=${programa}`);
        const el = p.elegibilidade;
        box.innerHTML = `
          ${el.erros.map(x => `<div style="background:#fee2e2;color:#991b1b;padding:8px 10px;border-radius:8px;margin-bottom:6px;font-size:13px">${esc(x)}</div>`).join("")}
          ${el.avisos.map(x => `<div style="background:#fef3c7;color:#92400e;padding:8px 10px;border-radius:8px;margin-bottom:6px;font-size:13px">${esc(x)}</div>`).join("")}
          <p style="font-size:13px;margin:8px 0 4px"><b>Lojas que entram no termo</b> (marque as que valem):</p>
          <div style="max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px 10px">${p.lojas.map(l => `<label style="display:block;font-size:13px;padding:2px 0"><input type="checkbox" class="emLoja" value="${l.id}" checked> ${esc(l.nome)} — ${esc(l.cidade || "")}/${esc(l.estado || "")} — ${esc(l.classe || "sem classe")}</label>`).join("")}</div>
          <div class="field"><label>Testemunha (representante)</label><input id="emRep" placeholder="${esc(p.representantes.join(" / ") || "nome do representante no RD")}" value="${p.representantes.length === 1 ? esc(p.representantes[0]) : ""}"></div>
          <div class="form-actions"><button class="btn primary" ${el.ok ? "" : "disabled"} onclick="emitirTermo()">Emitir termo</button></div>`;
    } catch (e) { box.innerHTML = `<div style="color:#e30613">${esc(e.message)}</div>`; }
}

async function emitirTermo() {
    const lojaIds = [...document.querySelectorAll(".emLoja:checked")].map(i => i.value);
    try {
        // Para respeitar a seleção de lojas, a prévia recalcula no servidor; a emissão manda os ids marcados.
        await tApi("/", "POST", { grupo: $("emGrupo").value, programa: $("emPrograma").value, lojaIds, representante: $("emRep").value.trim() });
        fecharModalTermo(); toast("Termo emitido. A revenda foi avisada por e-mail."); carregarTermosAdmin();
    } catch (e) { toast(e.message, "error"); }
}

function tabelaLojasTermo(lojas) {
    return `<table class="extrato-table"><thead><tr><th>Loja</th><th>CNPJ</th><th style="background:#fff3cd">CEP</th><th>Endereço</th><th>Cidade/UF</th></tr></thead><tbody>${lojas.map(l => {
        const inf = !!l.inf_cnpj;
        const end = inf ? [l.inf_logradouro, l.inf_numero].filter(Boolean).join(", ") + (l.inf_complemento ? ", " + l.inf_complemento : "") + (l.inf_bairro ? " - " + l.inf_bairro : "") : (l.cad_endereco || "—");
        return `<tr><td>${esc(inf ? l.inf_razao_social : l.cad_nome)}${l.nova_loja ? ' <b style="color:#d97706">(loja adicional — cadastrar manualmente)</b>' : ""}</td><td>${esc(tMaskCnpj(inf ? l.inf_cnpj : l.cad_cnpj))}</td><td style="background:#fff8e1;font-weight:800">${esc(tMaskCep(inf ? l.inf_cep : l.cad_cep))}</td><td>${esc(end)}</td><td>${esc((inf ? l.inf_cidade : l.cad_cidade) || "")}/${esc((inf ? l.inf_estado : l.cad_estado) || "")}</td></tr>`;
    }).join("")}</tbody></table>`;
}

function blocoAprovacoes(aprovacoes) {
    return aprovacoes.length ? `<ul style="font-size:13px;padding-left:18px">${aprovacoes.map(a => `<li><b>${esc({ revenda: "Revenda", testemunha_representante: "Representante (testemunha)", boxer: "Boxer" }[a.etapa] || a.etapa)}</b>: ${esc(a.nome_aprovador)}${a.cargo ? " — " + esc(a.cargo) : ""} — ${tDataBr(a.aprovado_em)}</li>`).join("")}</ul>` : '<p style="color:var(--muted);font-size:13px">Nenhuma aprovação ainda.</p>';
}

async function abrirTermoAdmin(id) {
    try {
        const d = await tApi(`/${id}`); const t = d.termo;
        const diamante = t.programa === "bpartner_diamante";
        const jaDiamante = t.classe_antes === "Diamante";
        let acoes = "";
        if (t.status === "aguardando_boxer") acoes = `
          ${diamante ? `<div style="margin:8px 0;font-size:13px"><b>Checklist Diamante</b>
            <label style="display:block"><input type="checkbox" id="ckCap"> Capacitação do demonstrador concluída</label>
            <label style="display:block"><input type="checkbox" id="ckFunc"> Funcionário dedicado às demonstrações Laser</label>
            ${jaDiamante ? '<label style="display:block"><input type="checkbox" id="ckCompra"> Compra das duas máquinas já realizada</label>' : ""}</div>` : ""}
          <div class="form-actions"><button class="btn" onclick="simularAprovacao('${t.id}')">Simular atualização do cadastro</button><button class="btn primary" onclick="aprovarTermoBoxer('${t.id}')">Aprovar (Boxer)</button></div><div id="simResultado"></div>`;
        else if (t.status === "aguardando_compra") acoes = `<div class="field"><label>NFs da compra das duas máquinas (prazo até ${esc(t.compra_prazo_ate)})</label><input id="compraNotas" placeholder="Ex.: NF 150001 e NF 150002"></div><div class="form-actions"><button class="btn primary" onclick="confirmarCompraTermo('${t.id}')">Confirmar compra e ativar Diamante</button></div>`;
        const podeCancelar = ["aguardando_revenda", "aguardando_representante", "aguardando_boxer", "aguardando_compra"].includes(t.status);
        abrirModalTermo(`<h3>${esc(t.grupo)} — BPartner ${esc(TERMO_PROGRAMA[t.programa])}</h3>
          <p>${tBadge(t.status)} <span style="color:var(--muted);font-size:12px">emitido por ${esc(t.emitido_por || "—")} em ${tDataBr(t.criado_em)} — testemunha: ${esc(t.representante_nome || "—")}</span></p>
          <h4 style="margin:10px 0 4px">Lojas</h4>${tabelaLojasTermo(d.lojas)}
          <h4 style="margin:10px 0 4px">Aprovações</h4>${blocoAprovacoes(d.aprovacoes)}
          ${acoes}
          <details style="margin-top:10px"><summary style="cursor:pointer;font-weight:700">Texto do termo (hash ${esc((t.hash_sha256 || "").slice(0, 16))}…)</summary><pre style="white-space:pre-wrap;font-size:12px;max-height:240px;overflow:auto;background:#f7fafc;padding:10px;border-radius:8px">${esc(t.texto_renderizado)}</pre></details>
          <details style="margin-top:6px"><summary style="cursor:pointer;font-weight:700">Histórico (auditoria)</summary><ul style="font-size:12px;padding-left:18px">${(d.auditoria || []).map(a => `<li>${tDataBr(a.criado_em)} — <b>${esc(a.evento)}</b> (${esc(a.ator_email || a.ator_tipo || "sistema")})</li>`).join("")}</ul></details>
          <div class="form-actions" style="margin-top:12px">${t.comprovante_path ? `<button class="btn" onclick="abrirComprovanteTermo('${t.id}')">Baixar comprovante (PDF)</button>` : ""}${podeCancelar ? `<button class="btn" style="color:#e30613" onclick="cancelarTermoAdmin('${t.id}')">Cancelar termo</button>` : ""}<button class="btn" onclick="fecharModalTermo()">Fechar</button></div>`);
    } catch (e) { toast(e.message, "error"); }
}

const checklistTermo = () => ({ capacitacao: !!($("ckCap") && $("ckCap").checked), funcionario_dedicado: !!($("ckFunc") && $("ckFunc").checked), compra_realizada: !!($("ckCompra") && $("ckCompra").checked) });

async function simularAprovacao(id) {
    try {
        const r = await tApi(`/${id}/aprovar-boxer`, "POST", { simular: true, checklist: checklistTermo() });
        const c = r.cadastro;
        const mudancas = a => Object.keys(a.depois).filter(k => !["lat", "lng"].includes(k) && String(a.antes[k] ?? "") !== String(a.depois[k] ?? "")).map(k => `${k}: <s>${esc(a.antes[k] ?? "—")}</s> → ${esc(a.depois[k])}`).join("; ") || "sem mudanças";
        $("simResultado").innerHTML = `<div style="margin-top:8px;font-size:13px;background:#f0f7ff;padding:10px;border-radius:8px"><b>Simulação (nada foi gravado)</b>
          ${c.bloqueios.map(b => `<p style="color:#991b1b;background:#fee2e2;padding:6px 8px;border-radius:6px"><b>Bloqueia a aprovação:</b> ${esc(b)}</p>`).join("")}
          <ul style="padding-left:18px">${c.atualizadas.map(a => `<li><b>${esc(a.loja)}</b>${a.userId ? " <span style='color:#1d327b'>(tem login: será espelhado)</span>" : ""}: ${mudancas(a)}</li>`).join("")}</ul>
          ${c.divergencias.length ? `<div style="background:#fef3c7;padding:8px;border-radius:6px"><b>Troca de CNPJ em loja já cadastrada</b> (pode ser erro de digitação da revenda):<ul style="padding-left:18px">${c.divergencias.map(d => `<li>${esc(d.loja)}: ${esc(d.de)} → <b>${esc(d.para)}</b></li>`).join("")}</ul>
            <label><input type="checkbox" id="ckCnpj"> Conferi e confirmo a troca de CNPJ</label></div>` : ""}
          ${c.pendentesCadastro.length ? `<p style="color:#d97706">Lojas adicionais para cadastrar manualmente: ${c.pendentesCadastro.map(p => esc(p.razao_social)).join(", ")}</p>` : ""}
          ${c.avisos.map(a => `<p style="color:#92400e">${esc(a)}</p>`).join("")}</div>`;
    } catch (e) { toast(e.message, "error"); }
}
async function aprovarTermoBoxer(id) {
    if (!confirm("Aprovar o termo? O cadastro das lojas (CNPJ, CEP, endereço e coordenadas) será atualizado e o comprovante enviado.")) return;
    try {
        const r = await tApi(`/${id}/aprovar-boxer`, "POST", { checklist: checklistTermo(), confirmarCnpj: !!($("ckCnpj") && $("ckCnpj").checked) });
        toast(r.status === "aprovado" ? "Termo aprovado" : "Aprovado — aguardando a compra das máquinas"); fecharModalTermo(); carregarTermosAdmin();
    } catch (e) { toast(e.message, "error"); if (/CNPJ/.test(e.message)) simularAprovacao(id); }
}
async function confirmarCompraTermo(id) {
    try { await tApi(`/${id}/confirmar-compra`, "POST", { notas: $("compraNotas").value }); toast("Compra confirmada — grupo agora é Diamante"); fecharModalTermo(); carregarTermosAdmin(); }
    catch (e) { toast(e.message, "error"); }
}
async function cancelarTermoAdmin(id) {
    const motivo = prompt("Motivo do cancelamento:"); if (motivo === null) return;
    try { await tApi(`/${id}/cancelar`, "POST", { motivo }); toast("Termo cancelado"); fecharModalTermo(); carregarTermosAdmin(); } catch (e) { toast(e.message, "error"); }
}
async function abrirComprovanteTermo(id) {
    try { const r = await tApi(`/${id}/comprovante`); window.open(r.url, "_blank", "noopener"); } catch (e) { toast(e.message, "error"); }
}

// ═════════════ REVENDA / REPRESENTANTE ═════════════
async function verificarTermosPendentes() {
    const b = $("termoBanner"); if (!b) return;
    b.classList.add("hidden");
    if (!["revenda", "representante"].includes(session.role)) return;
    try {
        const l = await tApi("/minhas");
        if (!l.length) return;
        b.innerHTML = `<b>Você tem ${l.length} termo(s) de adesão BPartner aguardando ${session.role === "revenda" ? "a sua confirmação" : "a sua testemunha"}.</b> <button class="btn primary" style="margin-left:8px" onclick="abrirTermoUsuario('${l[0].id}')">Abrir termo</button>`;
        b.classList.remove("hidden");
    } catch (_) { /* recurso opcional: não atrapalha o painel */ }
}

async function abrirTermoUsuario(id) {
    try {
        const d = await tApi(`/${id}`); TERMO_ATUAL = d;
        show("termo");
        const t = d.termo;
        const cab = `<h2>Termo de adesão — BPartner ${esc(TERMO_PROGRAMA[t.programa])}</h2><p style="color:var(--muted)">Grupo <b>${esc(t.grupo)}</b> ${tBadge(t.status)}</p>`;
        const texto = `<details open style="margin:10px 0"><summary style="cursor:pointer;font-weight:700">Texto do termo</summary><pre style="white-space:pre-wrap;font-size:13px;max-height:320px;overflow:auto;background:#f7fafc;padding:12px;border-radius:8px">${esc(t.texto_renderizado)}</pre></details>`;
        let corpo = "";
        if (d.papel === "revenda" && t.status === "aguardando_revenda") corpo = formularioRevenda(d);
        else if (d.papel === "representante" && t.status === "aguardando_representante") corpo = `${texto}<h4>Dados das lojas informados pela revenda</h4>${tabelaLojasTermo(d.lojas)}
            <p style="margin-top:10px"><b>Declaração:</b> ${esc("Declaro ter acompanhado esta adesão e conferido os dados das lojas relacionadas.")}</p>
            <div class="field"><label>Seu nome</label><input id="tsNome" value="${esc(t.representante_nome || "")}"></div>
            <label style="display:block;margin:8px 0"><input type="checkbox" id="tsAceite"> Confirmo a declaração acima como testemunha</label>
            <button class="btn primary" onclick="enviarTestemunha('${t.id}')">Testemunhar</button>`;
        else corpo = `${texto}${tabelaLojasTermo(d.lojas)}<h4 style="margin-top:10px">Aprovações</h4>${blocoAprovacoes(d.aprovacoes)}${t.comprovante_path ? `<button class="btn" onclick="abrirComprovanteTermo('${t.id}')">Baixar comprovante (PDF)</button>` : ""}`;
        const ehForm = d.papel === "revenda" && t.status === "aguardando_revenda";
        $("termoCorpo").innerHTML = cab + (ehForm ? texto : "") + corpo;
        if (ehForm) prepararFormularioRevenda();
    } catch (e) { toast(e.message, "error"); }
}

function cartaoLoja(l, idx, nova) {
    const rot = nova ? `Loja adicional ${idx + 1}` : (l.cad_nome || "Loja");
    const dica = !nova && l.cad_endereco ? `<div style="font-size:12px;color:var(--muted);margin-bottom:6px">Endereço hoje no cadastro: ${esc(l.cad_endereco)}</div>` : "";
    const uf = sel => `<select class="lj-uf">${UFS_TERMO.map(u => `<option ${u === sel ? "selected" : ""}>${u}</option>`).join("")}</select>`;
    return `<div class="lj-card" data-id="${nova ? "" : l.id}" data-nova="${nova ? 1 : 0}" style="border:1.5px solid var(--line);border-radius:12px;padding:14px;margin:12px 0;background:#fff">
      <div style="display:flex;justify-content:space-between;align-items:center"><b>${esc(rot)}</b>${nova ? '<button class="btn" type="button" onclick="this.closest(\'.lj-card\').remove()">Remover</button>' : ""}</div>${dica}
      <div class="form-grid">
        <div class="field"><label>Razão social *</label><input class="lj-razao" value="${esc(nova ? "" : (l.cad_nome || ""))}"></div>
        <div class="field"><label>CNPJ *</label><input class="lj-cnpj" inputmode="numeric" placeholder="00.000.000/0000-00" value="${esc(nova ? "" : tMaskCnpj(l.cad_cnpj))}"></div>
      </div>
      <div class="field" style="background:#fff8e1;border:2px solid #f59e0b;border-radius:10px;padding:10px"><label style="font-size:14px;font-weight:800;color:#92400e">CEP * (obrigatório — preenche o endereço e define a distância do Motor)</label>
        <input class="lj-cep" inputmode="numeric" placeholder="00000-000" maxlength="9" style="font-size:20px;font-weight:800;letter-spacing:1px" value="${esc(nova ? "" : tMaskCep(l.cad_cep))}"><div class="lj-cepmsg" style="font-size:12px;margin-top:4px"></div></div>
      <div class="form-grid">
        <div class="field"><label>Logradouro *</label><input class="lj-log"></div>
        <div class="field"><label>Número * (S/N se não houver)</label><input class="lj-num"></div>
        <div class="field"><label>Bairro *</label><input class="lj-bai"></div>
        <div class="field"><label>Complemento</label><input class="lj-comp"></div>
        <div class="field"><label>Cidade *</label><input class="lj-cid" value="${esc(nova ? "" : (l.cad_cidade || ""))}"></div>
        <div class="field"><label>UF *</label>${uf(nova ? "" : l.cad_estado)}</div>
      </div></div>`;
}

function formularioRevenda(d) {
    return `<h4 style="margin-top:14px">Dados das lojas do grupo</h4>
      <p style="font-size:13px;color:var(--muted)">Confira e complete os dados de <b>todas</b> as lojas (CNPJ, endereço e CEP). Eles atualizam o seu cadastro no Portal automaticamente.</p>
      <div id="ljLista">${d.lojas.filter(l => !l.nova_loja).map((l, i) => cartaoLoja(l, i, false)).join("")}</div>
      <button class="btn" type="button" onclick="adicionarLojaTermo()">+ Adicionar outra loja do grupo</button>
      <h4 style="margin-top:16px">Signatário</h4>
      <div class="form-grid"><div class="field"><label>Nome completo *</label><input id="sgNome"></div><div class="field"><label>Cargo *</label><input id="sgCargo"></div><div class="field"><label>CPF *</label><input id="sgCpf" inputmode="numeric" placeholder="000.000.000-00"></div></div>
      <div class="field"><label>Observação (opcional)</label><textarea id="sgObs" rows="2" style="width:100%"></textarea></div>
      <label style="display:block;margin:10px 0"><input type="checkbox" id="sgAceite"> Li o termo acima, declaro representar o grupo e todas as lojas relacionadas e aceito.</label>
      <div id="sgErros" style="color:#e30613;font-size:13px;margin-bottom:8px"></div>
      <button class="btn primary" onclick="enviarTermoRevenda('${d.termo.id}')">Confirmar termo</button>`;
}

function adicionarLojaTermo() {
    const n = document.querySelectorAll('.lj-card[data-nova="1"]').length;
    $("ljLista").insertAdjacentHTML("beforeend", cartaoLoja({}, n, true));
    prepararFormularioRevenda();
}

function prepararFormularioRevenda() {
    document.querySelectorAll(".lj-card").forEach(card => {
        if (card.dataset.pronto) return; card.dataset.pronto = "1";
        const cep = card.querySelector(".lj-cep"), cnpj = card.querySelector(".lj-cnpj"), msg = card.querySelector(".lj-cepmsg");
        cnpj.addEventListener("input", () => { cnpj.value = tMaskCnpj(cnpj.value); cnpj.style.borderColor = tSoDig(cnpj.value).length === 14 && !tCnpjOk(cnpj.value) ? "#e30613" : ""; });
        cep.addEventListener("input", () => { cep.value = tMaskCep(cep.value); msg.textContent = ""; cep.style.borderColor = ""; });
        cep.addEventListener("blur", async () => {
            if (tSoDig(cep.value).length !== 8) { if (cep.value) { cep.style.borderColor = "#e30613"; msg.style.color = "#e30613"; msg.textContent = "CEP incompleto — use 00000-000."; } return; }
            try {
                const r = await tApi(`/cep/${tSoDig(cep.value)}`);
                if (r.naoEncontrado) { cep.style.borderColor = "#e30613"; msg.style.color = "#e30613"; msg.textContent = "CEP não encontrado."; return; }
                if (r.indisponivel) { msg.style.color = "#92400e"; msg.textContent = "Consulta de CEP indisponível agora — preencha o endereço à mão."; return; }
                const set = (c, v) => { const el = card.querySelector(c); if (el && v && !el.value) el.value = v; };
                set(".lj-log", r.logradouro); set(".lj-bai", r.bairro); set(".lj-cid", r.cidade);
                if (r.estado) card.querySelector(".lj-uf").value = r.estado;
                msg.style.color = "#16a34a"; msg.textContent = `✓ ${r.cidade || ""}/${r.estado || ""}`;
            } catch (_) { /* sem consulta, segue manual */ }
        });
    });
    const cpf = $("sgCpf"); if (cpf && !cpf.dataset.pronto) { cpf.dataset.pronto = "1"; cpf.addEventListener("input", () => { cpf.value = tMaskCpf(cpf.value); }); }
}

async function enviarTermoRevenda(id) {
    const erros = [];
    const cards = [...document.querySelectorAll(".lj-card")];
    const val = (c, s) => c.querySelector(s).value.trim();
    const lojas = [], novas = [];
    cards.forEach((c, i) => {
        const o = { id: c.dataset.id || null, razao_social: val(c, ".lj-razao"), cnpj: val(c, ".lj-cnpj"), cep: val(c, ".lj-cep"), logradouro: val(c, ".lj-log"), numero: val(c, ".lj-num"), bairro: val(c, ".lj-bai"), complemento: val(c, ".lj-comp"), cidade: val(c, ".lj-cid"), estado: val(c, ".lj-uf") };
        const r = `Loja ${i + 1}`;
        if (!o.razao_social) erros.push(`${r}: razão social.`);
        if (!tCnpjOk(o.cnpj)) erros.push(`${r}: CNPJ inválido.`);
        if (tSoDig(o.cep).length !== 8) erros.push(`${r}: CEP inválido (00000-000).`);
        if (!o.logradouro || !o.numero || !o.bairro || !o.cidade || !o.estado) erros.push(`${r}: complete logradouro, número, bairro, cidade e UF.`);
        (c.dataset.nova === "1" ? novas : lojas).push(o);
    });
    if (new Set(cards.map(c => tSoDig(val(c, ".lj-cnpj")))).size !== cards.length) erros.push("Há CNPJ repetido.");
    if ($("sgNome").value.trim().split(" ").filter(Boolean).length < 2) erros.push("Informe o nome completo do signatário.");
    if (!$("sgCargo").value.trim()) erros.push("Informe o cargo.");
    if (!tCpfOk($("sgCpf").value)) erros.push("CPF inválido.");
    if (!$("sgAceite").checked) erros.push("Marque o aceite do termo.");
    $("sgErros").innerHTML = erros.map(e => `• ${esc(e)}`).join("<br>");
    if (erros.length) { toast("Corrija os campos destacados", "error"); return; }
    try {
        await tApi(`/${id}/revenda`, "POST", { nome: $("sgNome").value, cargo: $("sgCargo").value, cpf: $("sgCpf").value, observacao: $("sgObs").value, aceite: true, lojas, novas });
        toast("Termo confirmado. Agora o representante Boxer vai testemunhar."); show("dash"); verificarTermosPendentes();
    } catch (e) { $("sgErros").innerHTML = (e.erros || [e.message]).map(x => `• ${esc(x)}`).join("<br>"); toast(e.message, "error"); }
}

async function enviarTestemunha(id) {
    try { await tApi(`/${id}/testemunha`, "POST", { nome: $("tsNome").value, aceite: $("tsAceite").checked }); toast("Obrigado — testemunho registrado."); show("dash"); verificarTermosPendentes(); }
    catch (e) { toast(e.message, "error"); }
}
