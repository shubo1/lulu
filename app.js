// 账单手机版：和 Mac 版（ledger 仓库）共用同一个云端、同样的密码和加密格式。
// 账单在这台手机上解密；云端和放网页的网站都只看到乱码。
// 新建、删除账本留在 Mac 版上做，手机版做日常要用的：看账单、记账、标已付、花销、类型。

import * as core from "./core.js";
import * as cr from "./crypto.js";
import { SupabaseStore, WrongPassword, clearConfig, loadConfig, readSetupLink, saveConfig } from "./store.js";

const REFRESH_MS = 5000; // 每隔几秒看一眼云端有没有对方的改动
const SCENE_MS = 5200; // 「噜噜的情债」开场动画多长（CSS 里 5 秒淡出）

const $app = document.getElementById("app");
const $dialog = document.getElementById("dialog");
const $toast = document.getElementById("toast");
const $scene = document.getElementById("scene");

const S = {
  store: null,
  view: "home", // setup | home | unlock | ledger
  ledgers: [],
  types: [],
  typesFromCloud: true,
  keys: new Map(), // 这次打开期间已解锁的账本 {id: 密钥}，只在内存里，关掉就没了
  second: new Set(), // 用第二套密码（她的）解锁的账本
  openId: null,
  justOpened: false, // 刚点「打开」：账本页第一次画出来时放动画
  tab: "bills",
  filter: "全部",
  spendYear: null,
  bills: [],
  bad: 0,
  secondBlob: null,
  seen: { ledgers: "", types: "", bills: "" },
  open: new Set(), // 展开着的展开栏
  add: null, // 添加账单表单里填了什么
  errors: {}, // 各个表单的错误提示
  busy: false, // 正在处理一次点击或提交（防止连点）
  syncing: false, // 自动同步正在读云端
};

// ---------------------------------------------------------------- 小工具

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let toastTimer;
function toast(msg, isError = false) {
  $toast.textContent = (isError ? "" : "✅ ") + msg;
  $toast.className = "show" + (isError ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.className = isError ? "err" : ""), isError ? 5000 : 2500);
}

const errorBox = (name) => (S.errors[name] ? `<div class="error">${esc(S.errors[name])}</div>` : "");
const ledgerById = (id) => S.ledgers.find((l) => l.id === id);
const fpLedgers = (ls) => JSON.stringify(ls.map((l) => [l.id, l.name]));
const fpRows = (rows) => JSON.stringify(rows.map((r) => [r.id, r.updated_at]).sort());
const emptyAdd = () => ({ type: "", amount: "", start: "", end: "", due: "", dueAuto: true });

function details(id, summary, body, openByDefault = false) {
  const open = S.open.has(id) || (openByDefault && !S.open.has("!" + id));
  return `<details class="card" data-id="${id}"${open ? " open" : ""}><summary>${summary}</summary><div class="body">${body}</div></details>`;
}

// 算密码时（手机上大约半秒到一秒）显示一条来回跑的进度条，按钮先变灰
function showWorking(form) {
  form.querySelector("button[type=submit]").disabled = true;
  const bar = form.querySelector(".progress");
  if (bar) bar.hidden = false;
}

// ---------------------------------------------------------------- 读数据

async function loadHome() {
  S.ledgers = await S.store.listLedgers();
  S.seen.ledgers = fpLedgers(S.ledgers);
  try {
    S.types = await S.store.listTypes();
    S.typesFromCloud = true;
  } catch {
    S.types = [...core.DEFAULT_BILL_TYPES];
    S.typesFromCloud = false;
  }
  S.seen.types = JSON.stringify(S.types);
}

async function loadLedger() {
  const id = S.openId;
  const rows = await S.store.listBills(id);
  S.seen.bills = fpRows(rows);
  const [billRows, blob] = core.splitSecondKey(rows); // 第二套密码那条不是账单
  [S.bills, S.bad] = await core.decryptBills(S.keys.get(id), id, billRows);
  S.secondBlob = blob;
}

// ---------------------------------------------------------------- 页面

function setupView() {
  return `
    <h1>🧾 账单</h1>
    <h2>连接云端</h2>
    <p class="caption">第一次打开要先连接云端。最省事的是用 Ethan 发的设置链接（复制到 Safari 里打开）；也可以在下面手动填。连好以后记在这台手机上。</p>
    <form class="card" data-form="setup" autocomplete="off">
      <label for="f-url">Project URL</label>
      <input id="f-url" name="url" type="url" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://xxxx.supabase.co">
      <label for="f-key">Publishable key（或旧版的 anon key）</label>
      <input id="f-key" name="key" type="password" autocapitalize="off" spellcheck="false">
      ${errorBox("setup")}
      <div class="buttons"><button class="primary" type="submit">连接</button></div>
    </form>`;
}

function typesManager() {
  if (!S.typesFromCloud) {
    return details("types", "🏷️ 管理账单类型", `<div class="warn">云端还没有类型表。现在先用默认类型，暂时不能增删（Mac 版的 README 里有设置方法）。</div>`);
  }
  const chips = S.types
    .map((t) => `<span class="chip">${esc(t)}<button type="button" data-act="del-type" data-name="${esc(t)}">删除</button></span>`)
    .join("");
  return details(
    "types",
    "🏷️ 管理账单类型",
    `<p class="caption">类型是所有账本共用的，大家都能看到，改了马上对所有人生效。删掉一个类型不影响已经记下的账单。</p>
     <div class="type-list">${chips}</div>
     <form data-form="add-type" autocomplete="off">
       <label for="f-newtype">新类型</label>
       <input id="f-newtype" name="name" maxlength="${core.MAX_TYPE_LEN}" placeholder="例如：燃气费">
       ${errorBox("type")}
       <div class="buttons"><button type="submit">添加类型</button></div>
     </form>`,
  );
}

function homeView() {
  const cards = S.ledgers
    .map(
      (l) => `
      <div class="card row">
        <div class="grow"><div class="name">${esc(l.name)}</div>
          <div class="caption">${S.keys.has(l.id) ? "已解锁" : "🔒 需要密码"}</div></div>
        <button type="button" data-act="open" data-id="${esc(l.id)}">打开</button>
      </div>`,
    )
    .join("");
  return `
    <div class="title-row"><img src="static/lulu_frame.jpg" alt=""><h1>🧾 账单</h1></div>
    <p>🍊 噜噜陪你一起看账单。</p>
    <p class="caption">每个账本有自己的密码。账单在你手机上解密，没有密码的人（包括云平台）只能看到账本名字。</p>
    ${S.ledgers.length ? cards : `<div class="info">还没有账本。新建账本请在 Mac 上操作。</div>`}
    ${typesManager()}
    <p class="caption">新建、删除账本请在 Mac 上操作。</p>
    ${details("settings", "⚙️ 这台手机的设置", `
      <p class="caption">连接设置存在这台手机上。断开以后要重新用设置链接打开。</p>
      <div class="buttons"><button type="button" class="danger" data-act="disconnect">断开云端连接</button></div>`)}`;
}

function unlockView(ledger) {
  return `
    <div class="topbar"><button type="button" data-act="home">← 所有账本</button></div>
    <h1>🔒 ${esc(ledger.name)}</h1>
    <form class="card" data-form="unlock">
      <label for="f-pw">密码</label>
      <input id="f-pw" name="password" type="password" autocomplete="current-password" enterkeyhint="go">
      ${errorBox("unlock")}
      <div class="progress" hidden><div></div></div>
      <div class="buttons"><button class="primary" type="submit">解锁</button></div>
    </form>`;
}

function billFields(prefix, f, types) {
  if (f.type && !types.includes(f.type)) types = [...types, f.type]; // 类型被删掉了，这条账单仍能正常修改
  const options = types.map((t) => `<option${t === f.type ? " selected" : ""}>${esc(t)}</option>`).join("");
  return `
    <label for="${prefix}-type">类型</label>
    <select id="${prefix}-type" name="type"><option value=""${f.type ? "" : " selected"} disabled>选择类型</option>${options}</select>
    <label for="${prefix}-amount">价格（澳元）</label>
    <input id="${prefix}-amount" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="例如 182.40" value="${esc(f.amount)}">
    <div class="two">
      <div><label for="${prefix}-start">覆盖开始</label><input id="${prefix}-start" name="start" type="date" value="${esc(f.start)}"></div>
      <div><label for="${prefix}-end">覆盖结束</label><input id="${prefix}-end" name="end" type="date" value="${esc(f.end)}"></div>
    </div>
    <label for="${prefix}-due">截止日期</label>
    <input id="${prefix}-due" name="due" type="date" value="${esc(f.due)}">
    ${f.dueAuto ? `<p class="caption">截止日期会自动填成覆盖开始的前一天；手动改过就按你改的。</p>` : ""}`;
}

function billCard(bill, today) {
  const [label, color] = core.statusOf(bill, today);
  const days = core.daysBetween(bill.period_start, bill.period_end) + 1;
  return `
    <div class="card">
      <div class="row"><div class="name grow">${esc(bill.type)}</div><div class="amount">${core.fmtAud(bill.amount_cents)}</div></div>
      <span class="badge ${color}">${esc(label)}</span>
      <div class="caption">覆盖 ${bill.period_start} 至 ${bill.period_end}　·　${days} 天　·　日均 ${core.fmtAud(Math.round(bill.amount_cents / days))}　·　截止 ${bill.due_date}</div>
      <div class="buttons">
        <button type="button" data-act="toggle-paid" data-id="${esc(bill.id)}"${bill.paid ? "" : ' class="primary"'}>${bill.paid ? "改回未付" : "标为已付"}</button>
        <button type="button" data-act="edit" data-id="${esc(bill.id)}">修改</button>
        <button type="button" class="danger" data-act="delete" data-id="${esc(bill.id)}">删除</button>
      </div>
    </div>`;
}

function secondPasswordSection(ledger) {
  const byHer = S.second.has(ledger.id);
  if (S.secondBlob !== null && !byHer) return `<p class="caption">💌 她的密码已经设置好了，只有她自己能改。</p>`;
  const [title, label] = byHer ? ["💌 改我的密码", "新密码"] : ["💌 设置她的密码（第一次）", "她的密码"];
  const intro = byHer
    ? "改完以后用新密码打开。只有你自己能改，Ethan 那边改不了。"
    : "她用这套密码打开，看到的是同一个账本，一样能看能改；只是开场动画换成「噜妹～不要生气了嘛」。<b>设置好以后只有她自己能改，你这边就改不了了</b>，可以让她自己来输。";
  return details(
    "second",
    title,
    `<p>${intro}</p>
     <form data-form="second" autocomplete="off">
       <label for="f-s1">${label}（至少 ${core.MIN_PASSWORD_LEN} 位）</label>
       <input id="f-s1" name="pw1" type="password" autocomplete="new-password">
       <label for="f-s2">再输一次</label>
       <input id="f-s2" name="pw2" type="password" autocomplete="new-password">
       ${errorBox("second")}
       <div class="progress" hidden><div></div></div>
       <div class="buttons"><button class="primary" type="submit">保存</button></div>
     </form>`,
    Boolean(S.errors.second),
  );
}

function billsTab(ledger, today) {
  const [unpaid, paid] = core.splitBills(S.bills);
  const sum = (bs) => bs.reduce((t, b) => t + b.amount_cents, 0);
  const overdue = unpaid.filter((b) => b.due_date < today).length;
  const soon = unpaid.filter((b) => {
    const d = core.daysBetween(today, b.due_date);
    return d >= 0 && d <= core.DUE_SOON_DAYS;
  }).length;
  const shown = { 全部: [...unpaid, ...paid], 未付: unpaid, 已付: paid }[S.filter];
  let empty = "";
  if (!S.bills.length) empty = `<div class="info">还没有账单。噜噜在等你记第一笔 🍊</div>`;
  else if (!shown.length) empty = `<div class="info">${S.filter === "未付" ? "账单都付清啦，噜噜可以安心喝杯热饮了 ☕" : `没有${S.filter}的账单。`}</div>`;
  const add = S.add || (S.add = emptyAdd());
  const isQingzhai = ledger.id === core.QINGZHAI_LEDGER_ID;
  return `
    <div class="metrics">
      <div class="metric"><div class="label">未付合计</div><div class="value">${core.fmtAud(sum(unpaid))}</div></div>
      <div class="metric"><div class="label">已逾期</div><div class="value">${overdue} 笔</div></div>
      <div class="metric"><div class="label">${core.DUE_SOON_DAYS} 天内截止</div><div class="value">${soon} 笔</div></div>
    </div>
    ${details("add", "➕ 添加账单", `<form data-form="add" autocomplete="off">${billFields("a", add, S.types)}${errorBox("add")}
      <div class="buttons"><button class="primary" type="submit">添加</button></div></form>`, !S.bills.length)}
    ${typesManager()}
    <h2>账单列表</h2>
    <div class="seg">${["全部", "未付", "已付"].map((v) => `<button type="button" data-act="filter" data-v="${v}"${v === S.filter ? ' class="on"' : ""}>${v}</button>`).join("")}</div>
    ${empty}
    ${shown.map((b) => billCard(b, today)).join("")}
    <hr style="border:none;border-top:1px solid var(--border);margin:22px 0 8px">
    ${isQingzhai ? secondPasswordSection(ledger) + `<p class="caption">💞 这个账本不能删除。</p>` : `<p class="caption">删除整个账本请在 Mac 上操作。</p>`}`;
}

function spendingTab(today) {
  const groups = core.spendingByMonth(S.bills);
  const [ty, tm] = today.split("-").map(Number);
  const years = [...new Set([...groups.keys()].map((k) => Number(k.split("-")[0])).concat(ty))].sort((a, b) => b - a);
  if (!years.includes(S.spendYear)) S.spendYear = ty;
  const year = S.spendYear;
  const monthBills = (y, m) => groups.get(`${y}-${m}`) || [];
  const total = (bs) => bs.reduce((t, b) => t + b.amount_cents, 0);
  const totals = Array.from({ length: 12 }, (_, i) => total(monthBills(year, i + 1)));
  const max = Math.max(...totals, 1);
  const bars = totals
    .map(
      (c, i) => `<div class="bar${year === ty && i + 1 === tm ? " now" : ""}">
        <div class="v">${c ? Math.round(c / 100).toLocaleString("en-US") : ""}</div>
        <div class="b" style="height:${(c / max) * 150}px"></div><div class="m">${i + 1}月</div></div>`,
    )
    .join("");
  const months = Array.from({ length: 12 }, (_, i) => 12 - i).filter((m) => monthBills(year, m).length);
  const detailsHtml = months
    .map((m) => {
      const bs = [...monthBills(year, m)].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.period_end < b.period_end ? -1 : 1));
      const byType = new Map();
      for (const b of bs) byType.set(b.type, (byType.get(b.type) || 0) + b.amount_cents);
      const rows = bs
        .map((b) => `<tr><td>${esc(b.type)}</td><td class="num">${core.fmtAud(b.amount_cents)}</td><td>${b.period_start}<br>至 ${b.period_end}</td><td>${b.due_date}</td></tr>`)
        .join("");
      return details(
        `m-${year}-${m}`,
        `${m} 月　·　${core.fmtAud(totals[m - 1])}　·　${bs.length} 笔`,
        `${byType.size > 1 ? `<p class="caption">按类型：${[...byType].map(([t, c]) => `${esc(t)} ${core.fmtAud(c)}`).join("　")}</p>` : ""}
         <table><tr><th>类型</th><th>金额</th><th>覆盖时间</th><th>截止日期</th></tr>${rows}</table>`,
        year === ty && m === tm,
      );
    })
    .join("");
  return `
    <p class="caption">只算已付的账单。月份看覆盖时间的结束日期：1–15 号算上个月，16–31 号算当月。</p>
    ${years.length > 1 ? `<label for="f-year">年份</label><select id="f-year" data-act="year">${years.map((y) => `<option${y === year ? " selected" : ""}>${y}</option>`).join("")}</select>` : ""}
    <div class="metrics two-col">
      <div class="metric"><div class="label">${year} 年总花销</div><div class="value">${core.fmtAud(totals.reduce((a, c) => a + c, 0))}</div></div>
      <div class="metric"><div class="label">本月花销（${ty} 年 ${tm} 月）</div><div class="value">${core.fmtAud(total(monthBills(ty, tm)))}</div></div>
    </div>
    <div class="chart">${bars}</div>
    ${year === ty ? `<p class="caption">柚子橙的那根是本月。</p>` : ""}
    ${months.length ? `<h2>每月明细</h2>${detailsHtml}` : `<div class="info">${year} 年还没有已付的账单，噜噜的小钱包还很安静。</div>`}`;
}

function ledgerView(ledger) {
  const today = core.todayISO();
  return `
    <div class="topbar">
      <button type="button" data-act="home">← 所有账本</button>
      <button type="button" data-act="refresh">🔄 刷新</button>
      <button type="button" data-act="lock">🔒 锁上</button>
    </div>
    <h1>${esc(ledger.name)}</h1>
    ${S.bad ? `<div class="warn">有 ${S.bad} 条账单解不开，可能数据损坏了，已跳过。</div>` : ""}
    <div class="tabs">
      <button type="button" data-act="tab" data-tab="bills"${S.tab === "bills" ? ' class="on"' : ""}>📋 账单</button>
      <button type="button" data-act="tab" data-tab="spending"${S.tab === "spending" ? ' class="on"' : ""}>📊 花销</button>
    </div>
    ${S.tab === "bills" ? billsTab(ledger, today) : spendingTab(today)}`;
}

function render() {
  const ledger = S.openId && ledgerById(S.openId);
  if (S.view !== "setup" && S.view !== "home" && !ledger) S.view = "home";
  $app.innerHTML =
    S.view === "setup" ? setupView()
    : S.view === "unlock" ? unlockView(ledger)
    : S.view === "ledger" ? ledgerView(ledger)
    : homeView();
  if (S.view === "ledger" && S.justOpened) {
    S.justOpened = false;
    playScene(ledger);
  }
}

// 刚点进「噜噜的情债」：用她的密码打开的，噜噜求噜妹别生气；否则有逾期没付的，噜妹打噜噜；都付清了，噜妹抱噜噜。
function playScene(ledger) {
  if (ledger.id !== core.QINGZHAI_LEDGER_ID) return;
  const today = core.todayISO();
  const mood = S.second.has(ledger.id) ? "sorry" : core.luluMood(S.bills, today);
  if (!mood) return;
  const floaters = (items) =>
    items.map(([x, d, e]) => `<span class="lulu-float" style="left:${x}%;animation-delay:${d}s">${e}</span>`).join("");
  let html;
  if (mood === "hit") {
    const clip = Math.random() < 0.5 ? "static/lulu_hit_pan" : "static/lulu_hit_punch";
    const overdue = S.bills.filter((b) => !b.paid && b.due_date < today).length;
    html = `<video class="lulu-media" src="${clip}.mp4" poster="${clip}.jpg" autoplay muted playsinline></video>
      <div class="lulu-say">噜妹我错啦～～</div><div class="lulu-sub">有 ${overdue} 笔逾期没付</div>`;
  } else if (mood === "hug") {
    html = `<img class="lulu-media" src="static/lulu_hug.jpg" alt="">
      <div class="lulu-say">噜妹抱抱～</div><div class="lulu-sub">情债都还清啦</div>
      ${floaters([[30, 0.5, "💗"], [62, 0.8, "💕"], [44, 1.2, "💖"], [70, 1.6, "💗"], [26, 2.0, "💕"]])}`;
  } else {
    html = `<img class="lulu-media" src="static/lulu_sorry.jpg" alt="">
      <div class="lulu-say">噜妹～不要生气了嘛</div>
      ${floaters([[32, 0.9, "🥺"], [66, 1.4, "💦"], [40, 2.0, "🥺"], [60, 2.5, "💗"]])}`;
  }
  $scene.innerHTML = `<div class="lulu-scene lulu-${mood}">${html}</div>`;
  setTimeout(() => ($scene.innerHTML = ""), SCENE_MS);
}

// ---------------------------------------------------------------- 写云端

function lockLedger(id) {
  S.keys.delete(id);
  S.second.delete(id);
  S.openId = null;
  S.view = "home";
}

// 执行一次云端改动，成功后重新读这个账本。出错给提示，成功返回 true。
async function write(action, okMsg) {
  try {
    await action();
  } catch (e) {
    if (e instanceof WrongPassword) {
      lockLedger(S.openId);
      toast("密码已经失效（账本可能被删除或重建了），请重新打开账本。", true);
      render();
    } else {
      toast(`没保存成功：${e.message}`, true);
    }
    return false;
  }
  if (okMsg) toast(okMsg);
  await refreshLedger();
  return true;
}

async function refreshLedger() {
  try {
    await loadLedger();
  } catch (e) {
    S.justOpened = false; // 没读到账单就不放动画（不然会按空账本放）
    toast(`读取失败：${e.message}`, true);
  }
  render();
}

const currentKey = () => S.keys.get(S.openId);
const billById = (id) => S.bills.find((b) => b.id === id);

function readBillForm(form) {
  const v = (n) => form.elements[n].value;
  return { type: v("type"), amount: v("amount"), start: v("start"), end: v("end"), due: v("due") };
}

function validBill(f) {
  const amount = f.amount === "" ? null : Number(f.amount);
  const error = core.checkBill(f.type, amount, f.start, f.end, f.due);
  return [error, error ? null : { type: f.type, amount_cents: core.toCents(amount), period_start: f.start, period_end: f.end, due_date: f.due }];
}

// ---------------------------------------------------------------- 表单

const forms = {
  async setup(form) {
    const url = form.elements.url.value.trim().replace(/\/+$/, "");
    const key = form.elements.key.value.trim();
    if (!url.startsWith("https://") || !key) {
      S.errors.setup = "请填完整：地址要以 https:// 开头，key 不能为空。";
      return render();
    }
    await connect(url, key);
  },

  async unlock(form) {
    const ledger = ledgerById(S.openId);
    const password = form.elements.password.value;
    showWorking(form);
    let key = null;
    try {
      key = await cr.deriveKey(password, ledger.kdf);
    } catch {
      S.errors.unlock = "这个账本的加密设置有问题，打不开。";
      return render();
    }
    let bySecond = false;
    if (!(await cr.verifyCheck(key, ledger.check_blob, ledger.id))) {
      key = ledger.id === core.QINGZHAI_LEDGER_ID ? await unlockWithSecond(ledger, password) : null;
      bySecond = Boolean(key);
    }
    if (!key) {
      S.errors.unlock = "密码不对。";
      return render();
    }
    S.keys.set(ledger.id, key);
    if (bySecond) S.second.add(ledger.id);
    S.errors.unlock = null;
    S.view = "ledger";
    await refreshLedger();
  },

  async add(form) {
    const f = { ...readBillForm(form), dueAuto: S.add.dueAuto };
    S.add = f;
    const [error, bill] = validBill(f);
    S.errors.add = error;
    if (error) return render();
    bill.paid = false;
    if (await write(() => core.saveBill(S.store, currentKey(), S.openId, crypto.randomUUID(), bill), `已添加：${bill.type} ${core.fmtAud(bill.amount_cents)}`)) {
      S.add = emptyAdd(); // 清空表单，方便接着录下一条
      render();
    }
  },

  async "add-type"(form) {
    const name = form.elements.name.value;
    S.errors.type = core.checkTypeName(name, S.types);
    if (!S.errors.type) {
      try {
        await S.store.addType(name.trim());
        toast(`已添加类型：${name.trim()}`);
        await loadHome();
      } catch (e) {
        S.errors.type = `没加成功：${e.message}`;
      }
    }
    render();
  },

  async edit(form) {
    const bill = billById(form.dataset.id);
    const [error, fields] = validBill(readBillForm(form));
    if (error) {
      form.querySelector(".error-slot").innerHTML = `<div class="error">${esc(error)}</div>`;
      return;
    }
    $dialog.close();
    await write(() => core.saveBill(S.store, currentKey(), S.openId, bill.id, { ...bill, ...fields }), "已保存修改");
  },

  async second(form) {
    const ledger = ledgerById(S.openId);
    const key = currentKey();
    const byHer = S.second.has(ledger.id);
    const pw1 = form.elements.pw1.value;
    let error = core.checkPassword(pw1, form.elements.pw2.value);
    showWorking(form);
    if (!error && (await cr.verifyCheck(await cr.deriveKey(pw1, ledger.kdf), ledger.check_blob, ledger.id))) {
      // 和 Ethan 的密码一样就不行（不然打开时会被当成他）；对她不说为什么，免得变成猜他密码的办法
      error = byHer ? "这个密码不能用，换一个。" : "这就是你自己的密码，换一个。";
    }
    if (!error && !byHer) {
      try {
        // 页面可能是旧的：她已经设置过了，就只有她自己能改
        if (core.splitSecondKey(await S.store.listBills(ledger.id))[1] !== null) error = "她已经设置过了，只有她自己能改。";
      } catch (e) {
        error = `没保存成功：${e.message}`;
      }
    }
    S.errors.second = error;
    if (error) return render();
    const blob = await cr.wrapKey(key, pw1, core.secondKeyContext(ledger.id));
    S.open.delete("second");
    await write(() => S.store.saveBill(ledger.id, key.auth, core.SECOND_KEY_ROW_ID, blob), byHer ? "密码改好了，下次用新密码打开。" : "已设置她的密码。");
  },
};

// 试试第二套密码（她的）：解开云端那条特殊记录里包着的账本密钥，再用 check 确认它真是这个账本的。
async function unlockWithSecond(ledger, password) {
  let blob;
  try {
    blob = core.splitSecondKey(await S.store.listBills(ledger.id))[1];
  } catch {
    return null;
  }
  if (blob === null) return null;
  try {
    const key = await cr.unwrapKey(blob, password, core.secondKeyContext(ledger.id));
    return (await cr.verifyCheck(key, ledger.check_blob, ledger.id)) ? key : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 按钮

function openDialog(html) {
  $dialog.innerHTML = html;
  $dialog.showModal();
}

const actions = {
  async open(el) {
    S.openId = el.dataset.id;
    S.justOpened = true;
    S.tab = "bills";
    S.filter = "全部";
    S.add = emptyAdd();
    S.errors = {};
    [S.bills, S.bad, S.secondBlob] = [[], 0, null]; // 别把上一个账本的账单画到这个账本下面
    if (S.keys.has(S.openId)) {
      S.view = "ledger";
      await refreshLedger();
    } else {
      S.view = "unlock";
      render();
      document.getElementById("f-pw")?.focus();
    }
  },
  home() {
    S.openId = null;
    S.view = "home";
    S.errors = {};
    render();
  },
  async refresh() {
    await refreshAll();
  },
  lock() {
    lockLedger(S.openId);
    render();
  },
  tab(el) {
    S.tab = el.dataset.tab;
    render();
  },
  filter(el) {
    S.filter = el.dataset.v;
    render();
  },
  async "toggle-paid"(el) {
    const bill = billById(el.dataset.id);
    const paid = !bill.paid;
    await write(() => core.saveBill(S.store, currentKey(), S.openId, bill.id, { ...bill, paid }), (paid ? "已标为已付：" : "已改回未付：") + bill.type);
  },
  edit(el) {
    const bill = billById(el.dataset.id);
    const f = {
      type: bill.type,
      amount: (bill.amount_cents / 100).toFixed(2),
      start: bill.period_start,
      end: bill.period_end,
      due: bill.due_date,
      // 原来的截止日期正好是开始前一天，才继续跟着开始日期走
      dueAuto: bill.due_date === core.defaultDue(bill.period_start),
    };
    openDialog(`
      <form data-form="edit" data-id="${esc(bill.id)}" data-due-auto="${f.dueAuto}" autocomplete="off">
        <h2>修改账单</h2>
        ${billFields("e", f, S.types)}
        <div class="error-slot"></div>
        <div class="buttons"><button class="primary" type="submit">保存</button><button type="button" data-act="close-dialog">取消</button></div>
      </form>`);
  },
  delete(el) {
    const bill = billById(el.dataset.id);
    openDialog(`
      <h2>删除账单</h2>
      <p>确定删除这条账单吗？删除后找不回来。</p>
      <p><b>${esc(bill.type)}</b> ${core.fmtAud(bill.amount_cents)}，截止 ${bill.due_date}</p>
      <div class="buttons">
        <button type="button" class="primary" data-act="confirm-delete" data-id="${esc(bill.id)}">删除</button>
        <button type="button" data-act="close-dialog">取消</button>
      </div>`);
  },
  async "confirm-delete"(el) {
    const bill = billById(el.dataset.id);
    $dialog.close();
    await write(() => S.store.deleteBill(S.openId, currentKey().auth, bill.id), "已删除：" + bill.type);
  },
  "close-dialog"() {
    $dialog.close();
  },
  async "del-type"(el) {
    const name = el.dataset.name;
    try {
      await S.store.deleteType(name);
      toast(`已删除类型：${name}（已经记下的账单不受影响）`);
      await loadHome();
    } catch (e) {
      toast(`没删成功：${e.message}`, true);
    }
    render();
  },
  disconnect() {
    clearConfig();
    S.store = null;
    S.keys.clear();
    S.second.clear();
    S.view = "setup";
    render();
  },
};

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.tagName === "SELECT" || S.busy) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  S.busy = true;
  try {
    await fn(el);
  } finally {
    S.busy = false;
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  if (S.busy) return;
  S.busy = true;
  try {
    await forms[form.dataset.form](form);
  } finally {
    S.busy = false;
  }
});

// 添加 / 修改账单：截止日期默认跟着覆盖开始走（开始前一天），手动改过就不再跟
document.addEventListener("input", (e) => {
  const form = e.target.form;
  if (!form || !["add", "edit"].includes(form.dataset.form)) return;
  const isAdd = form.dataset.form === "add";
  let auto = isAdd ? S.add.dueAuto : form.dataset.dueAuto === "true";
  if (e.target.name === "due") auto = false;
  if (e.target.name === "start" && auto && e.target.value) form.elements.due.value = core.defaultDue(e.target.value);
  if (isAdd) S.add = { ...readBillForm(form), dueAuto: auto };
  else form.dataset.dueAuto = String(auto);
});

document.addEventListener("change", (e) => {
  if (e.target.dataset.act === "year") {
    S.spendYear = Number(e.target.value);
    render();
  }
});

// 记住哪些展开栏开着（重画页面后保持）。toggle 事件不冒泡，所以在捕获阶段听
document.addEventListener(
  "toggle",
  (e) => {
    const id = e.target.dataset && e.target.dataset.id;
    if (!id || e.target.tagName !== "DETAILS") return;
    if (e.target.open) {
      S.open.add(id);
      S.open.delete("!" + id);
    } else {
      S.open.delete(id);
      S.open.add("!" + id); // 默认展开的，被手动收起后不再自动展开
    }
  },
  true,
);

// ---------------------------------------------------------------- 自动同步

async function refreshAll() {
  try {
    await loadHome();
    if (S.openId && !ledgerById(S.openId)) {
      lockLedger(S.openId); // 账本在别处被删了
      toast("这个账本已经不在了。", true);
    }
    if (S.view === "ledger") await loadLedger();
  } catch (e) {
    toast(`读取失败：${e.message}`, true);
  }
  render();
}

// 每隔几秒看一眼云端：账本、类型、打开的账本里的账单有变化（比如对方刚加了一笔）就刷新画面。
// 正在输入、弹出框开着、或者手机锁屏/切到别的 app 时先不刷新。
async function tick() {
  if (!S.store || S.busy || S.syncing || document.hidden || $dialog.open || S.view === "unlock" || S.view === "setup") return;
  const active = document.activeElement;
  if (active && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)) return;
  S.syncing = true; // 不占用 S.busy：同步的时候点按钮照样有反应
  try {
    let changed = fpLedgers(await S.store.listLedgers()) !== S.seen.ledgers;
    if (S.typesFromCloud) changed ||= JSON.stringify(await S.store.listTypes()) !== S.seen.types;
    if (!changed && S.view === "ledger") changed = fpRows(await S.store.listBills(S.openId)) !== S.seen.bills;
    if (changed && !S.busy) await refreshAll();
  } catch {
    /* 网络不好就下次再看 */
  } finally {
    S.syncing = false;
  }
}

// ---------------------------------------------------------------- 启动

async function connect(url, key) {
  const store = new SupabaseStore(url, key);
  try {
    await store.listLedgers();
  } catch (e) {
    S.errors.setup = `连接失败：${e.message}`;
    S.view = "setup";
    return render();
  }
  saveConfig(url, key);
  S.store = store;
  S.errors = {};
  S.view = "home";
  await refreshAll();
}

async function start() {
  const link = readSetupLink(location.hash);
  const hadLink = location.hash.startsWith("#setup=");
  if (location.hash) history.replaceState(null, "", location.pathname + location.search); // 把设置链接从地址栏清掉
  if (link) return connect(link.url, link.key);
  if (hadLink) S.errors.setup = "这个设置链接不对，请让 Ethan 重新发一次（要完整复制）。";
  const config = loadConfig();
  if (!config || hadLink) {
    S.view = "setup";
    return render();
  }
  S.store = new SupabaseStore(config.supabase_url, config.supabase_key);
  await refreshAll();
}

setInterval(tick, REFRESH_MS);
document.addEventListener("visibilitychange", () => document.hidden || tick());
// 离线缓存（sw.js）。本机开发测试时默认不开，免得一直看到旧文件；地址加 ?sw=1 可以测它
const useSW = location.hostname !== "localhost" || new URLSearchParams(location.search).has("sw");
if (useSW && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
start();
