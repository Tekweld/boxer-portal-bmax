let AUDIT_USERS = [];
let AUDIT_LOGS = [];
let AUDIT_CURRENT_PAGE = 1;
let AUDIT_HAS_NEXT = false;
let AUDIT_HAS_PREV = false;
let AUDIT_TOTAL = 0;
let AUDIT_PAGE_SIZE = 20;
let AUDIT_LOADED = false;

async function loadAuditUsers() {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/audit/users`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error("Erro ao carregar usuarios de auditoria");
        AUDIT_USERS = await res.json();

        const sel = $("adminLogUserFilter");
        if (sel) {
            sel.innerHTML = '<option value="">Todos os usuarios</option>' +
                AUDIT_USERS.map(u => `<option value="${u.user_id}">${esc(u.username)} (${esc(u.role)})</option>`).join("");
        }
    } catch (e) { console.error(e); toast("Erro ao carregar usuarios de auditoria", "error"); }
}

async function loadAuditLogs(page = 1) {
    try {
        const token = localStorage.getItem("token");
        const userId = $("adminLogUserFilter")?.value || "";
        const params = new URLSearchParams({ page, pageSize: AUDIT_PAGE_SIZE });
        if (userId) params.set("userId", userId);

        const res = await fetch(`${API_URL}/audit?${params}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error("Erro ao carregar logs de auditoria");
        const data = await res.json();

        AUDIT_LOGS = data.logs || [];
        AUDIT_CURRENT_PAGE = data.currentPage || 1;
        AUDIT_HAS_NEXT = !!data.hasNext;
        AUDIT_HAS_PREV = !!data.hasPrev;
        AUDIT_TOTAL = data.total || 0;

        renderAuditLogs();
        renderAuditPagination();
    } catch (e) { console.error(e); toast("Erro ao carregar logs de auditoria", "error"); }
}

function renderAuditLogs() {
    const wrap = $("adminLogsBody");
    if (!wrap) return;

    const filterVal = ($("adminLogFilter")?.value || "").toLowerCase();
    let filtered = AUDIT_LOGS;
    if (filterVal) {
        filtered = filtered.filter(l =>
            (l.action || "").toLowerCase().includes(filterVal) ||
            (l.entity_type || "").toLowerCase().includes(filterVal) ||
            (l.username || "").toLowerCase().includes(filterVal)
        );
    }

    if (!filtered.length) {
        wrap.innerHTML = '<div class="empty-state">Nenhum log encontrado.</div>';
        return;
    }

    const statusBadge = { success: "status-aprovado", error: "status-pendente", failed: "status-pendente" };

    let html = `<table class="extrato-table">
        <thead><tr>
            <th>Data/Hora</th>
            <th>Usuario</th>
            <th>Role</th>
            <th>Acao</th>
            <th>Entidade</th>
            <th>Status</th>
            <th>IP</th>
            <th>Detalhes</th>
        </tr></thead><tbody>`;

    for (const l of filtered) {
        const data = new Date(l.createdAt).toLocaleString("pt-BR");
        const entidade = l.entity_type ? `${esc(l.entity_type)}${l.entity_id ? " #" + esc(l.entity_id) : ""}` : "—";
        const badgeClass = statusBadge[l.status] || "status-utilizado";

        html += `<tr>
            <td style="white-space:nowrap">${esc(data)}</td>
            <td>${esc(l.username || "—")}</td>
            <td>${esc(l.role || "—")}</td>
            <td>${esc(l.action)}</td>
            <td>${entidade}</td>
            <td><span class="status-badge ${badgeClass}">${esc(l.status)}</span></td>
            <td>${esc(l.ip_address || "—")}</td>
            <td><button class="btn btn-sm" onclick="openAuditDetalhesModal(${l.id})">Ver</button></td>
        </tr>`;
    }
    html += "</tbody></table>";

    const stats = `<div class="admin-stats"><span><strong>${AUDIT_TOTAL}</strong> logs registrados</span></div>`;
    wrap.innerHTML = stats + html;
}

function renderAuditPagination() {
    const wrap = $("adminLogsPagination");
    if (!wrap) return;

    const totalPages = Math.max(1, Math.ceil(AUDIT_TOTAL / AUDIT_PAGE_SIZE));
    wrap.innerHTML = `
        <button class="btn btn-sm" ${AUDIT_HAS_PREV ? "" : "disabled"} onclick="loadAuditLogs(${AUDIT_CURRENT_PAGE - 1})">&larr; Anterior</button>
        <span>Pagina ${AUDIT_CURRENT_PAGE} de ${totalPages}</span>
        <button class="btn btn-sm" ${AUDIT_HAS_NEXT ? "" : "disabled"} onclick="loadAuditLogs(${AUDIT_CURRENT_PAGE + 1})">Proxima &rarr;</button>`;
}

function openAuditDetalhesModal(id) {
    const log = AUDIT_LOGS.find(l => String(l.id) === String(id));
    if (!log) return;

    const modal = $("adminModal");
    const content = $("adminModalContent");
    content.innerHTML = `
        <h3>Detalhes do Log</h3>
        <div class="form-row">
            <label>Metadata</label>
            <pre style="background:var(--bg-alt);padding:12px;border-radius:8px;overflow:auto;max-height:300px;font-size:12px">${esc(JSON.stringify(log.metadata || {}, null, 2))}</pre>
        </div>
        <div class="form-row">
            <label>User Agent</label>
            <p style="font-size:12px;color:var(--muted);word-break:break-all">${esc(log.user_agent || "—")}</p>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeAdminModal()">Fechar</button>
        </div>`;
    modal.classList.add("show");
}

async function initAuditLogs() {
    if (AUDIT_LOADED) return;
    AUDIT_LOADED = true;
    await loadAuditUsers();
    await loadAuditLogs(1);
}
