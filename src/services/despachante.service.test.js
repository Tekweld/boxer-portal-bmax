const { despachar, rodadasVencidas, pendentes, ultimoSlot, AGENDA } = require("./despachante.service");

const utc = (iso) => new Date(iso + "Z");

describe("agenda do despachante", () => {
    test("espelha o vercel.json (mesmos robôs e horários)", () => {
        const v = require("../../vercel.json").crons.filter(c => c.path !== "/api/cron/despachante");
        const doVercel = v.map(c => { const [min, hora] = c.schedule.split(" "); return c.path.replace(/^\/api\/cron\//, "").replace(/\?rodada=/, ":") + "@" + String(hora).padStart(2, "0") + ":" + String(min).padStart(2, "0"); }).sort();
        const daAgenda = AGENDA.flatMap(a => a.slots.map(s => (a.chave || a.robo) + "@" + s)).sort();
        expect(daAgenda).toEqual(doVercel);
    });
});

describe("rodadas vencidas e pendentes", () => {
    test("ultimoSlot pega hoje se já passou e ontem se ainda não chegou", () => {
        expect(ultimoSlot(utc("2026-11-27T13:00:00"), "09:00").toISOString()).toBe("2026-11-27T09:00:00.000Z");
        expect(ultimoSlot(utc("2026-11-27T08:00:00"), "09:00").toISOString()).toBe("2026-11-26T09:00:00.000Z");
    });
    test("só vence depois da carência de 10 minutos", () => {
        const cedo = rodadasVencidas(utc("2026-11-27T09:05:00")).map(r => r.chave);
        expect(cedo).not.toContain("auditor:manha");
        const depois = rodadasVencidas(utc("2026-11-27T09:12:00")).map(r => r.chave);
        expect(depois).toContain("auditor:manha");
    });
    test("passada a janela, deixa de correr atrás (próxima rodada cuida)", () => {
        expect(rodadasVencidas(utc("2026-11-27T15:30:00")).map(r => r.chave)).not.toContain("auditor:manha");   // 09:00 + 6 h = 15:00
    });
    test("sucesso depois do horário tira a rodada das pendentes; sucesso antigo não", () => {
        const v = rodadasVencidas(utc("2026-11-27T09:20:00")).filter(r => r.chave === "auditor:manha");
        expect(pendentes(v, new Map([["auditor", { ok: utc("2026-11-27T09:01:00"), qualquer: utc("2026-11-27T09:01:00") }]]))).toHaveLength(0);
        expect(pendentes(v, new Map([["auditor", { ok: utc("2026-11-26T16:00:00"), qualquer: utc("2026-11-26T16:00:00") }]]))).toHaveLength(1);
        expect(pendentes(v, new Map())).toHaveLength(1);
    });
    test("robô sem controle de repetição (expirar-cashback) NÃO é repetido depois de falha; só quando não há execução nenhuma", () => {
        const v = rodadasVencidas(utc("2026-11-27T10:20:00")).filter(r => r.chave === "expirar-cashback");
        expect(v[0].soAusente).toBe(true);
        const falhou = new Map([["expirar-cashback", { ok: utc("2026-11-26T10:00:00"), qualquer: utc("2026-11-27T10:00:05") }]]);
        expect(pendentes(v, falhou)).toHaveLength(0);
        expect(pendentes(v, new Map([["expirar-cashback", { ok: utc("2026-11-26T10:00:00"), qualquer: utc("2026-11-26T10:00:00") }]]))).toHaveLength(1);
    });
    test("robô comum é repetido depois de falha (recalcular-comissoes)", () => {
        const v = rodadasVencidas(utc("2026-11-27T12:20:00")).filter(r => r.chave === "recalcular-comissoes");
        const falhou = new Map([["recalcular-comissoes", { ok: utc("2026-11-27T09:00:00"), qualquer: utc("2026-11-27T12:00:05") }]]);
        expect(pendentes(v, falhou)).toHaveLength(1);
    });
    test("robôs diários nunca são recuperados de madrugada (janela fecha em horário comercial)", () => {
        const diarios = AGENDA.filter(a => a.slots.length === 1);
        for (const a of diarios) {
            const [h, m] = a.slots[0].split(":").map(Number);
            const fimJanela = new Date(Date.UTC(2026, 10, 27, h, m) + a.janelaH * 3600000);
            const horaBrt = (fimJanela.getUTCHours() + 24 - 3) % 24;
            expect(horaBrt).toBeLessThanOrEqual(21);   // até 21h de Brasília
            expect(horaBrt).toBeGreaterThanOrEqual(6);
        }
    });
    test("nenhuma janela invade a rodada seguinte do mesmo robô", () => {
        for (const a of AGENDA) {
            const horas = a.slots.map(x => { const [h, m] = x.split(":").map(Number); return h + m / 60; }).sort((p, q) => p - q);
            for (let i = 0; i < horas.length; i++) {
                const prox = i + 1 < horas.length ? horas[i + 1] : horas[0] + 24;
                expect(a.janelaH).toBeLessThan(prox - horas[i]);
            }
        }
    });
});

describe("despachar", () => {
    const base = (over = {}) => ({ sucessos: async () => new Map(), reservar: async () => 1, chamar: jest.fn(async () => ({ ok: true, status: 200 })), avisar: jest.fn(async () => {}), ...over });

    test("dispara a rodada perdida (caso real de 27/11: auditor das 09h UTC)", async () => {
        const deps = base({ sucessos: async () => new Map([["pci12-followup", { ok: utc("2026-11-27T10:00:30"), qualquer: utc("2026-11-27T10:00:30") }]]) });
        const r = await despachar({ agora: utc("2026-11-27T09:15:00"), deps });
        expect(deps.chamar).toHaveBeenCalledWith("/api/cron/auditor?rodada=manha", expect.any(Number));
        expect(r.acionados).toBe(1);
        expect(r.feitos[0].resultado).toBe("rodou");
    });
    test("não dispara se já houve sucesso depois do horário", async () => {
        const deps = base({ sucessos: async () => new Map([["auditor", { ok: utc("2026-11-27T09:02:00"), qualquer: utc("2026-11-27T09:02:00") }]]) });
        const r = await despachar({ agora: utc("2026-11-27T09:15:00"), deps });
        expect(deps.chamar).not.toHaveBeenCalled();
        expect(r.acionados).toBe(0);
    });
    test("outro despachante já reservou (reservar devolve null): não chama", async () => {
        const deps = base({ reservar: async () => null });
        const r = await despachar({ agora: utc("2026-11-27T09:15:00"), deps });
        expect(deps.chamar).not.toHaveBeenCalled();
        expect(r.acionados).toBe(0);
    });
    test("falha na 3ª tentativa avisa os admins; na 1ª não", async () => {
        const falha = async () => ({ ok: false, status: 500 });
        const d1 = base({ chamar: falha, reservar: async () => 1 });
        const r1 = await despachar({ agora: utc("2026-11-27T09:15:00"), deps: d1 });
        expect(r1.ok).toBe(false);
        expect(d1.avisar).not.toHaveBeenCalled();
        const d3 = base({ chamar: falha, reservar: async () => 3 });
        await despachar({ agora: utc("2026-11-27T09:15:00"), deps: d3 });
        expect(d3.avisar).toHaveBeenCalledTimes(1);
    });
    test("erro de rede conta como falha e não derruba o despachante", async () => {
        const deps = base({ chamar: async () => { throw new Error("timeout"); } });
        const r = await despachar({ agora: utc("2026-11-27T09:15:00"), deps });
        expect(r.feitos[0].resultado).toMatch(/falhou: timeout/);
    });
    test("sem tempo no ciclo, adia o resto", async () => {
        const deps = base();
        const r = await despachar({ agora: utc("2026-11-27T09:15:00"), deps, orcamentoMs: 10000 });
        expect(deps.chamar).not.toHaveBeenCalled();
        expect(r.feitos[0].resultado).toMatch(/adiado/);
    });
});
