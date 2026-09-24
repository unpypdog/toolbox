"use strict";

/**
 * AI 多轮会话的本地仓库。
 *
 * GitHub Pages 没有服务端会话，本模块用 IndexedDB 保存会话、图片、消息和记录快照。
 * API Key 刻意不进入这里，仍由 app.js 的既有设置存储单独管理。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CertAiSession = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DB_NAME = "te-cert-ai-sessions-v1";
  const STORE_NAME = "sessions";
  const ACTIVE_KEY = "te-cert-ai-active-session-v1";
  const VERSION = 1;
  const memory = new Map();
  let databasePromise = null;

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function makeId(prefix) {
    const random =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    return (prefix || "session") + "-" + random;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function createSession(seed) {
    const input = seed || {};
    const now = nowIso();
    return {
      version: VERSION,
      id: input.id || makeId("ai"),
      title: input.title || "新建识别会话",
      createdAt: input.createdAt || now,
      updatedAt: now,
      providerId: input.providerId || "",
      model: input.model || "",
      initialText: input.initialText || "",
      extractionRaw: input.extractionRaw || "",
      images: Array.isArray(input.images) ? clone(input.images) : [],
      messages: Array.isArray(input.messages) ? clone(input.messages) : [],
      decisions: Array.isArray(input.decisions) ? clone(input.decisions) : [],
      pendingOperations: Array.isArray(input.pendingOperations)
        ? clone(input.pendingOperations)
        : [],
      pendingDecisions: Array.isArray(input.pendingDecisions) ? clone(input.pendingDecisions) : [],
      recordSnapshot: Array.isArray(input.recordSnapshot) ? clone(input.recordSnapshot) : [],
    };
  }

  function normalizeSession(value) {
    if (!value || typeof value !== "object") return null;
    const session = createSession(value);
    session.createdAt = value.createdAt || session.createdAt;
    session.updatedAt = value.updatedAt || session.updatedAt;
    return session;
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    if (typeof indexedDB === "undefined") {
      databasePromise = Promise.resolve(null);
      return databasePromise;
    }
    databasePromise = new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, 1);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("updatedAt", "updatedAt");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return databasePromise;
  }

  async function withStore(mode, operation) {
    const db = await openDatabase();
    if (!db) return null;
    return new Promise((resolve) => {
      let transaction;
      try {
        transaction = db.transaction(STORE_NAME, mode);
      } catch {
        resolve(null);
        return;
      }
      const store = transaction.objectStore(STORE_NAME);
      let request;
      try {
        request = operation(store);
      } catch {
        resolve(null);
        return;
      }
      request.onsuccess = () => resolve(request.result === undefined ? true : request.result);
      request.onerror = () => resolve(null);
    });
  }

  async function save(session) {
    const normalized = normalizeSession(session);
    if (!normalized) throw new Error("会话数据无效。");
    normalized.updatedAt = nowIso();
    memory.set(normalized.id, clone(normalized));
    await withStore("readwrite", (store) => store.put(normalized));
    return clone(normalized);
  }

  async function load(id) {
    if (!id) return null;
    const stored = await withStore("readonly", (store) => store.get(id));
    const value = stored || memory.get(id);
    return value ? normalizeSession(value) : null;
  }

  async function list() {
    const stored = await withStore("readonly", (store) => store.getAll());
    const values = Array.isArray(stored) ? stored : Array.from(memory.values());
    return values
      .map(normalizeSession)
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async function remove(id) {
    if (!id) return false;
    memory.delete(id);
    await withStore("readwrite", (store) => store.delete(id));
    if (getActiveId() === id) setActiveId("");
    return true;
  }

  function getActiveId() {
    try {
      return localStorage.getItem(ACTIVE_KEY) || "";
    } catch {
      return "";
    }
  }

  function setActiveId(id) {
    try {
      if (id) localStorage.setItem(ACTIVE_KEY, id);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* 隐私模式：本次页面仍可使用，只是不跨刷新恢复。 */
    }
  }

  function ensureRecordIds(records) {
    return (records || []).map((record) => {
      const copy = Object.assign({}, record);
      copy.recordId = copy.recordId || makeId("record");
      return copy;
    });
  }

  function snapshotRecords(records) {
    return ensureRecordIds(records).map((record) => ({
      recordId: record.recordId,
      lineNo: record.lineNo,
      name: record.name || "",
      hospital: record.hospital || "",
      dateRaw: record.dateRaw || "",
      status: record.status || "invalid",
      issues: Array.isArray(record.issues) ? record.issues.slice() : [],
      aiNote: record.aiNote || "",
      aiSources: record.aiSources && typeof record.aiSources === "object"
        ? clone(record.aiSources)
        : {},
      aiImageRefs: Array.isArray(record.aiImageRefs) ? clone(record.aiImageRefs) : [],
    }));
  }

  function buildContext(session, records, instruction, recentLimit) {
    const current = snapshotRecords(records);
    const limit = Math.max(2, Math.min(Number(recentLimit) || 8, 16));
    const messages = Array.isArray(session && session.messages) ? session.messages : [];
    const unresolved = current
      .filter((record) => record.status !== "ready" || record.issues.length)
      .map((record) => ({
        recordId: record.recordId,
        name: record.name,
        issues: record.issues,
        aiNote: record.aiNote,
      }));
    return {
      instruction: String(instruction || "").trim(),
      currentRecords: current,
      unresolvedIssues: unresolved,
      confirmedDecisions: Array.isArray(session && session.decisions)
        ? session.decisions.slice(-20)
        : [],
      recentConversation: messages.slice(-limit).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };
  }

  return {
    DB_NAME,
    STORE_NAME,
    ACTIVE_KEY,
    createSession,
    save,
    load,
    list,
    remove,
    getActiveId,
    setActiveId,
    ensureRecordIds,
    snapshotRecords,
    buildContext,
  };
});
