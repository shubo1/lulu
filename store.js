// 云端（Supabase）读写：和 Mac 版 store.py 的 SupabaseStore 用同样的接口。
// 改动都走云端定义好的函数（supabase_setup.sql 在 Mac 版的仓库里），手机版不改云端的表。

export class StoreError extends Error {}
export class WrongPassword extends StoreError {}

const TIMEOUT_MS = 15000;

export class SupabaseStore {
  constructor(url, key) {
    this.base = url.replace(/\/+$/, "") + "/rest/v1";
    this.headers = { apikey: key, "Content-Type": "application/json" };
    if (key.startsWith("eyJ")) this.headers.Authorization = `Bearer ${key}`; // 旧式 anon key 是 JWT
  }

  async request(method, path, body) {
    let resp;
    try {
      resp = await fetch(this.base + path, {
        method,
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined, // 老 iPhone 没有 timeout
      });
    } catch {
      throw new StoreError("连不上云端，请检查网络。");
    }
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* 不是 JSON */
    }
    if (resp.status >= 400) {
      const code = data && data.code;
      if (code === "28P01") throw new WrongPassword("密码不对。");
      const detail = (data && data.message) || text.slice(0, 200);
      if (resp.status === 401 || resp.status === 403) throw new StoreError(`云端拒绝访问，请检查地址和 key 是否正确（${detail}）`);
      if (resp.status === 404) throw new StoreError(`云端找不到数据表（${detail}）`);
      throw new StoreError(`云端出错（${resp.status}）：${detail}`);
    }
    return data;
  }

  rpc(name, args) {
    return this.request("POST", `/rpc/${name}`, args);
  }

  listLedgers() {
    return this.request("GET", "/ledgers?select=id,name,kdf,check_blob,created_at&order=created_at.asc,id.asc");
  }

  listBills(ledgerId) {
    return this.request(
      "GET",
      `/bills?select=id,ciphertext,updated_at&ledger_id=eq.${encodeURIComponent(ledgerId)}&order=updated_at.asc`,
    );
  }

  saveBill(ledgerId, auth, billId, ciphertext) {
    return this.rpc("save_bill", { p_ledger: ledgerId, p_auth: auth, p_bill: billId, p_ciphertext: ciphertext });
  }

  deleteBill(ledgerId, auth, billId) {
    return this.rpc("delete_bill", { p_ledger: ledgerId, p_auth: auth, p_bill: billId });
  }

  async listTypes() {
    return (await this.request("GET", "/bill_types?select=name&order=sort.asc,name.asc")).map((r) => r.name);
  }

  addType(name) {
    return this.rpc("add_bill_type", { p_name: name.trim() });
  }

  deleteType(name) {
    return this.rpc("delete_bill_type", { p_name: name });
  }
}

// ---------------------------------------------------------------- 连接设置（存在这台手机上）

const CONFIG_KEY = "lulu.config";

export function loadConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CONFIG_KEY));
    return c && c.supabase_url && c.supabase_key ? c : null;
  } catch {
    return null;
  }
}

export function saveConfig(url, key) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ supabase_url: url, supabase_key: key }));
}

export function clearConfig() {
  localStorage.removeItem(CONFIG_KEY);
}

// 设置链接：网址 # 后面是 setup=<base64url(JSON)>。# 后面的部分浏览器不会发给任何服务器。
export function readSetupLink(hash) {
  const m = /^#setup=([A-Za-z0-9_-]+)$/.exec(hash || "");
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const c = JSON.parse(json);
    const url = String(c.supabase_url || "");
    // 只接受 https（本机测试时也接受 http://localhost）
    if (!c.supabase_key || !(url.startsWith("https://") || url.startsWith("http://localhost:"))) return null;
    return { url, key: String(c.supabase_key) };
  } catch {
    return null;
  }
}
