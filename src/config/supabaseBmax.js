// Cliente compartilhado para o Supabase REST (projeto boxer-bmax). Dados de
// revenda (comercial_revendas_bmax) vivem neste projeto, não no boxer-sistemas —
// ver .claude/memory/feedback_bmax_supabase_keys.md.
const SB_BMAX_URL = "https://zsvtxutoewypyitajjwz.supabase.co";

function serviceKey() {
    const key = process.env.SUPABASE_SERVICE_KEY_BMAX || process.env.SUPABASE_SERVICE_KEY;
    if (!key) throw new Error("SUPABASE_SERVICE_KEY_BMAX não configurada");
    return key;
}

async function sbBmax(path, method = "GET", body = null, extraHeaders = null) {
    const key = serviceKey();
    const headers = {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: method === "POST" || method === "PATCH" ? "return=representation" : "",
        ...extraHeaders
    };
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${SB_BMAX_URL}/rest/v1${path}`, opts);
    if (!res.ok) {
        const e = await res.text();
        throw new Error(`Supabase ${res.status}: ${e}`);
    }
    return method === "DELETE" ? res : res.json().catch(() => ({}));
}

module.exports = { SB_BMAX_URL, sbBmax };
