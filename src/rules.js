// 判定规则模块：纸样/水样准入、温湿度校正、复测与失效留档、状态与统计。
// 本模块只做判定并改动传入的 db 对象，持久化由调用方通过 store 完成。

export const REFERENCE_TEMP = 20;       // 评分基准温度 ℃
export const REFERENCE_HUMIDITY = 50;   // 评分基准湿度 %RH
export const TEMP_MIN = 18;
export const TEMP_MAX = 25;
export const HUMIDITY_MIN = 40;
export const HUMIDITY_MAX = 60;
export const TEMP_FACTOR = 1;           // 每偏离 1℃ 的评分修正
export const HUMIDITY_FACTOR = 0.2;     // 每偏离 1% 湿度的评分修正
export const PASS_SCORE = 85;

// 试磨记录状态：待复测 / 已判定 / 已封存 / 失效留档
export const TEST_STATES = ["待复测", "已判定", "已封存", "失效留档"];
const UNSEALED_STATES = ["待复测", "已判定"];

// 墨锭状态（统计口径）
export const ITEM_STATUSES = ["待试磨", "待复测", "已试磨", "重点观察", "已封存"];

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function now() {
  return new Date().toISOString();
}

// 温湿度在允许区间内才按 20℃/50% 校正出分；越界（含缺失、非数值）一律转待复测。
export function envInRange(temp, humidity) {
  return temp !== null && humidity !== null
    && temp >= TEMP_MIN && temp <= TEMP_MAX
    && humidity >= HUMIDITY_MIN && humidity <= HUMIDITY_MAX;
}

export function correctScore(rawScore, temp, humidity) {
  const corrected = rawScore
    + (REFERENCE_TEMP - temp) * TEMP_FACTOR
    + (REFERENCE_HUMIDITY - humidity) * HUMIDITY_FACTOR;
  return Math.max(0, Math.min(100, Math.round(corrected)));
}

function activeTests(db, itemId) {
  // 失效留档的记录只留档，不参与任何状态与统计。
  return db.tests
    .filter(t => t.itemId === itemId && t.state !== "失效留档")
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

export function latestActiveTest(db, itemId) {
  const list = activeTests(db, itemId);
  return list.length ? list[list.length - 1] : null;
}

// 墨锭状态完全由最近一条有效试磨推导，保证卡片、统计、刷新后一致。
export function itemStatus(db, itemId) {
  const latest = latestActiveTest(db, itemId);
  if (!latest) return "待试磨";
  if (latest.state === "待复测") return "待复测";
  if (latest.state === "已封存") return "已封存";
  return latest.correctedScore >= PASS_SCORE ? "已试磨" : "重点观察";
}

export function computeStats(db) {
  const stats = Object.fromEntries(ITEM_STATUSES.map(s => [s, 0]));
  for (const item of db.items) {
    stats[itemStatus(db, item.id)] += 1;
  }
  stats.失效留档 = db.tests.filter(t => t.state === "失效留档").length;
  return stats;
}

function findUnsealedByPaper(db, paperBatch) {
  return db.tests.find(t => t.paperBatch === paperBatch && UNSEALED_STATES.includes(t.state)) || null;
}

function appendItemLog(db, itemId, step, note, extra = {}) {
  const item = db.items.find(x => x.id === itemId);
  if (!item) return;
  item.logs ||= [];
  item.logs.push({ at: now(), step, note, ...extra });
}

// 提交一次试磨。返回 { test, reused }；reused=true 表示沿用该纸样的首次试磨，未新建记录。
export function submitTest(db, item, input, genTestId) {
  const paperBatch = (input.paperBatch || "").toString().trim();
  const waterBatch = (input.waterBatch || "").toString().trim();
  if (!paperBatch || !waterBatch) {
    throw new HttpError(400, "batch_required", "纸样批次和水样批次必须填写");
  }

  // 同一纸样全局只能有一条未封存试磨：重复提交沿用首次，不新建、不改动。
  const existing = findUnsealedByPaper(db, paperBatch);
  if (existing) {
    if (existing.itemId !== item.id) {
      throw new HttpError(409, "paper_sample_in_use", "该纸样已被其他试磨占用，未封存前不可再用");
    }
    return { test: existing, reused: true };
  }

  // 准入：克重或硬度缺失（含非数值、克重<=0）直接 409，且不落库。
  const grammage = toNumber(input.paperGrammage);
  const hardness = toNumber(input.waterHardness);
  if (grammage === null || grammage <= 0 || hardness === null) {
    throw new HttpError(409, "admission_incomplete", "纸张克重或水样硬度缺失，纸样/水样未准入，试磨不落库");
  }

  const latest = latestActiveTest(db, item.id);
  // 复测必须换纸样：待复测件已被上面的全局去重拦住，这里拦住对着封存件再用同纸的情况。
  if (latest && latest.state === "已封存" && latest.paperBatch === paperBatch) {
    throw new HttpError(409, "paper_must_change", "复测须更换纸样");
  }

  const rawScore = toNumber(input.rawScore);
  if (rawScore === null || rawScore < 0 || rawScore > 100) {
    throw new HttpError(400, "invalid_score", "原始评分缺失或超出 0-100");
  }

  const temp = toNumber(input.temp);
  const humidity = toNumber(input.humidity);
  const inRange = envInRange(temp, humidity);

  // 调整水样或纸张会让原结论失效留档（仅对未封存的已判定结论生效，封存件为永久档案）。
  if (latest && latest.state === "已判定") {
    const paperChanged = latest.paperBatch !== paperBatch;
    const waterChanged = latest.waterBatch !== waterBatch;
    if (paperChanged || waterChanged) {
      latest.state = "失效留档";
      latest.invalidReason = !waterChanged
        ? "复测更换纸样，原结论失效留档"
        : !paperChanged
          ? "复测调整水样，原结论失效留档"
          : "复测更换纸样并调整水样，原结论失效留档";
      latest.invalidatedAt = now();
      appendItemLog(db, item.id, "失效留档", `原试磨 ${latest.id}：${latest.invalidReason}`);
    }
  }

  // 对仍挂着的待复测件做复测：换新纸样后原待复测评卷封存。
  if (latest && latest.state === "待复测" && latest.paperBatch !== paperBatch) {
    latest.state = "已封存";
    latest.sealedAt = now();
    latest.sealNote = "复测换新纸样，原件封存";
    appendItemLog(db, item.id, "封存", `待复测原卷 ${latest.id}：复测换新纸样，原件封存`);
  }

  const test = {
    id: genTestId(),
    itemId: item.id,
    itemCode: item.code || item.id,
    paperBatch,
    paperGrammage: grammage,
    waterBatch,
    waterHardness: hardness,
    temp,
    humidity,
    rawScore,
    correctedScore: null,
    state: null,
    result: null,
    note: (input.note || "").toString().trim(),
    createdAt: now()
  };

  if (inRange) {
    test.correctedScore = correctScore(rawScore, temp, humidity);
    test.state = "已判定";
    test.result = test.correctedScore >= PASS_SCORE ? "合格" : "重点观察";
  } else {
    // 温湿度越界（含缺失/非数值）：只转待复测，原始分留档，不出校正分。
    test.state = "待复测";
    test.result = "待复测";
    test.pendingReason = "温湿度越出允许区间，需换纸样复测";
  }

  db.tests.push(test);
  appendItemLog(
    db, item.id, "试磨",
    inRange
      ? `试磨 ${test.id}：${paperBatch}/${waterBatch}，原始${rawScore}，校正${test.correctedScore}（${REFERENCE_TEMP}℃/${REFERENCE_HUMIDITY}%）`
      : `试磨 ${test.id}：${paperBatch}/${waterBatch}，温湿度越界转待复测`,
    inRange ? { score: test.correctedScore } : {}
  );

  return { test, reused: false };
}

// 封存试磨（未封存的待复测/已判定件可封存；封存件与留档件不可再动）。
export function sealTest(db, test) {
  if (test.state === "失效留档") {
    throw new HttpError(409, "archived_cannot_seal", "失效留档记录不可封存");
  }
  if (test.state === "已封存") {
    throw new HttpError(409, "already_sealed", "该试磨已封存");
  }
  test.state = "已封存";
  test.sealedAt = now();
  test.sealNote = "人工封存";
  appendItemLog(db, test.itemId, "封存", `试磨 ${test.id} 已封存`);
  return test;
}

// 供接口返回：墨锭 + 推导出的状态 + 试磨明细（新在前，留档件打标）。
export function decorateItem(db, item) {
  const tests = db.tests
    .filter(t => t.itemId === item.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return {
    ...item,
    derivedStatus: itemStatus(db, item.id),
    testCount: tests.length,
    archivedCount: tests.filter(t => t.state === "失效留档").length,
    tests
  };
}
