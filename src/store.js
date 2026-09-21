// 记录存储模块：只负责墨锭、试磨记录的落库与读取，不包含任何判定规则。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "data", "ink-stick-testing.json");

const seed = {
  "items": [
    {
      "id": "IS-001",
      "code": "IS-001",
      "smokeSource": "黄山松烟",
      "glueRatio": "7.5%",
      "ageYears": 8,
      "storage": "恒湿柜B",
      "logs": [
        { "at": "2026-06-11", "step": "试磨", "note": "宣纸20滴水，出墨快，评分86", "score": 86 }
      ]
    },
    {
      "id": "IS-002",
      "code": "IS-002",
      "smokeSource": "桐油烟",
      "glueRatio": "8%",
      "ageYears": 3,
      "storage": "试样盒C",
      "logs": []
    }
  ],
  "tests": [
    {
      "id": "T-SEED-001",
      "itemId": "IS-001",
      "itemCode": "IS-001",
      "paperBatch": "P-2026-0418-01",
      "paperGrammage": 32,
      "waterBatch": "W-桃花泉-06",
      "waterHardness": 42,
      "temp": 20.5,
      "humidity": 48,
      "rawScore": 88,
      "correctedScore": 88,
      "state": "已判定",
      "result": "合格",
      "note": "出墨快，墨色透亮",
      "createdAt": "2026-06-11T09:20:00.000Z"
    }
  ]
};

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return structuredClone(seed);
  }
  const raw = JSON.parse(await readFile(dbPath, "utf8"));
  // 兼容旧版单 items 结构：没有 tests 集合时补空数组，旧数据不做臆造迁移。
  return {
    items: Array.isArray(raw.items) ? raw.items : [],
    tests: Array.isArray(raw.tests) ? raw.tests : []
  };
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

export function itemKey(item) {
  return item.id || item.code;
}

export function findItem(db, idOrCode) {
  return db.items.find(x => x.id === idOrCode || x.code === idOrCode) || null;
}

export function findTest(db, testId) {
  return db.tests.find(t => t.id === testId) || null;
}

export function addItem(db, item) {
  db.items.unshift(item);
  return item;
}

export function addTest(db, test) {
  db.tests.push(test);
  return test;
}

export function newItemId() {
  return "IS-" + Date.now();
}

export function newTestId() {
  return "T-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}
