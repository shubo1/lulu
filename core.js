// 账单逻辑：和 Mac 版（ledger 仓库的 core.py）一样的规则和提示文字。
// 日期一律用 "YYYY-MM-DD" 字符串，按日历日算，不受时区影响。

import { BadPassword, decryptText, encryptText } from "./crypto.js";

// 默认账单类型。实际用的类型存在云端，在软件里增删；云端还没设置好时才用这份
export const DEFAULT_BILL_TYPES = ["电费", "冷水", "热水", "网络", "物业费", "Council 费", "停车费", "保险费", "Rego 费"];

export const DUE_SOON_DAYS = 7; // 截止日期在这么多天以内的未付账单标橙色
export const MIN_PASSWORD_LEN = 8;
export const MAX_TYPE_LEN = 20;

// 「噜噜的情债」：不能删除（手机版本来就不能删账本）；打开时噜妹会出来；有第二套密码（她的）。只对这一个账本
export const QINGZHAI_LEDGER_ID = "03b26989-4ad6-4b2a-84b4-69d8a3249056";
// 第二套密码存在这个账本的一条特殊记录里（不是账单），id 和 Mac 版 core.SECOND_KEY_ROW_ID 一样
export const SECOND_KEY_ROW_ID = "ed3d3edb-a44f-58e2-9648-20a2a7e48456";
export const secondKeyContext = (ledgerId) => `second:${ledgerId}`;

// 从云端的记录里挑出第二套密码那条：返回 [真正的账单记录, 那条的内容（没设置就是 null）]
export function splitSecondKey(rows) {
  const row = rows.find((r) => r.id === SECOND_KEY_ROW_ID);
  return [rows.filter((r) => r.id !== SECOND_KEY_ROW_ID), row ? row.ciphertext : null];
}

// ---------------------------------------------------------------- 日期和金额

const pad = (n) => String(n).padStart(2, "0");

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const dayNumber = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

export const daysBetween = (fromISO, toISO) => dayNumber(toISO) - dayNumber(fromISO);

export function addDays(iso, days) {
  const d = new Date((dayNumber(iso) + days) * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export const isISODate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;

export const fmtAud = (cents) =>
  "A$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const toCents = (amount) => Math.round(amount * 100);

// [状态文字, 颜色]
export function statusOf(bill, today) {
  if (bill.paid) return ["已付", "green"];
  const days = daysBetween(today, bill.due_date);
  if (days < 0) return [`逾期 ${-days} 天`, "red"];
  if (days === 0) return ["今天截止", "orange"];
  if (days <= DUE_SOON_DAYS) return [`还剩 ${days} 天`, "orange"];
  return [`未付 · 还剩 ${days} 天`, "blue"];
}

// 很多账单在周期开始前一天截止，所以截止日期默认填覆盖开始的前一天。
export const defaultDue = (periodStart) => addDays(periodStart, -1);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// 未付的按截止日期从近到远；已付的最近截止的在前。
export function splitBills(bills) {
  const unpaid = bills.filter((b) => !b.paid).sort((a, b) => cmp(a.due_date, b.due_date) || cmp(a.type, b.type));
  const paid = bills.filter((b) => b.paid).sort((a, b) => cmp(b.due_date, a.due_date));
  return [unpaid, paid];
}

// 打开「噜噜的情债」时放哪段动画：有逾期没付的 → "hit"；一笔没付的都没有 → "hug"；其余不放。
export function luluMood(bills, today) {
  const unpaid = bills.filter((b) => !b.paid);
  if (unpaid.some((b) => b.due_date < today)) return "hit";
  return unpaid.length ? null : "hug";
}

// ---------------------------------------------------------------- 花销统计

// 这张账单的花销算在哪个月：看覆盖结束日期，1–15 号算上个月，16–31 号算当月。返回 [年, 月]
export function spendingMonth(bill) {
  const [y, m, d] = bill.period_end.split("-").map(Number);
  if (d <= 15) return m === 1 ? [y - 1, 12] : [y, m - 1];
  return [y, m];
}

// 把已付的账单按花销月份分组：Map("年-月" → [账单...])。未付的不算。
export function spendingByMonth(bills) {
  const groups = new Map();
  for (const bill of bills) {
    if (!bill.paid) continue;
    const k = spendingMonth(bill).join("-");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(bill);
  }
  return groups;
}

// ---------------------------------------------------------------- 检查输入

export function checkBill(type, amount, start, end, due) {
  if (!type) return "请选择类型。";
  if (amount == null || !(amount > 0)) return "请填写价格。";
  if (!start || !end) return "请填写覆盖时间的开始和结束日期。";
  if (end < start) return "覆盖时间的结束日期不能早于开始日期。";
  if (!due) return "请填写截止日期。";
  return null;
}

const length = (s) => [...s].length; // 按字数算，和 Mac 版一样

export function checkTypeName(name, existing) {
  name = (name || "").trim();
  if (!name) return "请填写类型名字。";
  if (length(name) > MAX_TYPE_LEN) return `类型名字最多 ${MAX_TYPE_LEN} 个字。`;
  if (existing.some((t) => t.toLowerCase() === name.toLowerCase())) return "已经有这个类型了。";
  return null;
}

export function checkPassword(password, password2) {
  if (length(password || "") < MIN_PASSWORD_LEN) return `密码至少 ${MIN_PASSWORD_LEN} 位。`;
  if (password !== password2) return "两次输入的密码不一样。";
  return null;
}

// ---------------------------------------------------------------- 账单加密

const billContext = (ledgerId, billId) => `bill:${ledgerId}:${billId}`;

export function encryptBill(key, ledgerId, billId, bill) {
  const payload = {
    type: bill.type,
    amount_cents: Math.trunc(bill.amount_cents),
    period_start: bill.period_start,
    period_end: bill.period_end,
    due_date: bill.due_date,
    paid: Boolean(bill.paid),
  };
  return encryptText(key, JSON.stringify(payload), billContext(ledgerId, billId));
}

// 解密一个账本的全部账单；解不开或格式不对的跳过，返回 [账单, 跳过的条数]。
export async function decryptBills(key, ledgerId, rows) {
  const bills = [];
  let bad = 0;
  for (const row of rows) {
    try {
      const data = JSON.parse(await decryptText(key, row.ciphertext, billContext(ledgerId, row.id)));
      const bill = {
        id: row.id,
        type: String(data.type),
        amount_cents: data.amount_cents,
        period_start: data.period_start,
        period_end: data.period_end,
        due_date: data.due_date,
        paid: Boolean(data.paid),
      };
      if (!Number.isInteger(bill.amount_cents) || ![bill.period_start, bill.period_end, bill.due_date].every(isISODate)) {
        throw new TypeError("bad bill");
      }
      bills.push(bill);
    } catch (err) {
      if (!(err instanceof BadPassword || err instanceof SyntaxError || err instanceof TypeError)) throw err;
      bad += 1;
    }
  }
  return [bills, bad];
}

export async function saveBill(store, key, ledgerId, billId, bill) {
  await store.saveBill(ledgerId, key.auth, billId, await encryptBill(key, ledgerId, billId, bill));
}
