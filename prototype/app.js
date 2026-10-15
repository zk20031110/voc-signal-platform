/**
 * 交互层：工作台渲染 / 证据下钻 / 评测与 Badcase 归因
 */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) =>
    String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[m]));

  const AGENTS = [
    { id: "agent1", idx: "01", name: "信号采集与标注", role: "提取问题标签、情感倾向与关键实体（逐条 / 批量可切换）" },
    { id: "agent2", idx: "02", name: "风险识别与归因", role: "结合历史信号库与跨渠道记录，判断偶发噪声还是扩散风险" },
    { id: "agent3", idx: "03", name: "洞察生成与行动建议", role: "逐组输出洞察报告与可执行建议，附证据链" }
  ];

  const LEVEL_COLOR = { "高": "var(--high)", "观察": "var(--watch)", "常规": "var(--normal)" };
  const LEVEL_ICON = { "高": "🔴", "观察": "🟡", "常规": "🟢" };

  const BUCKETS = [
    { key: "retrieval", name: "检索问题", desc: "历史信号库没命中、跨渠道记录没注入。典型表现：单条都对，就是串不成信号。" },
    { key: "model", name: "模型问题", desc: "语义理解本身出错，或输出结构损坏（缺字段、JSON 不合法）。" },
    { key: "prompt", name: "Prompt 问题", desc: "指令边界没写清，模型在两个可接受答案之间选了另一头。改 Prompt 就能收敛。" },
    { key: "data", name: "数据问题", desc: "语料本身残缺或歧义：没有用户标识、文本过短、渠道字段缺失。" },
    { key: "product", name: "产品设计问题", desc: "标签体系覆盖不到，或标注口径本身站不住。" }
  ];

  const state = { batchId: "A", running: false, result: null, index: {}, evalData: null, evalResult: null, attribution: {}, evalBusy: false, labelStore: { confirmed: [], candidates: [] }, reviewStore: { items: [] } };

  /* ============================ 极简 Markdown 渲染 ============================ */

  function inlineMd(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function mdToHtml(md) {
    const lines = String(md || "").replace(/\r/g, "").split("\n");
    let html = "";
    let inList = false;
    let tableRows = [];

    const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
    const closeTable = () => {
      if (!tableRows.length) return;
      const rows = tableRows.filter((r) => !/^\|[\s:|-]+\|$/.test(r.replace(/\s/g, "")));
      html += '<table class="md-table">';
      rows.forEach((r, i) => {
        const cells = r.split("|").slice(1, -1).map((c) => c.trim());
        const tag = i === 0 ? "th" : "td";
        html += "<tr>" + cells.map((c) => `<${tag}>${inlineMd(c)}</${tag}>`).join("") + "</tr>";
      });
      html += "</table>";
      tableRows = [];
    };

    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith("|")) { closeList(); tableRows.push(line); continue; }
      closeTable();
      if (!line) { closeList(); continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); const lvl = Math.min(4, h[1].length + 2); html += `<h${lvl} class="md-h">${inlineMd(h[2])}</h${lvl}>`; continue; }
      if (/^[-*]\s+/.test(line)) {
        if (!inList) { html += '<ul class="md-ul">'; inList = true; }
        html += `<li>${inlineMd(line.replace(/^[-*]\s+/, ""))}</li>`;
        continue;
      }
      html += `<p class="md-p">${inlineMd(line)}</p>`;
    }
    closeList();
    closeTable();
    return html;
  }

  /* ============================ 工作台 ============================ */

  function currentBatch() {
    return VOC_DATA.batches.find((b) => b.id === state.batchId);
  }

  function labelChip(label, extra) {
    const color = VOC_DATA.labelColors[label] || "#7C8479";
    return `<span class="lb" style="--lb:${color}">${esc(label)}${extra ? `<i>${esc(extra)}</i>` : ""}</span>`;
  }

  function renderBatchPicker() {
    $("#batchPicker").innerHTML = VOC_DATA.batches
      .map((b) => `
        <button class="batch-card ${b.id === state.batchId ? "is-active" : ""}" data-batch="${b.id}">
          <span class="bc-name">${esc(b.name)}</span>
          <span class="bc-scope">${esc(b.scope)} · ${b.feedbacks.length} 条</span>
        </button>`)
      .join("");
  }

  function renderSourceList() {
    const batch = currentBatch();
    $("#sourceList").innerHTML = batch.feedbacks
      .map((f) => {
        const color = VOC_DATA.channelColors[f.channel] || "#4A554D";
        const ann = state.index[f.id];
        const annHtml = ann
          ? `<div class="fb-anno">
              ${(ann.labels || []).map((l) => labelChip(l)).join("")}
              <span class="fb-sent fb-sent-${esc(ann.sentiment || "")}">${esc(ann.sentiment || "")}</span>
              ${ann.risk_level ? `<span class="fb-risk" style="--lvl:${LEVEL_COLOR[ann.risk_level]}">${LEVEL_ICON[ann.risk_level]} ${esc(ann.risk_level)}</span>` : ""}
              ${ann.is_new_signal ? '<span class="fb-new">新信号</span>' : ""}
            </div>`
          : "";
        return `
        <div class="fb-item" id="src-${esc(f.id)}" style="--ch:${color}">
          <div class="fb-meta">
            <span class="fb-id">${esc(f.id)}</span>
            <span class="fb-channel">${esc(f.channel)}</span>
            ${f.customer_ref ? `<span class="fb-ref">${esc(f.customer_ref)}</span>` : ""}
          </div>
          <div class="fb-text">${esc(f.text)}</div>
          ${annHtml}
        </div>`;
      })
      .join("");
  }

  function renderAgentStack(statuses) {
    const st = statuses || {};
    $("#agentStack").innerHTML = AGENTS.map((a) => {
      const s = st[a.id] || { status: "idle" };
      const cls = s.status === "running" ? "is-running" : s.status === "done" ? "is-done" : s.status === "error" ? "is-error" : "";
      const label = { idle: "待机", running: "运行中", done: "完成", error: "失败" }[s.status] || "待机";
      return `
      <div class="agent-card ${cls}">
        <div class="agent-head">
          <span class="agent-idx">${a.idx}</span>
          <span class="agent-name">${esc(a.name)}</span>
          <span class="agent-status">${label}</span>
        </div>
        ${s.status === "running" ? '<div class="scan"></div>' : ""}
        <div class="agent-body">${agentBody(a, s)}</div>
      </div>`;
    }).join("");
  }

  function progressText(s, unit) {
    if (s.done !== undefined && s.total !== undefined) {
      const pct = s.total ? Math.round((s.done / s.total) * 100) : 100;
      return `<div class="agent-role">并发处理中：${s.done} / ${s.total} ${unit}</div>
        <div class="bar"><span style="width:${pct}%"></span></div>`;
    }
    return '<div class="agent-role">正在推理…</div>';
  }

  function agentBody(agent, s) {
    if (s.status === "idle") return `<div class="agent-role">${esc(agent.role)}</div>`;
    if (s.status === "running") return progressText(s, agent.id === "agent1" ? "条反馈" : agent.id === "agent2" ? "张卡片" : "组信号");
    if (s.status === "error") return `<div class="agent-role" style="color:#E08A7E">${esc(s.message || "调用失败")}</div>`;

    if (agent.id === "agent1") {
      const cards = (s.cards || []);
      const dist = {};
      cards.forEach((c) => (c.labels || []).forEach((l) => { dist[l] = (dist[l] || 0) + 1; }));
      const news = cards.filter((c) => c.is_new_signal).length;
      const injL = (window.VOC_INJECT && window.VOC_INJECT.labels) || 0;
      const modeTxt = s.mode === "batch" ? "批量调用" : "逐条调用";
      const costTxt = s.demo
        ? "　离线固定样例，无模型调用"
        : s.calls
          ? `　${modeTxt} ${s.calls} 次模型调用${s.fallbacks ? `（回退 ${s.fallbacks} 批）` : ""}`
          : "";
      return `
        <div class="agent-role">已标注 ${cards.length} 条反馈${s.errors && s.errors.length ? `，失败 ${s.errors.length} 条` : ""}。${costTxt}</div>
        ${injL ? `<div class="agent-role" style="color:var(--amber)">已注入人工确认的自定义标签：${injL} 个</div>` : ""}
        <div class="stat-row">
          <div class="stat"><span class="stat-v">${cards.length}</span><span class="stat-k">已标注</span></div>
          <div class="stat"><span class="stat-v">${news}</span><span class="stat-k">新信号</span></div>
          <div class="stat"><span class="stat-v">${s.demo ? "—" : (s.ms / 1000).toFixed(1) + "s"}</span><span class="stat-k">${s.demo ? "真实耗时" : "耗时"}</span></div>
        </div>
        <div class="chip-wrap">${Object.keys(dist).sort((a, b) => dist[b] - dist[a]).map((l) => labelChip(l, dist[l])).join("")}</div>`;
    }

    if (agent.id === "agent2") {
      const risks = s.risks || [];
      const lv = { "高": 0, "观察": 0, "常规": 0 };
      risks.forEach((r) => { if (lv[r.risk_level] !== undefined) lv[r.risk_level]++; });
      const review = risks.filter((r) => r.need_human_review).length;
      const injR = (window.VOC_INJECT && window.VOC_INJECT.reviews) || null;
      const injLine = injR && (injR.confirmed || injR.rejected)
        ? `<div class="agent-role" style="color:var(--amber)">已注入人工复核结论：确认 ${injR.confirmed} 条 / 误报 ${injR.rejected} 条</div>`
        : "";
      return `
        <div class="agent-role">${s.demo ? "固定样例结果，用于查看风险分级和人工复核交互。" : `逐条完成风险判断${s.errors && s.errors.length ? `，失败 ${s.errors.length} 条` : ""}。`}</div>
        ${injLine}
        <div class="stat-row">
          <div class="stat is-high"><span class="stat-v">${lv["高"]}</span><span class="stat-k">🔴 高优先级</span></div>
          <div class="stat is-watch"><span class="stat-v">${lv["观察"]}</span><span class="stat-k">🟡 观察</span></div>
          <div class="stat is-normal"><span class="stat-v">${lv["常规"]}</span><span class="stat-k">🟢 常规</span></div>
          <div class="stat"><span class="stat-v">${review}</span><span class="stat-k">需人工复核</span></div>
        </div>`;
    }

    const reports = (s.reports || []);
    return `
      <div class="agent-role">${s.demo ? "固定样例报告，用于查看证据回溯与建议展示。" : `按「风险等级 + 主标签」聚合后生成 ${reports.length} 份洞察报告。`}</div>
      <div class="stat-row">
        <div class="stat"><span class="stat-v">${reports.length}</span><span class="stat-k">报告数</span></div>
        <div class="stat"><span class="stat-v">${s.demo ? "—" : (s.ms / 1000).toFixed(1) + "s"}</span><span class="stat-k">${s.demo ? "真实耗时" : "耗时"}</span></div>
      </div>`;
  }

  function setLed(stage, status, payload) {
    const led = $(`.led[data-stage="${stage}"]`);
    if (!led) return;
    led.classList.remove("is-running", "is-done", "is-error");
    if (status && status !== "idle") led.classList.add("is-" + status);
    const t = led.querySelector("[data-time]");
    if (t) t.textContent = payload && payload.ms ? (payload.ms / 1000).toFixed(1) + "s" : "—";
  }

  function groupCard(g) {
    const color = LEVEL_COLOR[g.risk_level] || "var(--line-2)";
    const samples = g.samples || [];
    return `
    <div class="signal" style="--lvl:${color}">
      <div class="signal-head">
        <span class="risk-badge">${LEVEL_ICON[g.risk_level] || ""} ${esc(g.risk_level)}</span>
        <span class="signal-title">${esc(g.primary_label)} · ${g.feedback_ids.length} 条反馈</span>
      </div>
      <div class="signal-body">
        <div class="field"><span class="field-k">风险依据</span><div>${esc(g.reasons.slice(0, 2).join("；") || "—")}</div></div>
        <div class="field"><span class="field-k">归因分析</span><div>${esc(g.attributions.slice(0, 2).join("；") || "—")}</div></div>
        <div class="field"><span class="field-k">来源渠道</span><div>${esc((g.channels || []).join(" / ") || "—")}</div></div>
        ${g.need_human_review ? `<div class="flag-row"><span class="flag hil">需人工复核</span>${g.review_reason ? `<span class="flag">${esc(String(g.review_reason).slice(0, 40))}</span>` : ""}</div>` : ""}
        <div class="evidence-chips">
          ${(g.feedback_ids || []).map((id) => `<span class="chip" data-jump="${esc(id)}">${esc(id)}</span>`).join("")}
        </div>
      </div>
    </div>`;
  }

  function reportCard(r) {
    const g = r.group;
    const color = LEVEL_COLOR[g.risk_level] || "var(--line-2)";
    // 解析出的编号必须真实存在于当前批次，否则不生成跳转（防止虚构编号）
    const known = {};
    currentBatch().feedbacks.forEach((f) => { known[f.id] = true; });
    const ids = VOC_PIPELINE.parseEvidenceIds(r.markdown).filter((id) => known[id]);
    return `
    <div class="report" style="--lvl:${color}">
      <div class="report-head">
        <span class="risk-badge">${LEVEL_ICON[g.risk_level] || ""} ${esc(g.risk_level)}</span>
        <span class="report-title">${esc(g.primary_label)}</span>
      </div>
      <div class="md-body">${mdToHtml(r.markdown)}</div>
      ${ids.length ? `<div class="evidence-chips">${ids.map((id) => `<span class="chip" data-jump="${esc(id)}">${esc(id)}</span>`).join("")}</div>` : ""}
    </div>`;
  }

  function renderVerdict() {
    const r = state.result;
    if (!r) return;
    const body = $("#verdictBody");

    if (r.errors && r.errors.length) {
      body.innerHTML = `<div class="placeholder err">流水线中断：${esc(r.errors[0].message)}</div>`;
      return;
    }

    const groups = r.groups || [];
    const reports = (r.agent3 && r.agent3.reports) || [];
    const high = groups.filter((g) => g.risk_level === "高");
    let html = "";

    if (r.demo) {
      html += '<div class="placeholder">离线样例演示：以下为项目内固定结果，未调用模型，不代表实时分析效果；本次不会写入标签或复核记录。</div>';
    }

    html += `<div class="section-label"><span>历史信号库 · 过去 7 天</span></div>
      <div class="history-grid">${Object.keys(VOC_DATA.history7d).map((k) => {
        const h = VOC_DATA.history7d[k];
        const c = VOC_DATA.labelColors[k] || "#7C8479";
        return `<div class="hist" style="--lb:${c}"><span class="hist-k">${esc(k)}</span><span class="hist-v">${h.total}<i>条 / 负面 ${h.negative}</i></span><span class="hist-t">${esc(h.trend)}</span></div>`;
      }).join("")}</div>`;

    html += `<div class="section-label"><span>风险分组</span><span>${groups.length} 组</span></div>`;
    if (!groups.length) html += '<div class="placeholder">本批次未形成风险分组</div>';
    html += groups.map(groupCard).join("");

    if (reports.length) {
      html += `<div class="section-label"><span>洞察报告</span><span>${reports.length} 份 · 仅高与观察</span></div>`;
      html += reports.map(reportCard).join("");
    }

    if (high.length) {
      html += `<div class="hil-note"><span class="hn-title">HUMAN-IN-THE-LOOP</span>
        本批次含 ${high.length} 组高优先级信号，需人工复核后才对外推送。</div>`;
    }

    body.innerHTML = html;
  }

  function jumpToSource(id) {
    const el = document.getElementById("src-" + id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("is-hit");
    void el.offsetWidth;
    el.classList.add("is-hit");
  }

  /* ============================ 运行流水线 ============================ */

  function buildIndex(result) {
    const idx = {};
    if (!result) return idx;
    const risks = (result.agent2 && result.agent2.risks) || [];
    const byId = {};
    risks.forEach((r) => { byId[r.feedback_id] = r; });
    ((result.agent1 && result.agent1.cards) || []).forEach((c) => {
      const r = byId[c.feedback_id] || {};
      idx[c.feedback_id] = {
        labels: c.labels || [],
        sentiment: c.sentiment,
        is_new_signal: !!c.is_new_signal,
        risk_level: r.risk_level,
        need_human_review: !!r.need_human_review
      };
    });
    return idx;
  }

  async function runPipeline(demoMode) {
    if (state.running) return;
    state.running = true;
    const btn = $("#runBtn");
    const demoBtn = $("#demoBtn");
    btn.disabled = true;
    if (demoBtn) demoBtn.disabled = true;
    $(".btn-text", btn).textContent = demoMode ? "演示中…" : "分析中…";

    const batch = demoMode ? VOC_DATA.batches.find((item) => item.id === "A") : currentBatch();
    if (demoMode && state.batchId !== batch.id) {
      state.batchId = batch.id;
      renderBatchPicker();
    }
    state.result = null;
    state.index = {};
    const statuses = {};
    ["agent1", "agent2", "agent3"].forEach((s) => { statuses[s] = { status: "idle" }; setLed(s, "idle"); });
    renderSourceList();
    renderAgentStack(statuses);
    $("#verdictBody").innerHTML = '<div class="placeholder">流水线运行中，等待上游输出…</div>';

    try {
      const onStage = (stage, status, payload) => {
        statuses[stage] = Object.assign({ status }, payload || {});
        setLed(stage, status, payload);
        renderAgentStack(statuses);
        if (status === "error") {
          $("#verdictBody").innerHTML = `<div class="placeholder err">${esc(stage)} 失败：${esc((payload && payload.message) || "")}</div>`;
        }
      };
      state.result = demoMode
        ? await VOC_PIPELINE.runDemoPipeline(batch, onStage)
        : await VOC_PIPELINE.runPipeline(batch, onStage);
      state.index = buildIndex(state.result);
      renderSourceList();
      renderVerdict();
      if (!demoMode) {
        if (collectNewSignals(state.result)) { renderLabels(); saveLabels(); }
        if (collectReviews(state.result)) { renderReviews(); saveReviews(); }
      }
      ["agent1", "agent2", "agent3"].forEach((s, i) => {
        const led = $(`.led[data-stage="${s}"]`);
        if (led && !led.classList.contains("is-error") && state.result && (i < 2 ? true : state.result.agent3)) {
          if (!led.classList.contains("is-done")) setLed(s, "done", {});
        }
      });
    } catch (e) {
      $("#verdictBody").innerHTML = `<div class="placeholder err">运行失败：${esc(e.message)}</div>`;
    } finally {
      state.running = false;
      btn.disabled = false;
      $(".btn-text", btn).textContent = "采集并分析";
      if (demoBtn) demoBtn.disabled = false;
      if (window.VOC_LAST_MODEL) $("#modelTag").textContent = window.VOC_LAST_MODEL;
    }
  }

  /* ============================ 评测 ============================ */

  function matchField(actual, expect) {
    if (Array.isArray(expect)) return expect.indexOf(actual) !== -1;
    return actual === expect;
  }

  function evalPseudoBatch(cases) {
    return {
      id: "EVAL",
      feedbacks: cases.map((c) => ({
        id: c.id, channel: c.channel, customer_ref: c.customer_ref,
        product: c.product, time: c.time, text: c.text
      }))
    };
  }

  async function runEval(testsetFile, btn) {
    if (state.evalBusy) return;
    state.evalBusy = true;
    btn.disabled = true;
    const busyLabel = $(".btn-text", btn).textContent;
    $(".btn-text", btn).textContent = "评测中…";

    try {
      if (!state.evalData || state.evalDataFile !== testsetFile) {
        const res = await fetch("/eval/" + testsetFile);
        if (!res.ok) throw new Error("无法加载评测集（HTTP " + res.status + "）");
        state.evalData = await res.json();
        state.evalDataFile = testsetFile;
      }
      $("#metricGrid").innerHTML = '<div class="placeholder wide">正在跑 ' + state.evalData.cases.length + ' 条用例…</div>';
      const cases = state.evalData.cases;
      const r = await VOC_PIPELINE.runPipeline(evalPseudoBatch(cases), (stage, status, payload) => {
        if (stage === "agent1" && status === "running" && payload && payload.done !== undefined) {
          $("#metricGrid").innerHTML = `<div class="placeholder wide">Agent1 标注中：${payload.done} / ${payload.total} 条</div>`;
        }
        if (stage === "agent2" && status === "running" && payload && payload.done !== undefined) {
          $("#metricGrid").innerHTML = `<div class="placeholder wide">Agent2 风险判断中：${payload.done} / ${payload.total} 条</div>`;
        }
      }, { skipAgent3: true });

      if (!r.agent1 || !r.agent1.cards.length || !r.agent2) {
        throw new Error((r.errors[0] && r.errors[0].message) || "上游调用失败");
      }
      state.evalResult = computeMetrics(cases, r.agent1.cards, r.agent2.risks);
      renderEval(state.evalResult);
    } catch (e) {
      $("#metricGrid").innerHTML = `<div class="placeholder wide err">评测失败：${esc(e.message)}</div>`;
    } finally {
      state.evalBusy = false;
      btn.disabled = false;
      $(".btn-text", btn).textContent = busyLabel;
    }
  }

  function computeMetrics(cases, cards, risks) {
    const cardById = {};
    cards.forEach((c) => { cardById[c.feedback_id] = c; });
    const riskById = {};
    risks.forEach((r) => { riskById[r.feedback_id] = r; });

    let labelOk = 0, sentOk = 0, newOk = 0, newTotal = 0;
    let tp = 0, fp = 0, fn = 0;
    let highTotal = 0, highHit = 0, normalTotal = 0, falseHit = 0;
    const rows = [];

    cases.forEach((c) => {
      const exp = c.expect || {};
      const card = cardById[c.id] || null;
      const risk = riskById[c.id] || null;
      const actualLabels = card ? (card.labels || []) : [];
      const actualSent = card ? card.sentiment : "缺失";
      const actualNew = card ? !!card.is_new_signal : false;
      const actualRisk = risk ? risk.risk_level : "缺失";

      const reqLabels = exp.labels || [];
      const anyLabels = exp.labels_any || [];
      const lOk = !!card
        && reqLabels.every((l) => actualLabels.indexOf(l) !== -1)
        && (anyLabels.length === 0 || anyLabels.some((l) => actualLabels.indexOf(l) !== -1));
      const sOk = !!card && matchField(actualSent, exp.sentiment);
      const nOk = actualNew === !!exp.is_new_signal;
      labelOk += lOk ? 1 : 0;
      sentOk += sOk ? 1 : 0;

      if (typeof exp.sentiment === "string") {
        const expNeg = exp.sentiment === "负面";
        const actNeg = actualSent === "负面";
        if (expNeg && actNeg) tp++;
        else if (!expNeg && actNeg) fp++;
        else if (expNeg && !actNeg) fn++;
      }

      if (exp.is_new_signal) { newTotal++; if (actualNew) newOk++; }

      let riskOk = true;
      if (exp.risk_level === "高") {
        highTotal++;
        if (actualRisk === "高") highHit++; else riskOk = false;
      } else if (exp.risk_level === "常规") {
        normalTotal++;
        if (actualRisk === "高" || actualRisk === "观察") { falseHit++; riskOk = false; }
      }

      rows.push({ c, card, risk, actualLabels, actualSent, actualRisk, lOk, sOk, nOk, riskOk, pass: lOk && sOk && nOk && riskOk });
    });

    const total = cases.length;
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

    rows.forEach((r) => {
      if (!r.pass && !state.attribution[r.c.id]) state.attribution[r.c.id] = suggestBucket(r);
    });

    return {
      rows,
      metrics: {
        labelAcc: labelOk / total,
        sentF1: f1,
        newRecall: newTotal ? newOk / newTotal : null,
        highRecall: highTotal ? highHit / highTotal : null,
        falseRate: normalTotal ? falseHit / normalTotal : null,
        passRate: rows.filter((r) => r.pass).length / total
      }
    };
  }

  function suggestBucket(row) {
    const exp = row.c.expect || {};
    if (!row.card) return "model";
    if (exp.debatable) return "product";
    if (exp.risk_level === "高" && row.c.cross_channel) return "retrieval";
    if (row.lOk && row.sOk && row.nOk) return "prompt";
    if (row.c.category === "歧义反馈" || row.c.category === "对抗与边界") return "data";
    if (row.lOk && !row.sOk) return "prompt";
    return "model";
  }

  function renderEval(result) {
    const m = result.metrics;
    const pct = (v) => (v === null || v === undefined ? "—" : (v * 100).toFixed(1) + "%");
    const cardsHtml = [
      { k: "标签命中率", v: pct(m.labelAcc), layer: "模型层", desc: "预测标签完整包含专家标注标签的比例", a: "var(--ch-eval)" },
      { k: "情感判断 F1", v: m.sentF1.toFixed(3), layer: "模型层", desc: "负面类别的精确率与召回率调和平均", a: "var(--ch-chat)" },
      { k: "新信号召回率", v: pct(m.newRecall), layer: "模型层", desc: "应标为新信号的用例中被成功识别的比例", a: "var(--ch-after)" },
      { k: "高风险召回率", v: pct(m.highRecall), layer: "业务层", desc: "专家标注为高优先级的用例中被判为「高」的比例", a: "var(--high)" },
      { k: "误报率", v: pct(m.falseRate), layer: "业务层", desc: "专家标注为常规的用例被升级为高或观察的比例", a: "var(--watch)" },
      { k: "用例通过率", v: pct(m.passRate), layer: "综合", desc: "标签、情感、新信号、风险等级四项全中的比例", a: "var(--normal)" }
    ];

    $("#metricGrid").innerHTML = cardsHtml.map((c) => `
      <div class="metric-card" style="--accent:${c.a}">
        <div class="metric-v">${esc(c.v)}</div>
        <div class="metric-k">${esc(c.k)}</div>
        <span class="metric-layer">${esc(c.layer)}</span>
        <div class="metric-desc">${esc(c.desc)}</div>
      </div>`).join("");

    const passCount = result.rows.filter((r) => r.pass).length;
    $("#caseSub").textContent = `${passCount} / ${result.rows.length} 命中`;

    const head = "<thead><tr><th>用例</th><th>场景</th><th>期望 / 实际</th><th>判定</th><th>归因</th></tr></thead>";
    const bodyHtml = result.rows.map((r) => {
      const exp = r.c.expect || {};
      const expLabels = [(exp.labels || []).join(" + "), (exp.labels_any || []).join(" 或 ")].filter(Boolean).join(" ／ ");
      const actLabels = r.actualLabels.length ? r.actualLabels.join(" + ") : "缺失";
      const expSent = Array.isArray(exp.sentiment) ? exp.sentiment.join(" 或 ") : exp.sentiment;
      const sel = r.pass ? "" : `<select class="attr-select" data-case="${esc(r.c.id)}">
          ${BUCKETS.map((b) => `<option value="${b.key}" ${state.attribution[r.c.id] === b.key ? "selected" : ""}>${esc(b.name)}</option>`).join("")}
        </select>`;
      return `<tr data-case="${esc(r.c.id)}">
        <td class="c-id">${esc(r.c.id)}</td>
        <td class="c-cat">${esc(r.c.category)}<br><span style="color:var(--muted-2);font-size:10px">${esc(r.c.channel)}</span></td>
        <td class="exp-vs-act">
          标签 <span class="${r.lOk ? "right" : "wrong"}">${esc(expLabels)}</span> / <span class="${r.lOk ? "right" : "wrong"}">${esc(actLabels)}</span><br>
          情感 <span class="${r.sOk ? "right" : "wrong"}">${esc(expSent)}</span> / <span class="${r.sOk ? "right" : "wrong"}">${esc(r.actualSent)}</span><br>
          风险 <span class="${r.riskOk ? "right" : "wrong"}">${esc(exp.risk_level || "不限")}</span> / <span class="${r.riskOk ? "right" : "wrong"}">${esc(r.actualRisk)}</span>
        </td>
        <td>${r.pass ? '<span class="verdict-pass">PASS</span>' : '<span class="verdict-fail">FAIL</span>'}</td>
        <td>${sel}</td>
      </tr>`;
    }).join("");
    $("#caseTable").innerHTML = head + "<tbody>" + bodyHtml + "</tbody>";

    renderBuckets(result.rows);
  }

  function renderBuckets(rows) {
    const failed = rows.filter((r) => !r.pass);
    if (!failed.length) {
      $("#bucketList").innerHTML = '<div class="placeholder">本次评测无 Badcase</div>';
      return;
    }
    $("#bucketList").innerHTML = BUCKETS.map((b) => {
      const items = failed.filter((r) => state.attribution[r.c.id] === b.key);
      return `<div class="bucket">
        <div class="bucket-top"><span class="bucket-name">${esc(b.name)}</span><span class="bucket-count">${items.length}</span></div>
        <div class="bucket-desc">${esc(b.desc)}</div>
        <div class="bucket-items">${items.map((r) => `<span class="chip" data-cycle="${esc(r.c.id)}" title="${esc(r.c.checkpoint || "")}">${esc(r.c.id)}</span>`).join("")}</div>
      </div>`;
    }).join("");
  }

  /* ============================ 标签体系演化 ============================ */

  async function loadLabels() {
    try {
      const res = await fetch("/api/labels");
      if (res.ok) state.labelStore = await res.json();
    } catch (e) { /* 服务端不可用时就只用内存里的 */ }
    if (!state.labelStore.confirmed) state.labelStore.confirmed = [];
    if (!state.labelStore.candidates) state.labelStore.candidates = [];
    renderLabels();
  }

  async function saveLabels() {
    try {
      await fetch("/api/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.labelStore)
      });
    } catch (e) { /* 保存失败不阻断界面操作 */ }
  }

  /** 把本轮结果里标记为「新信号」的概念汇总进候选池。同一个 feedback_id 只计一次，反复重跑不会把计数刷高。 */
  function collectNewSignals(result) {
    const cards = (result && result.agent1 && result.agent1.cards) || [];
    const batch = currentBatch();
    const textById = {};
    batch.feedbacks.forEach((f) => { textById[f.id] = f.text; });
    let changed = false;

    cards.forEach((card) => {
      if (!card.is_new_signal || !card.suggested_label) return;
      const name = String(card.suggested_label).trim();
      if (!name) return;
      let item = state.labelStore.candidates.filter((x) => x.name === name)[0];
      if (!item) {
        item = { name: name, count: 0, sources: [], examples: [] };
        state.labelStore.candidates.push(item);
      }
      item.sources = item.sources || [];
      item.examples = item.examples || [];
      if (item.sources.indexOf(card.feedback_id) === -1) {
        item.sources.push(card.feedback_id);
        item.count = item.sources.length;
        if (item.examples.length < 3 && textById[card.feedback_id]) {
          item.examples.push({ feedback_id: card.feedback_id, text: textById[card.feedback_id] });
        }
        changed = true;
      }
    });

    const before = state.labelStore.candidates.length;
    state.labelStore.candidates = state.labelStore.candidates.filter(
      (c) => state.labelStore.confirmed.indexOf(c.name) === -1
    );
    return changed || state.labelStore.candidates.length !== before;
  }

  function renderLabels() {
    const confirmed = state.labelStore.confirmed || [];
    const candidates = (state.labelStore.candidates || []).slice()
      .sort((a, b) => (b.count || 0) - (a.count || 0));

    $("#candSub").textContent = candidates.length ? candidates.length + " 个待审" : "无待审概念";
    $("#candidateList").innerHTML = candidates.length
      ? candidates.map((c) => `
        <div class="bucket">
          <div class="bucket-top">
            <span class="bucket-name">${esc(c.name)}</span>
            <span class="bucket-count">${c.count || 0}</span>
          </div>
          <div class="bucket-desc">出现在 ${(c.sources || []).length} 条反馈里</div>
          ${(c.examples || []).map((e) => `<div class="cand-example"><span class="chip chip-static">${esc(e.feedback_id)}</span>${esc(e.text)}</div>`).join("")}
          <div class="cand-actions">
            <button class="mini-btn is-primary" data-confirm="${esc(c.name)}">确认为正式标签</button>
            <button class="mini-btn" data-ignore="${esc(c.name)}">忽略</button>
          </div>
        </div>`).join("")
      : '<div class="placeholder">跑一次分析后，这里会汇总体系外的新概念</div>';

    $("#confirmedSub").textContent = (VOC_DATA.presetLabels.length + confirmed.length) + " 个生效中";
    $("#confirmedList").innerHTML = `
      <div class="bucket">
        <div class="bucket-top"><span class="bucket-name">预设标签</span><span class="bucket-count">${VOC_DATA.presetLabels.length}</span></div>
        <div class="chip-wrap">${VOC_DATA.presetLabels.map((l) => labelChip(l)).join("")}</div>
      </div>
      <div class="bucket">
        <div class="bucket-top"><span class="bucket-name">人工确认的自定义标签</span><span class="bucket-count">${confirmed.length}</span></div>
        ${confirmed.length
          ? `<div class="chip-wrap">${confirmed.map((l) => `<span class="lb" style="--lb:#B08968">${esc(l)}<button class="lb-x" data-remove="${esc(l)}" title="移除">×</button></span>`).join("")}</div>
             <div class="bucket-desc">Agent1 下次标注时会自动带上这些标签。</div>`
          : '<div class="bucket-desc">还没有确认过任何概念。确认后，Agent1 下次标注会自动带上它。</div>'}
      </div>`;
  }

  async function confirmLabel(name) {
    if (state.labelStore.confirmed.indexOf(name) === -1) state.labelStore.confirmed.push(name);
    state.labelStore.candidates = state.labelStore.candidates.filter((c) => c.name !== name);
    renderLabels();
    await saveLabels();
  }

  async function ignoreLabel(name) {
    state.labelStore.candidates = state.labelStore.candidates.filter((c) => c.name !== name);
    renderLabels();
    await saveLabels();
  }

  async function removeLabel(name) {
    state.labelStore.confirmed = state.labelStore.confirmed.filter((l) => l !== name);
    renderLabels();
    await saveLabels();
  }
  /* ============================ 人工复核与回流 ============================ */

  const REVIEW_LABEL = { confirmed: "确认真实风险", rejected: "判定为误报" };

  async function loadReviews() {
    try {
      const res = await fetch("/api/reviews");
      if (res.ok) state.reviewStore = await res.json();
    } catch (e) { /* 服务端不可用时只用内存里的 */ }
    if (!Array.isArray(state.reviewStore.items)) state.reviewStore.items = [];
    renderReviews();
  }

  async function saveReviews() {
    try {
      await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.reviewStore)
      });
    } catch (e) { /* 保存失败不阻断界面操作 */ }
  }

  /** 把本轮需要人工复核的分组推进待复核队列。同一个分组不重复入队，已判定过的保留结论。 */
  function collectReviews(result) {
    const groups = (result && result.groups) || [];
    const batch = currentBatch();
    let changed = false;
    groups.forEach((g) => {
      if (!g.need_human_review) return;
      const id = [batch.id, g.primary_label, g.risk_level, (g.feedback_ids || []).join("-")].join("|");
      if (state.reviewStore.items.some((x) => x.id === id)) return;
      state.reviewStore.items.push({
        id: id,
        batch: batch.id,
        batch_name: batch.name,
        risk_level: g.risk_level,
        primary_label: g.primary_label,
        reasons: (g.reasons || []).slice(0, 2),
        attributions: (g.attributions || []).slice(0, 2),
        channels: g.channels || [],
        samples: (g.samples || []).slice(0, 4),
        status: "pending",
        reviewed_at: null
      });
      changed = true;
    });
    return changed;
  }

  function reviewCard(item) {
    const color = LEVEL_COLOR[item.risk_level] || "var(--line-2)";
    const pending = item.status === "pending";
    return `
    <div class="review-card" style="--lvl:${color}">
      <div class="review-head">
        <span class="risk-badge">${LEVEL_ICON[item.risk_level] || ""} ${esc(item.risk_level)}</span>
        <span class="review-title">${esc(item.primary_label)}</span>
        ${pending ? "" : `<span class="decision ${esc(item.status)}">${esc(REVIEW_LABEL[item.status] || "")}</span>`}
        <span class="review-meta">${esc(item.batch_name)} · ${esc(item.reviewed_at || "待判定")}</span>
      </div>
      <div class="review-field"><span class="rk">风险依据</span><div class="rv">${esc((item.reasons || [])[0] || "—")}</div></div>
      <div class="review-field"><span class="rk">归因分析</span><div class="rv">${esc((item.attributions || [])[0] || "—")}</div></div>
      <div class="review-evidence">
        <div class="rk">证据原文 · ${(item.samples || []).length} 条 · ${esc((item.channels || []).join(" / ") || "—")}</div>
        ${(item.samples || []).map((s) => `<div class="ev-line"><span class="chip chip-static">${esc(s.feedback_id)}</span> ${esc(s.text)}</div>`).join("")}
      </div>
      ${pending ? `<div class="review-actions">
        <button class="mini-btn is-approve" data-approve="${esc(item.id)}">确认真实风险</button>
        <button class="mini-btn is-reject" data-reject="${esc(item.id)}">判定为误报</button>
      </div>` : ""}
    </div>`;
  }

  function renderReviews() {
    const items = state.reviewStore.items || [];
    const pending = items.filter((x) => x.status === "pending");
    const done = items.filter((x) => x.status !== "pending").slice().reverse();

    $("#pendingSub").textContent = pending.length ? pending.length + " 条待判定" : "全部处理完";
    $("#pendingList").innerHTML = pending.length
      ? pending.map(reviewCard).join("")
      : '<div class="placeholder">没有待复核的信号</div>';

    $("#historySub").textContent = done.length ? done.length + " 条已回流" : "暂无记录";
    $("#historyList").innerHTML = done.length
      ? done.map(reviewCard).join("")
      : '<div class="placeholder">还没有复核记录</div>';
  }

  async function decideReview(id, status) {
    const item = state.reviewStore.items.filter((x) => x.id === id)[0];
    if (!item) return;
    item.status = status;
    item.reviewed_at = new Date().toLocaleString("zh-CN", { hour12: false });
    renderReviews();
    await saveReviews();
  }
  /* ============================ 事件 ============================ */

  document.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab) {
      $$(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
      $$(".view").forEach((v) => v.classList.toggle("is-active", v.id === "view-" + tab.dataset.view));
      return;
    }

    const bc = e.target.closest(".batch-card");
    if (bc) {
      state.batchId = bc.dataset.batch;
      state.result = null;
      state.index = {};
      renderBatchPicker();
      renderSourceList();
      renderAgentStack({});
      $("#verdictBody").innerHTML = '<div class="placeholder">等待流水线输出</div>';
      ["agent1", "agent2", "agent3"].forEach((s) => setLed(s, "idle"));
      return;
    }

    const jump = e.target.closest("[data-jump]");
    if (jump) return jumpToSource(jump.dataset.jump);

    // 归因桶里的用例标签：点击后在五类归因之间轮换
    const cyc = e.target.closest("[data-cycle]");
    if (cyc && state.evalResult) {
      const id = cyc.dataset.cycle;
      const i = BUCKETS.findIndex((b) => b.key === state.attribution[id]);
      const next = BUCKETS[(i + 1) % BUCKETS.length];
      state.attribution[id] = next.key;
      const sel = document.querySelector(`.attr-select[data-case="${id}"]`);
      if (sel) sel.value = next.key;
      renderBuckets(state.evalResult.rows);
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.classList.contains("attr-select")) {
      state.attribution[e.target.dataset.case] = e.target.value;
      if (state.evalResult) renderBuckets(state.evalResult.rows);
    }
  });

  document.addEventListener("click", (e) => {
    const cf = e.target.closest("[data-confirm]");
    if (cf) return void confirmLabel(cf.dataset.confirm);
    const ig = e.target.closest("[data-ignore]");
    if (ig) return void ignoreLabel(ig.dataset.ignore);
    const rm = e.target.closest("[data-remove]");
    if (rm) return void removeLabel(rm.dataset.remove);
    const ap = e.target.closest("[data-approve]");
    if (ap) return void decideReview(ap.dataset.approve, "confirmed");
    const rj = e.target.closest("[data-reject]");
    if (rj) return void decideReview(rj.dataset.reject, "rejected");
  });

  $("#reloadLabelsBtn").addEventListener("click", loadLabels);
  $("#reloadReviewsBtn").addEventListener("click", loadReviews);
  $("#runBtn").addEventListener("click", () => runPipeline(false));
  const demoBtn = document.createElement("button");
  demoBtn.id = "demoBtn";
  demoBtn.type = "button";
  demoBtn.className = "btn btn-eval";
  demoBtn.title = "无需 API Key；展示固定样例结果，不调用模型";
  demoBtn.innerHTML = '<span class="btn-glyph">▷</span><span class="btn-text">离线样例演示</span>';
  $("#runBtn").before(demoBtn);
  demoBtn.addEventListener("click", () => runPipeline(true));
  $("#runEvalBtn").addEventListener("click", () => runEval("testset-holdout.json", $("#runEvalBtn")));

  // Agent1 输入形态切换：默认单条（稳），批量用于压调用成本
  const modeSel = $("#agent1ModeSel");
  if (modeSel) {
    modeSel.value = VOC_CONFIG.agent1Mode || "single";
    modeSel.addEventListener("change", () => { VOC_CONFIG.agent1Mode = modeSel.value; });
  }

  renderBatchPicker();
  renderSourceList();
  renderAgentStack({});
  loadLabels();
  loadReviews();
})();







