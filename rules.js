// 判定规则模块：纸样/水样准入、试磨绑定、温湿度校正、复测与失效留档、统计。
// 所有函数只操作传入的 db，不直接碰文件；持久化由入口调用 store.save() 完成。

// 校正基准与允许区间
export const STANDARD_TEMP = 20;
export const STANDARD_HUMIDITY = 50;
export const TEMP_RANGE = [18, 22];
export const HUMIDITY_RANGE = [45, 55];
export const PASS_SCORE = 85;

// 试磨单状态
export const TEST_STATUSES = ["未封存", "待复测", "已封存", "失效留档"];
// 墨锭状态
export const STICK_STATUSES = ["待试磨", "已试磨", "重点观察"];

// 统一携带 HTTP 状态码的业务异常
export class RuleError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function nextTestId(db) {
  return "T-" + Date.now().toString(36).toUpperCase() + "-" + (db.tests.length + 1);
}

// 线性校正：以 20℃ / 50% 湿度为基准
// 温度每偏离 1℃ 折 0.8 分（偏离基准温度时墨色稳定性下降），
// 湿度每偏离 1% 折 0.3 分（偏湿滞墨、偏燥伤韵）。
export function correctScore(raw, temp, humidity) {
  const score = Number(raw) - Math.abs(Number(temp) - STANDARD_TEMP) * 0.8
    - Math.abs(Number(humidity) - STANDARD_HUMIDITY) * 0.3;
  return Math.round(score * 10) / 10;
}

export function envCheck(temp, humidity) {
  const violations = [];
  if (temp < TEMP_RANGE[0] || temp > TEMP_RANGE[1]) {
    violations.push("温度" + temp + "℃超出" + TEMP_RANGE[0] + "~" + TEMP_RANGE[1] + "℃允许区间");
  }
  if (humidity < HUMIDITY_RANGE[0] || humidity > HUMIDITY_RANGE[1]) {
    violations.push("湿度" + humidity + "%超出" + HUMIDITY_RANGE[0] + "~" + HUMIDITY_RANGE[1] + "%允许区间");
  }
  return { inRange: violations.length === 0, violations };
}

export function verdictOf(correctedScore) {
  return correctedScore >= PASS_SCORE ? "合格" : "重点观察";
}

export function isOpen(test) {
  return test.status === "未封存" || test.status === "待复测";
}

// 纸样准入：克重缺失即 409
export function admitPaper(db, input) {
  const batch = String(input.batch || "").trim();
  const name = String(input.name || "").trim();
  if (!batch || !name) throw new RuleError(400, "invalid_paper", "纸样批号与名称必填");
  if (db.papers.some(p => p.batch === batch)) {
    throw new RuleError(409, "paper_batch_exists", "该批号纸样已准入登记");
  }
  const grammage = input.grammage === "" || input.grammage === null || input.grammage === undefined
    ? null : Number(input.grammage);
  if (grammage === null || Number.isNaN(grammage)) {
    throw new RuleError(409, "paper_grammage_missing", "纸张克重缺失，纸样不予准入，且未落库");
  }
  const paper = { batch, name, grammage };
  db.papers.push(paper);
  return paper;
}

// 水样准入：硬度缺失即 409
export function admitWater(db, input) {
  const code = String(input.code || "").trim();
  const source = String(input.source || "").trim();
  if (!code || !source) throw new RuleError(400, "invalid_water", "水样编号与来源必填");
  if (db.waters.some(w => w.code === code)) {
    throw new RuleError(409, "water_code_exists", "该水样已准入登记");
  }
  const hardness = input.hardness === "" || input.hardness === null || input.hardness === undefined
    ? null : Number(input.hardness);
  if (hardness === null || Number.isNaN(hardness)) {
    throw new RuleError(409, "water_hardness_missing", "水样硬度缺失，水样不予准入，且未落库");
  }
  const water = { code, source, hardness };
  db.waters.push(water);
  return water;
}

export function admitStick(db, input) {
  const code = String(input.code || "").trim();
  if (!code) throw new RuleError(400, "invalid_stick", "墨锭编号必填");
  if (db.sticks.some(s => s.code === code)) {
    throw new RuleError(409, "stick_code_exists", "该墨锭已建档");
  }
  const stick = {
    code,
    smokeSource: String(input.smokeSource || "").trim(),
    glueRatio: String(input.glueRatio || "").trim(),
    ageYears: input.ageYears === "" || input.ageYears == null ? null : Number(input.ageYears),
    storage: String(input.storage || "").trim(),
    createdAt: nowIso()
  };
  db.sticks.push(stick);
  return stick;
}

// 组装一张试磨单（校正评分 + 越界判定），不落库
function assemble(db, input, refs, linkage) {
  const raw = Number(input.rawScore);
  if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
    throw new RuleError(400, "invalid_score", "原始评分需为 0~100 的数值");
  }
  const temp = Number(input.temp);
  const humidity = Number(input.humidity);
  if (!Number.isFinite(temp) || !Number.isFinite(humidity)) {
    throw new RuleError(400, "invalid_env", "温度与湿度必须为数值");
  }
  const correctedScore = correctScore(raw, temp, humidity);
  const env = envCheck(temp, humidity);
  // 温湿度越界：只转“待复测”，校正分照算但本轮不出结论、不计统计
  const status = env.inRange ? "未封存" : "待复测";
  return {
    id: nextTestId(db),
    inkCode: refs.stick.code,
    paperBatch: refs.paper.batch,
    paperName: refs.paper.name,
    paperGrammage: refs.paper.grammage,
    waterId: refs.water.code,
    waterSource: refs.water.source,
    waterHardness: refs.water.hardness,
    temp,
    humidity,
    rawScore: raw,
    correctedScore,
    inRange: env.inRange,
    violations: env.violations,
    status,
    verdict: env.inRange ? verdictOf(correctedScore) : null,
    retestOf: linkage.retestOf || null,
    supersedes: linkage.supersedes || null,
    successorId: null,
    retestIds: [],
    archives: [],
    history: [{ at: nowIso(), note: env.inRange
      ? "试磨提交：绑定同批纸样 " + refs.paper.batch + " 与水样 " + refs.water.code
        + "，按20℃/50%校正评分"
      : "温湿度越界（" + env.violations.join("；") + "），转待复测，本轮不计统计" }],
    createdAt: nowIso(),
    sealedAt: null
  };
}

// 试磨准入：墨锭 + 同批纸样 + 水样三者绑定
// 纸样克重或水样硬度缺失 → 409 不落库；同一纸样已有未封存试磨 → 沿用首次（幂等）
export function admitTest(db, input) {
  const stick = db.sticks.find(s => s.code === String(input.inkCode || "").trim());
  if (!stick) throw new RuleError(400, "stick_not_found", "墨锭不存在，请先建档");
  const paper = db.papers.find(p => p.batch === String(input.paperBatch || "").trim());
  if (!paper) throw new RuleError(400, "paper_not_found", "纸样不存在，请先办理纸样准入");
  const water = db.waters.find(w => w.code === String(input.waterId || "").trim());
  if (!water) throw new RuleError(400, "water_not_found", "水样不存在，请先办理水样准入");

  // 准入关口：缺克重/缺硬度一律拦截
  if (paper.grammage === null || paper.grammage === undefined || Number.isNaN(paper.grammage)) {
    throw new RuleError(409, "paper_grammage_missing", "纸张克重缺失，试磨不予准入，且未落库");
  }
  if (water.hardness === null || water.hardness === undefined || Number.isNaN(water.hardness)) {
    throw new RuleError(409, "water_hardness_missing", "水样硬度缺失，试磨不予准入，且未落库");
  }

  // 同一纸样只能有一条未封存试磨：重复提交沿用首次
  const existing = db.tests.find(t => t.paperBatch === paper.batch && isOpen(t));
  if (existing) {
    return { test: existing, reused: true };
  }

  const test = assemble(db, input, { stick, paper, water }, {});
  db.tests.push(test);
  return { test, reused: false };
}

// 封存：只有温湿度合格、已出结论的未封存单可封存；封存后计入统计
export function sealTest(db, id) {
  const test = db.tests.find(t => t.id === id);
  if (!test) throw new RuleError(404, "test_not_found", "试磨单不存在");
  if (test.status === "已封存") return test;
  if (test.status === "失效留档") {
    throw new RuleError(409, "test_archived", "该结论已失效留档，不能封存");
  }
  if (test.status === "待复测") {
    throw new RuleError(409, "test_needs_retest", "温湿度越界待复测，须更换纸样复测后再封存");
  }
  test.status = "已封存";
  test.sealedAt = nowIso();
  test.history.push({ at: test.sealedAt, note: "封存，结论计入统计" });
  return test;
}

// 复测：必须更换纸样（同一批纸样拒绝）；新建复测单，原单标记关联
export function retest(db, id, input) {
  const prev = db.tests.find(t => t.id === id);
  if (!prev) throw new RuleError(404, "test_not_found", "试磨单不存在");
  if (prev.status === "已封存") {
    throw new RuleError(409, "test_sealed", "已封存试磨不能复测，请走调整流程");
  }
  if (prev.status === "失效留档") {
    throw new RuleError(409, "test_archived", "该结论已失效留档");
  }
  const newBatch = String(input.paperBatch || "").trim();
  if (!newBatch) throw new RuleError(400, "paper_required", "复测必须指定新纸样");
  if (newBatch === prev.paperBatch) {
    throw new RuleError(409, "same_paper_retest", "复测须换纸样，不能沿用同一批纸样");
  }
  const result = admitTest(db, { ...input, inkCode: prev.inkCode, paperBatch: newBatch,
    waterId: input.waterId || prev.waterId });
  const next = result.test;
  next.retestOf = prev.id;
  if (!result.reused) {
    next.history.push({ at: nowIso(), note: "复测单（换用纸样 " + newBatch + "，原单 " + prev.id + "）" });
    prev.retestIds.push(next.id);
    prev.history.push({ at: nowIso(), note: "温湿度越界，已用新纸样发起复测：" + next.id });
  }
  return { test: next, reused: result.reused };
}

// 调整试磨：
// - 仅改温湿度/原始分（不换纸、不换水）：直接更新，重算校正与结论
// - 调整水样或纸张：原结论失效，转“失效留档”不计统计；另立一张新单
export function adjustTest(db, id, input) {
  const test = db.tests.find(t => t.id === id);
  if (!test) throw new RuleError(404, "test_not_found", "试磨单不存在");
  if (test.status === "失效留档") {
    throw new RuleError(409, "test_archived", "该结论已失效留档");
  }
  const changingPaper = input.paperBatch && input.paperBatch !== test.paperBatch;
  const changingWater = input.waterId && input.waterId !== test.waterId;

  if (!changingPaper && !changingWater) {
    if (test.status === "已封存") {
      throw new RuleError(409, "test_sealed", "已封存试磨不可就地改判；如需变更纸样/水样请走调整");
    }
    const merged = {
      temp: input.temp ?? test.temp,
      humidity: input.humidity ?? test.humidity,
      rawScore: input.rawScore ?? test.rawScore
    };
    const raw = Number(merged.rawScore);
    const temp = Number(merged.temp);
    const humidity = Number(merged.humidity);
    if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
      throw new RuleError(400, "invalid_score", "原始评分需为 0~100 的数值");
    }
    const env = envCheck(temp, humidity);
    const old = { status: test.status, verdict: test.verdict, score: test.correctedScore };
    test.temp = temp;
    test.humidity = humidity;
    test.rawScore = raw;
    test.correctedScore = correctScore(raw, temp, humidity);
    test.inRange = env.inRange;
    test.violations = env.violations;
    test.status = env.inRange ? "未封存" : "待复测";
    test.verdict = env.inRange ? verdictOf(test.correctedScore) : null;
    test.history.push({ at: nowIso(), note: "重录环境/评分：校正分 " + old.score + "→"
      + test.correctedScore + "，状态 " + old.status + "→" + test.status });
    return { test, successor: null };
  }

  // 换纸或换水：原结论失效留档，另立新单
  const newBatch = String(input.paperBatch || test.paperBatch).trim();
  const newWaterId = String(input.waterId || test.waterId).trim();
  if (newBatch !== test.paperBatch && db.tests.some(t => t.paperBatch === newBatch && isOpen(t))) {
    throw new RuleError(409, "open_test_exists", "新纸样已有未封存试磨，不能重复占用");
  }
  const paper = db.papers.find(p => p.batch === newBatch);
  const water = db.waters.find(w => w.code === newWaterId);
  if (!paper) throw new RuleError(400, "paper_not_found", "纸样不存在，请先办理纸样准入");
  if (!water) throw new RuleError(400, "water_not_found", "水样不存在，请先办理水样准入");
  if (paper.grammage === null || paper.grammage === undefined || Number.isNaN(paper.grammage)) {
    throw new RuleError(409, "paper_grammage_missing", "纸张克重缺失，调整不予准入，且未落库");
  }
  if (water.hardness === null || water.hardness === undefined || Number.isNaN(water.hardness)) {
    throw new RuleError(409, "water_hardness_missing", "水样硬度缺失，调整不予准入，且未落库");
  }

  test.status = "失效留档";
  test.successorId = "(pending)";
  test.verdict = test.verdict; // 结论留档保留原文，但不计统计
  test.archives.push({
    at: nowIso(),
    reason: changingPaper && changingWater ? "调整纸样与水样" : changingPaper ? "调整纸样" : "调整水样",
    fromPaper: test.paperBatch,
    toPaper: newBatch,
    fromWater: test.waterId,
    toWater: newWaterId,
    verdict: test.verdict,
    correctedScore: test.correctedScore
  });
  test.history.push({ at: nowIso(), note: (changingPaper && changingWater ? "调整纸样与水样"
    : changingPaper ? "调整纸样" : "调整水样") + "，原结论失效留档，不计统计" });

  const stick = db.sticks.find(s => s.code === test.inkCode);
  const successor = assemble(db, {
    rawScore: input.rawScore ?? test.rawScore,
    temp: input.temp ?? test.temp,
    humidity: input.humidity ?? test.humidity
  }, { stick, paper, water }, { supersedes: test.id });
  db.tests.push(successor);
  test.successorId = successor.id;
  successor.history.push({ at: nowIso(), note: "承接原单 " + test.id + "（"
    + (changingPaper ? "换纸样" : "") + (changingPaper && changingWater ? "、" : "")
    + (changingWater ? "换水样" : "") + "）" });
  return { test, successor };
}

// 墨锭状态由其有效试磨单推导（失效留档不参与）
export function stickStatusOf(db, code) {
  const valid = db.tests.filter(t => t.inkCode === code && t.status !== "失效留档");
  if (!valid.length) return "待试磨";
  const sealedPass = valid.some(t => t.status === "已封存" && t.verdict === "合格");
  if (sealedPass) return "已试磨";
  const hasSealed = valid.some(t => t.status === "已封存");
  return hasSealed ? "重点观察" : "待试磨";
}

// 卡片与统计共用同一份汇总数据，保证刷新后一致
export function overview(db) {
  // 失效留档只留档，一律不进任何统计
  const counted = db.tests.filter(t => t.status !== "失效留档");
  const byStatus = Object.fromEntries(TEST_STATUSES.map(s => [s, 0]));
  for (const t of counted) byStatus[t.status] += 1;

  const sealed = counted.filter(t => t.status === "已封存");
  const passCount = sealed.filter(t => t.verdict === "合格").length;
  const watchCount = sealed.filter(t => t.verdict === "重点观察").length;
  const avg = sealed.length
    ? Math.round((sealed.reduce((sum, t) => sum + t.correctedScore, 0) / sealed.length) * 10) / 10
    : null;

  const sticks = db.sticks.map(s => ({
    ...s,
    derivedStatus: stickStatusOf(db, s.code)
  }));
  const stickStats = Object.fromEntries(STICK_STATUSES.map(s => [s, 0]));
  for (const s of sticks) stickStats[s.derivedStatus] += 1;

  return {
    sticks,
    papers: db.papers,
    waters: db.waters,
    tests: db.tests,
    stats: {
      tests: byStatus,
      sealed: {
        count: sealed.length,
        passCount,
        watchCount,
        avgCorrectedScore: avg
      },
      sticks: stickStats,
      archivedCount: db.tests.length - counted.length,
      countedBasis: "仅统计未封存/待复测/已封存；失效留档不计统计",
      correction: {
        standardTemp: STANDARD_TEMP,
        standardHumidity: STANDARD_HUMIDITY,
        tempRange: TEMP_RANGE,
        humidityRange: HUMIDITY_RANGE,
        passScore: PASS_SCORE
      }
    }
  };
}
