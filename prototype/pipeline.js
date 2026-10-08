/**
 * 流水线编排层
 *
 * 与 Prompt 的形态完全匹配：
 *   Agent1 支持两种输入形态（VOC_CONFIG.agent1Mode）：
 *     single = 逐条调用（默认，一条失败只影响一条）
 *     batch  = 按 agent1BatchSize 切块整批调用（省调用次数，对不齐自动回退逐条）
 *   Agent2 逐条调用，Agent3 逐组调用，仅输出 Markdown。
 * 逐条调用由并发池驱动，避免 30 条评测串行等待。
 *
 * 三处增补的落点：
 *   1. Agent2 输入注入同用户跨渠道记录
 *   2. Agent1 输出外层挂 feedback_id / customer_ref（不改其内部 JSON 结构）
 *   3. Agent3 证据链的「语料编号」由本文件解析成可点击标签
 */

window.VOC_CONFIG = {
  endpoint: "/api/chat",
  temperature: 0.2,
  maxTokens: 8000,
  concurrency: 6,
  promptDir: "/prompts",
  // Agent1 输入形态：single = 逐条（默认，鲁棒性优先）；batch = 整批一次调用（省调用次数）
  agent1Mode: "single",
  // batch 模式每次送入的条数上限。条数越多越省，但预算被推理 token 吃穿的风险越大
  agent1BatchSize: 10,
  // batch 输出条数/index 对不齐时，自动把该块逐条重跑。关掉会丢数据，除排障外不建议关
  agent1FallbackToSingle: true
};

window.VOC_PIPELINE = (function () {
  const promptCache = {};
  const LEVEL_RANK = { "高": 0, "观察": 1, "常规": 2 };
  let activeCustomLabels = [];
  // 累计模型调用次数（含 JSON 纠错重试与批量回退），用于把成本摊在界面上
  let modelCalls = 0;

  /** 拉取人工确认过的自定义标签。调用失败不影响主流程，退化为只用预设标签。 */
  async function loadCustomLabels() {
    try {
      const res = await fetch("/api/labels");
      if (!res.ok) return;
      const data = await res.json();
      activeCustomLabels = Array.isArray(data.confirmed) ? data.confirmed : [];
      window.VOC_INJECT = window.VOC_INJECT || {};
      window.VOC_INJECT.labels = activeCustomLabels.length;
    } catch (e) {
      activeCustomLabels = [];
    }
  }

  let reviewMemory = { confirmed: [], rejected: [] };

  /** 拉取人工复核结论，作为 Agent2 的校准参考。调用失败则退化为不注入。 */
  async function loadReviews() {
    try {
      const res = await fetch("/api/reviews");
      if (!res.ok) return;
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      reviewMemory = {
        confirmed: items.filter((x) => x.status === "confirmed").slice(-5),
        rejected: items.filter((x) => x.status === "rejected").slice(-5)
      };
      window.VOC_INJECT = window.VOC_INJECT || {};
      window.VOC_INJECT.reviews = { confirmed: reviewMemory.confirmed.length, rejected: reviewMemory.rejected.length };
    } catch (e) {
      reviewMemory = { confirmed: [], rejected: [] };
    }
  }

  /** 把人工复核结论拼到 Agent2 的 System Prompt 末尾。Prompt 原文不动。 */
  function withReviews(system, promptName) {
    if (promptName !== "agent2-risk") return system;
    const ok = reviewMemory.confirmed;
    const bad = reviewMemory.rejected;
    if (!ok.length && !bad.length) return system;
    const line = (x) => "- " + x.primary_label + "（" + x.risk_level + "）：" + ((x.samples && x.samples[0]) ? x.samples[0].text : "");
    let s = system + "\n\n# 人工复核结论（校准参考）\n以下是人工复核过的历史判定，请据此校准同类判断：\n";
    if (ok.length) s += "【人工确认属实，同类应保持敏感】\n" + ok.map(line).join("\n") + "\n";
    if (bad.length) s += "【人工判定为误报，同类不应升级】\n" + bad.map(line).join("\n") + "\n";
    return s;
  }

  /** 把已确认的自定义标签拼到 Agent1 的 System Prompt 末尾。Prompt 原文不动。 */
  function withCustomLabels(system, promptName) {
    if (promptName !== "agent1-collector" || !activeCustomLabels.length) return system;
    return system +
      "\n\n# 已确认的自定义标签\n" +
      "除上述预设标签外，以下标签已经过人工确认，同样有效。当反馈明确指向这些概念时，请优先使用它们，并同时保留最贴近的预设标签：\n" +
      activeCustomLabels.map((l) => "- " + l).join("\n") + "\n";
  }

  async function fetchPrompt(name) {
    if (promptCache[name]) return promptCache[name];
    const res = await fetch(`${VOC_CONFIG.promptDir}/${name}.md`);
    if (!res.ok) throw new Error(`加载 System Prompt 失败：${name}（HTTP ${res.status}）`);
    const text = await res.text();
    promptCache[name] = text;
    return text;
  }

  async function chat(messages) {
    modelCalls += 1;
    const res = await fetch(VOC_CONFIG.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        temperature: VOC_CONFIG.temperature,
        max_tokens: VOC_CONFIG.maxTokens
      })
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`模型调用失败（HTTP ${res.status}）：${raw.slice(0, 240)}`);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      throw new Error(`服务端返回的不是合法 JSON：${raw.slice(0, 180)}`);
    }
    if (payload.error) throw new Error(String(payload.error));
    if (payload.model) window.VOC_LAST_MODEL = payload.model;
    return payload.content || "";
  }

  function extractJSON(text) {
    let s = String(text || "").trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(`输出中找不到 JSON 对象，原始开头：${s.slice(0, 140)}`);
    }
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch (e) {
      throw new Error(`JSON 解析失败：${e.message}`);
    }
  }

  /** Agent1 / Agent2：要求 JSON 输出，失败时纠错重试一次。
   *  systemExtra 用于在 System Prompt 末尾追加输入形态适配（如 Agent1 批量模式），
   *  保证判定规则只有一份，批量与单条共用同一个 Prompt。 */
  async function callAgentJSON(promptName, userContent, systemExtra) {
    let system = withReviews(withCustomLabels(await fetchPrompt(promptName), promptName), promptName);
    if (systemExtra) system += "\n\n" + systemExtra;
    const messages = [
      { role: "system", content: system },
      { role: "user", content: userContent }
    ];
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = performance.now();
      const content = await chat(messages);
      try {
        return { data: extractJSON(content), ms: Math.round(performance.now() - t0) };
      } catch (e) {
        lastErr = e;
        messages.push({ role: "assistant", content: String(content).slice(0, 1500) });
        messages.push({
          role: "user",
          content: "上一条输出不是合法 JSON（常见原因是字符串内部出现了未转义的英文双引号）。请只输出一个 JSON 对象，不要代码围栏；字符串内部的引号统一改用中文引号「」。"
        });
      }
    }
    throw lastErr || new Error("未知错误");
  }

  /** Agent3：要求 Markdown 输出，原样返回文本 */
  async function callAgentText(promptName, userContent) {
    const system = withReviews(withCustomLabels(await fetchPrompt(promptName), promptName), promptName);
    return chat([
      { role: "system", content: system },
      { role: "user", content: userContent }
    ]);
  }

  // 并发池：控制同时在飞的请求数，避免触发限流
  async function pool(items, limit, worker, onTick) {
    const results = new Array(items.length);
    let cursor = 0;
    let done = 0;
    const size = Math.max(1, Math.min(limit, items.length));
    const runners = new Array(size).fill(0).map(async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= items.length) return;
        try {
          results[idx] = { ok: true, value: await worker(items[idx], idx) };
        } catch (e) {
          results[idx] = { ok: false, error: e.message };
        }
        done++;
        if (onTick) onTick(done, items.length);
      }
    });
    await Promise.all(runners);
    return results;
  }

  /* ---------------- Agent1：标注（逐条 / 批量两种输入形态） ---------------- */

  function agent1UserContent(f) {
    return `渠道：${f.channel}\n` +
      `商品：${f.product}\n` +
      `用户标识：${f.customer_ref}\n` +
      `时间：${f.time}\n\n` +
      `反馈原文：\n${f.text}`;
  }

  function agent1BatchUserContent(chunk) {
    return `本次共 ${chunk.length} 条反馈，请逐条标注，并按批量模式的 JSON 格式输出。\n` +
      chunk.map((f, i) => `\n【反馈 ${i + 1}】\n${agent1UserContent(f)}`).join("\n");
  }

  /** 单条标注。增补 2：外层挂载追溯字段，不改动 Agent1 自身的输出结构。 */
  async function annotateOne(f) {
    const r = await callAgentJSON("agent1-collector", agent1UserContent(f));
    return Object.assign({}, r.data, { feedback_id: f.id, customer_ref: f.customer_ref });
  }

  /**
   * 批量输出的对齐校验。通过则返回按输入顺序排好的数组；条数或 index 对不上就抛错，
   * 由调用方回退逐条重跑。批量模式绝不能静默丢反馈——漏报比误报贵。
   */
  function alignBatchResults(data, n) {
    const list = Array.isArray(data) ? data : (data && data.results);
    if (!Array.isArray(list)) throw new Error("批量输出里找不到 results 数组");
    if (list.length !== n) throw new Error(`批量输出条数不匹配：输入 ${n} 条，输出 ${list.length} 条`);
    const hasIndex = list.some((x) => x && x.index !== undefined && x.index !== null);
    if (!hasIndex) return list.slice(); // 长度已核对，无编号时按顺序对齐
    const ordered = new Array(n);
    const seen = new Set();
    list.forEach((x) => {
      const idx = Number(x && x.index);
      if (!Number.isInteger(idx) || idx < 1 || idx > n) throw new Error(`批量输出的 index 非法：${x && x.index}`);
      if (seen.has(idx)) throw new Error(`批量输出的 index 重复：${idx}`);
      seen.add(idx);
      ordered[idx - 1] = x;
    });
    if (seen.size !== n) throw new Error(`批量输出的 index 不完整：${seen.size}/${n}`);
    return ordered;
  }

  async function runAgent1(batch, onTick) {
    await loadCustomLabels();
    const started = performance.now();
    const feedbacks = batch.feedbacks;
    const callsBefore = modelCalls;
    const useBatch = VOC_CONFIG.agent1Mode === "batch";
    const cards = [];
    const errors = [];
    let fallbacks = 0;

    if (!useBatch) {
      const results = await pool(feedbacks, VOC_CONFIG.concurrency, annotateOne, onTick);
      results.forEach((r, i) => {
        if (r.ok) cards.push(r.value);
        else errors.push({ id: feedbacks[i].id, message: r.error });
      });
      return {
        cards, errors, ms: Math.round(performance.now() - started),
        mode: "single", calls: modelCalls - callsBefore, fallbacks
      };
    }

    // 批量模式：切块后逐块调用（串行，避免多块并发把限流打满）
    const size = Math.max(1, Math.min(Number(VOC_CONFIG.agent1BatchSize) || feedbacks.length, feedbacks.length));
    const chunks = [];
    for (let i = 0; i < feedbacks.length; i += size) chunks.push(feedbacks.slice(i, i + size));
    const adapter = await fetchPrompt("agent1-batch-adapter");
    let done = 0;

    for (const chunk of chunks) {
      try {
        const r = await callAgentJSON("agent1-collector", agent1BatchUserContent(chunk), adapter);
        const ordered = alignBatchResults(r.data, chunk.length);
        ordered.forEach((data, i) => {
          cards.push(Object.assign({}, data, { feedback_id: chunk[i].id, customer_ref: chunk[i].customer_ref }));
        });
      } catch (e) {
        if (!VOC_CONFIG.agent1FallbackToSingle) {
          chunk.forEach((f) => errors.push({ id: f.id, message: e.message, batch: true }));
          done += chunk.length;
          if (onTick) onTick(done, feedbacks.length);
          continue;
        }
        // 回退：整块逐条重跑，宁可多花钱，不让批量输出吞掉反馈
        fallbacks += 1;
        const results = await pool(chunk, VOC_CONFIG.concurrency, annotateOne);
        results.forEach((r, i) => {
          if (r.ok) cards.push(r.value);
          else errors.push({ id: chunk[i].id, message: r.error, fallback: true });
        });
      }
      done += chunk.length;
      if (onTick) onTick(done, feedbacks.length);
    }

    return {
      cards, errors, ms: Math.round(performance.now() - started),
      mode: "batch", calls: modelCalls - callsBefore, fallbacks
    };
  }

  /* ---------------- Agent2：逐条风险判断 ---------------- */

  function buildHistory(cards, card) {
    const history = VOC_DATA.history7d || {};
    const counts = VOC_DATA.recent24hNegative || {};
    const labels = card.labels || [];
    const sameUser = cards
      .filter((c) => c.customer_ref && c.customer_ref === card.customer_ref && c.feedback_id !== card.feedback_id)
      .map((c) => ({ feedback_id: c.feedback_id, channel: c.channel, summary: c.summary, labels: c.labels }));

    const relevant = {};
    labels.forEach((l) => {
      if (history[l]) relevant[l] = Object.assign({}, history[l], { negative_24h: counts[l] || 0 });
    });

    return {
      history_7d: relevant,
      negative_24h_total: labels.reduce((acc, l) => acc + (counts[l] || 0), 0),
      same_user_other_channels: sameUser
    };
  }

  async function runAgent2(cards, batch, onTick) {
    await loadReviews();
    const started = performance.now();
    const textById = {};
    batch.feedbacks.forEach((f) => { textById[f.id] = f.text; });

    const results = await pool(
      cards,
      VOC_CONFIG.concurrency,
      async (card) => {
        const history = buildHistory(cards, card);
        const userContent =
          "【反馈卡】\n" + JSON.stringify(card, null, 2) +
          "\n\n【历史信号库】\n" + JSON.stringify(history, null, 2) +
          "\n\n【该用户在其他渠道的历史反馈记录】\n" + JSON.stringify(history.same_user_other_channels, null, 2);
        const r = await callAgentJSON("agent2-risk", userContent);
        return Object.assign({}, r.data, { feedback_id: card.feedback_id });
      },
      onTick
    );

    const risks = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.ok) risks.push(r.value);
      else errors.push({ id: cards[i].feedback_id, message: r.error });
    });
    return { risks, errors, ms: Math.round(performance.now() - started) };
  }

  /* ---------------- 聚合层：纯规则，不含模型调用 ---------------- */

  function aggregate(cards, risks, feedbacks) {
    const cardById = {};
    cards.forEach((c) => { cardById[c.feedback_id] = c; });
    const textById = {};
    (feedbacks || []).forEach((f) => { textById[f.id] = { text: f.text, channel: f.channel, time: f.time }; });

    const groups = {};
    risks.forEach((risk) => {
      const card = cardById[risk.feedback_id] || {};
      const src = textById[risk.feedback_id] || {};
      const primary = (card.labels && card.labels[0]) || "其他";
      const level = risk.risk_level || "观察";
      const key = `${level}|${primary}`;
      if (!groups[key]) {
        groups[key] = {
          key, risk_level: level, primary_label: primary,
          feedback_ids: [], channels: [], samples: [],
          attributions: [], reasons: [],
          need_human_review: false, review_reason: null
        };
      }
      const g = groups[key];
      g.feedback_ids.push(risk.feedback_id);
      if (g.channels.indexOf(src.channel) === -1) g.channels.push(src.channel);
      g.samples.push({
        feedback_id: risk.feedback_id,
        channel: src.channel,
        time: src.time,
        text: src.text || "",
        summary: card.summary || ""
      });
      if (risk.attribution) g.attributions.push(risk.attribution);
      if (risk.risk_reason) g.reasons.push(risk.risk_reason);
      if (risk.need_human_review) { g.need_human_review = true; g.review_reason = risk.review_reason || g.review_reason; }
      if (LEVEL_RANK[level] < LEVEL_RANK[g.risk_level]) g.risk_level = level;
    });

    return Object.keys(groups).map((k) => groups[k]).sort((a, b) => {
      const d = LEVEL_RANK[a.risk_level] - LEVEL_RANK[b.risk_level];
      return d !== 0 ? d : b.feedback_ids.length - a.feedback_ids.length;
    });
  }

  /* ---------------- Agent3：逐组生成 Markdown 报告 ---------------- */

  async function runAgent3(groups, cards, onTick) {
    // 常规不生成报告：Agent3 的产出是给商家看的行动清单，常规项不需要打扰
    const targets = groups.filter((g) => g.risk_level === "高" || g.risk_level === "观察");
    const started = performance.now();
    const results = await pool(
      targets,
      VOC_CONFIG.concurrency,
      async (g) => {
        const riskResult = {
          risk_level: g.risk_level,
          risk_reason: g.reasons.join("；"),
          attribution: g.attributions.join("；"),
          need_human_review: g.need_human_review,
          review_reason: g.review_reason
        };
        const evidence = {
          语料数量: g.feedback_ids.length,
          来源渠道: g.channels,
          语料编号: g.feedback_ids,
          原始文本示例: g.samples.slice(0, 3).map((s) => `${s.feedback_id}（${s.channel}）：${s.text}`)
        };
        const userContent =
          "【风险识别结果】\n" + JSON.stringify(riskResult, null, 2) +
          "\n\n【证据材料】\n" + JSON.stringify(evidence, null, 2) +
          "\n\n【过去7天历史信号统计】\n" + JSON.stringify(VOC_DATA.history7d, null, 2);
        const markdown = await callAgentText("agent3-insight", userContent);
        return { group: g, markdown: String(markdown || "").trim() };
      },
      onTick
    );

    const reports = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.ok) reports.push(r.value);
      else errors.push({ group: targets[i].key, message: r.error });
    });
    return { reports, errors, ms: Math.round(performance.now() - started) };
  }

  /* ---------------- 全链路 ---------------- */

  async function runPipeline(batch, onStage, opts) {
    const emit = onStage || function () {};
    const options = opts || {};
    const out = { batch: batch.id, agent1: null, agent2: null, groups: [], agent3: null, errors: [] };

    emit("agent1", "running", { done: 0, total: batch.feedbacks.length });
    try {
      const r1 = await runAgent1(batch, (done, total) => emit("agent1", "running", { done, total }));
      out.agent1 = r1;
      emit("agent1", "done", r1);
      if (!r1.cards.length) { out.errors.push({ agent: "agent1", message: "全部反馈标注失败" }); return out; }
    } catch (e) {
      out.errors.push({ agent: "agent1", message: e.message });
      emit("agent1", "error", { message: e.message });
      return out;
    }

    emit("agent2", "running", { done: 0, total: out.agent1.cards.length });
    try {
      const r2 = await runAgent2(out.agent1.cards, batch, (done, total) => emit("agent2", "running", { done, total }));
      out.agent2 = r2;
      emit("agent2", "done", r2);
    } catch (e) {
      out.errors.push({ agent: "agent2", message: e.message });
      emit("agent2", "error", { message: e.message });
      return out;
    }

    out.groups = aggregate(out.agent1.cards, out.agent2.risks, batch.feedbacks);

    const targets = out.groups.filter((g) => g.risk_level === "高" || g.risk_level === "观察");
    if (options.skipAgent3) return out;
    emit("agent3", "running", { done: 0, total: targets.length });
    try {
      const r3 = await runAgent3(out.groups, out.agent1.cards, (done, total) => emit("agent3", "running", { done, total }));
      out.agent3 = r3;
      emit("agent3", "done", r3);
    } catch (e) {
      out.errors.push({ agent: "agent3", message: e.message });
      emit("agent3", "error", { message: e.message });
    }

    return out;
  }

  /** 从 Agent3 的 Markdown 里解析「语料编号：F001, F002」，用于证据下钻 */
  function parseEvidenceIds(markdown) {
    const m = String(markdown || "").match(/语料编号[：:]\s*([^\n]+)/);
    if (!m) return [];
    // 只捞形如 F001 / E12 的编号；U2043 这类用户号由调用方按真实语料再过滤一次
    return m[1].match(/[A-Za-z]{1,3}\d+/g) || [];
  }

  return { runPipeline, extractJSON, parseEvidenceIds, aggregate, alignBatchResults, loadCustomLabels, loadReviews };
})();







