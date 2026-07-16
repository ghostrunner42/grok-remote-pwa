/**
 * Grok Remote PWA app logic — Phases 2–5
 * Depends on: window.createAcpClient, window.GrokPair (from launcher /lib/*)
 */
(function () {
  const PAIR_STORAGE_KEY = "grokRemotePairV1";
  const SESSION_STORAGE_KEY = "grokRemoteSessionId";
  const PERM_MODE_KEY = "grokRemotePermMode";
  const INSTALL_DISMISS_KEY = "grokRemoteInstallDismissed";
  const CHAT_HISTORY_KEY = "grokRemoteChatHistoryV1";
  const MAX_CHAT_HISTORY = 80;
  const APP_VERSION = "0.5.0";

  let pairPayload = null;
  let isConnected = false;
  let acpClient = null;
  let acpSessionId = null;
  let agentMeta = null;
  let busy = false;
  let reconnectTimer = null;
  let reconnecting = false;
  let intentionalClose = false;
  let currentRelPath = "";
  let allFiles = [];
  let html5QrcodeScanner = null;
  let deferredPrompt = null;
  let historyRestored = false;
  let permissionMode = localStorage.getItem(PERM_MODE_KEY) || "auto";

  // ---------- DOM helpers ----------
  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(text, color) {
    const statusEl = $("connection-status");
    const dot = document.getElementById("status-dot") || document.querySelector(".status-dot");
    if (!statusEl) return;
    statusEl.textContent = text;
    // Map legacy greens/reds to theme tokens
    let c = color || "var(--text-mute)";
    if (color === "#22c55e") c = "var(--success)";
    if (color === "#ef4444") c = "var(--danger)";
    if (color === "#eab308") c = "var(--warn)";
    statusEl.style.color = c;
    if (dot) {
      const bg =
        color === "#22c55e"
          ? "#34D399"
          : color === "#ef4444"
            ? "#F87171"
            : color === "#eab308"
              ? "#FBBF24"
              : "#71717A";
      dot.style.background = bg;
      dot.style.boxShadow =
        color === "#22c55e" ? "0 0 8px rgba(52,211,153,0.55)" : "none";
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function hideWelcome() {
    const welcome = $("welcome-screen");
    if (welcome) welcome.style.display = "none";
  }

  // ---------- Pair storage ----------
  function loadPairFromStorage() {
    try {
      const raw = localStorage.getItem(PAIR_STORAGE_KEY);
      if (!raw) return null;
      const parsed = window.GrokPair
        ? window.GrokPair.parsePairPayload(raw)
        : { ok: true, payload: JSON.parse(raw) };
      if (parsed.ok) return parsed.payload;
    } catch (e) {
      console.warn("load pair", e);
    }
    return null;
  }

  function savePairToStorage(payload) {
    const prev = pairPayload || loadPairFromStorage();
    pairPayload = payload;
    localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(payload));
    // New host/cwd/secret → different history bucket; allow re-restore
    if (
      prev &&
      (prev.cwd !== payload.cwd ||
        prev.secret !== payload.secret ||
        prev.host !== payload.host)
    ) {
      historyRestored = false;
    }
  }

  // ---------- Chat history (local, survives reconnect / app reopen) ----------
  function historyBucketKey(payload) {
    const p = payload || pairPayload || loadPairFromStorage();
    if (!p) return `${CHAT_HISTORY_KEY}:nopair`;
    const host = p.host || (() => {
      try {
        return new URL(p.ws).hostname;
      } catch {
        return "local";
      }
    })();
    const secretHint = String(p.secret || "").slice(0, 12);
    return `${CHAT_HISTORY_KEY}:${host}:${p.cwd || ""}:${secretHint}`;
  }

  function loadChatHistory(payload) {
    try {
      const raw = localStorage.getItem(historyBucketKey(payload));
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.warn("load chat history", e);
      return [];
    }
  }

  function saveChatHistory(entries, payload) {
    try {
      const trimmed = entries.slice(-MAX_CHAT_HISTORY);
      localStorage.setItem(historyBucketKey(payload), JSON.stringify(trimmed));
    } catch (e) {
      console.warn("save chat history", e);
    }
  }

  function appendChatHistory(entry, payload) {
    if (!entry || !entry.role) return;
    const text = String(entry.text || "");
    if (!text.trim() && !(entry.tools && entry.tools.length)) return;
    const list = loadChatHistory(payload);
    list.push({
      role: entry.role,
      text,
      tools: Array.isArray(entry.tools) ? entry.tools.slice(0, 24) : undefined,
      ts: entry.ts || Date.now(),
    });
    saveChatHistory(list, payload);
  }

  function clearChatHistoryStorage(payload) {
    try {
      localStorage.removeItem(historyBucketKey(payload));
    } catch (e) {
      /* ignore */
    }
  }

  function clearChatDom() {
    const container = $("chat-container");
    if (!container) return;
    container.querySelectorAll(".message").forEach((el) => el.remove());
  }

  function restoreChatHistory(payload) {
    if (historyRestored) return 0;
    historyRestored = true;
    const list = loadChatHistory(payload);
    if (!list.length) return 0;
    hideWelcome();
    for (const m of list) {
      if (m.role === "user") {
        addMessage("user", m.text || "", { persist: false });
      } else {
        const msgDiv = addMessage("grok", m.text || "", { persist: false });
        if (msgDiv && m.tools && m.tools.length) {
          const body = msgDiv.querySelector(".message-body");
          if (body) {
            const toolsEl = document.createElement("div");
            toolsEl.className = "tool-log";
            toolsEl.style.display = "block";
            toolsEl.style.marginBottom = "6px";
            for (const label of m.tools) {
              const card = document.createElement("div");
              card.style.cssText =
                "background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;margin-bottom:4px;font-size:11px;color:var(--text-dim);font-family:var(--font-mono);";
              card.innerHTML = `<span style="color:var(--accent);">›</span> ${escapeHtml(
                String(label)
              )}`;
              toolsEl.appendChild(card);
            }
            const bubble = body.querySelector(".message-bubble");
            if (bubble) body.insertBefore(toolsEl, bubble);
            else body.appendChild(toolsEl);
          }
        }
      }
    }
    const container = $("chat-container");
    if (container) container.scrollTop = container.scrollHeight;
    return list.length;
  }

  // ---------- Permission UI ----------
  function ensurePermModal() {
    let modal = $("perm-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "perm-modal";
    modal.className = "modal";
    modal.innerHTML = `
      <div class="modal-content" style="max-width:420px;">
        <h3>🔐 Tool permission</h3>
        <p id="perm-summary" style="color:#ccc;font-size:14px;margin:12px 0;white-space:pre-wrap;"></p>
        <pre id="perm-detail" style="background:#0a0a0a;border:1px solid #333;border-radius:10px;padding:10px;font-size:11px;max-height:160px;overflow:auto;color:#888;text-align:left;"></pre>
        <div id="perm-actions" style="display:flex;flex-direction:column;gap:8px;margin-top:14px;"></div>
      </div>`;
    document.body.appendChild(modal);
    return modal;
  }

  function askPermissionUI(params) {
    return new Promise((resolve) => {
      const modal = ensurePermModal();
      const summary = $("perm-summary");
      const detail = $("perm-detail");
      const actions = $("perm-actions");

      const toolCall = params?.toolCall || params?.tool_call || {};
      const title =
        toolCall.title ||
        toolCall.kind ||
        params?.toolCallId ||
        "Agent wants to run a tool";
      summary.textContent = title;
      detail.textContent = JSON.stringify(
        {
          kind: toolCall.kind,
          status: toolCall.status,
          locations: toolCall.locations,
          rawInput: toolCall.rawInput || toolCall.input,
        },
        null,
        2
      ).slice(0, 2000);

      const options = params?.options || [
        { optionId: "allow_once", name: "Allow once" },
        { optionId: "reject_once", name: "Deny" },
      ];

      actions.innerHTML = "";
      options.forEach((opt, i) => {
        const btn = document.createElement("button");
        const id = opt.optionId || opt.id || `opt_${i}`;
        const label = opt.name || opt.label || id;
        const isDeny = /reject|deny|cancel/i.test(id + label);
        btn.textContent = label;
        btn.style.cssText = isDeny
          ? "background:#333;color:#fff;border:none;padding:14px;border-radius:12px;font-weight:600;"
          : "background:#ff1a1a;color:#fff;border:none;padding:14px;border-radius:12px;font-weight:600;";
        btn.onclick = () => {
          modal.style.display = "none";
          resolve(id);
        };
        actions.appendChild(btn);
      });

      modal.style.display = "flex";
    });
  }

  // ---------- ACP connect ----------
  function disconnectAcp({ intentional = true } = {}) {
    intentionalClose = intentional;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (acpClient) {
      try {
        acpClient.onClose = null;
        acpClient.close();
      } catch (e) {
        /* ignore */
      }
    }
    acpClient = null;
    // Keep acpSessionId for resume unless clearing pair
    agentMeta = null;
    isConnected = false;
  }

  function hasLiveSession() {
    return !!(
      isConnected &&
      acpClient &&
      acpClient.ready &&
      (acpSessionId || acpClient.sessionId)
    );
  }

  function scheduleReconnect(reason) {
    if (intentionalClose || reconnecting) return;
    if (!pairPayload && !loadPairFromStorage()) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    setStatus("Reconnecting…", "#eab308");
    console.log("[acp] schedule reconnect:", reason);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureConnected("timer:" + reason);
    }, 1200);
  }

  async function connectAcp(payload) {
    if (!payload?.ws) throw new Error("No pair payload");
    if (!window.createAcpClient) {
      throw new Error("ACP client missing — open via launcher /app/");
    }

    intentionalClose = true;
    disconnectAcp({ intentional: true });
    intentionalClose = false;
    setStatus("Connecting…", "#eab308");

    const AcpWsClient = window.createAcpClient(WebSocket);
    const client = new AcpWsClient(payload.ws, {
      log: (tag, ...args) => console.log(`[acp:${tag}]`, ...args),
    });
    client.permissionMode = permissionMode;
    client.onPermissionRequest = (params) => askPermissionUI(params);
    client.setCwd(payload.cwd);
    // Shell runs on desktop via launcher HTTP bridge (pair.http)
    const bridgeBase =
      payload.http ||
      (payload.host
        ? `http://${payload.host}:3020`
        : location.origin.replace(/\/app\/?$/, "") || location.origin);
    client.terminalBridge = {
      baseUrl: bridgeBase,
      secret: payload.secret || "",
    };

    client.onNotification = (msg) => {
      if (msg.method && String(msg.method).includes("mcp")) return;
    };

    client.onClose = () => {
      isConnected = false;
      if (!intentionalClose) {
        setStatus("Disconnected", "#ef4444");
        scheduleReconnect("ws-close");
      }
    };

    await client.connect({ timeoutMs: 8000 });

    // Resume priority:
    // 1) pair.sessionId from launcher (--session / -c) — desktop attach target
    // 2) in-memory / localStorage phone session (reconnect)
    const pairSessionId = payload.sessionId || payload.session_id || null;
    const storedId = localStorage.getItem(SESSION_STORAGE_KEY) || null;
    if (pairSessionId && storedId && pairSessionId !== storedId) {
      // New desktop attach target wins over a stale phone session
      console.log(
        "[acp] pair sessionId differs from stored; preferring pair:",
        pairSessionId
      );
    }
    const resumeId =
      pairSessionId || acpSessionId || storedId || null;
    const attachedFromPair = !!(pairSessionId && resumeId === pairSessionId);

    let initResult;
    let session;
    let usedResume = !!resumeId;
    try {
      ({ initResult, session } = await client.handshake({
        cwd: payload.cwd,
        createSession: true,
        resumeSessionId: resumeId,
      }));
    } catch (err) {
      // Stale resume id can poison the handshake — drop and retry once fresh
      const msg = String(err.message || err);
      if (resumeId && /session|load|handshake|auth/i.test(msg)) {
        console.warn("[acp] handshake failed with resume, retrying fresh:", msg);
        localStorage.removeItem(SESSION_STORAGE_KEY);
        acpSessionId = null;
        usedResume = false;
        ({ initResult, session } = await client.handshake({
          cwd: payload.cwd,
          createSession: true,
          resumeSessionId: null,
        }));
      } else {
        throw err;
      }
    }

    const sid =
      (typeof window.GrokAcpExtractSessionId === "function"
        ? window.GrokAcpExtractSessionId(session, client.sessionId || resumeId)
        : null) ||
      session?.sessionId ||
      session?.session_id ||
      session?._meta?.sessionId ||
      client.sessionId ||
      null;

    if (!sid) {
      throw new Error("Connected but no session id — handshake incomplete");
    }

    // Detect whether we actually resumed vs got a new session after failed load
    const resumed =
      usedResume &&
      resumeId &&
      String(sid) === String(resumeId);

    acpClient = client;
    agentMeta = initResult;
    acpSessionId = sid;
    client.sessionId = sid;
    localStorage.setItem(SESSION_STORAGE_KEY, acpSessionId);
    isConnected = true;
    pairPayload = payload;

    const model =
      initResult?._meta?.modelState?.currentModelId ||
      session?.models?.currentModelId ||
      "";
    if (resumed && attachedFromPair) {
      setStatus(model ? `ACP • ${model} • attached` : "ACP attached", "#22c55e");
    } else if (resumed) {
      setStatus(model ? `ACP • ${model}` : "ACP connected", "#22c55e");
    } else {
      setStatus(model ? `ACP • ${model}` : "ACP connected", "#22c55e");
    }

    const detail = $("pair-status-detail");
    if (detail) {
      detail.textContent = [
        `cwd: ${payload.cwd}`,
        `session: ${acpSessionId || "—"}`,
        `attach: ${
          resumed
            ? attachedFromPair
              ? "desktop session (pair.sessionId)"
              : "phone resume"
            : "new session"
        }`,
        `ws: ${payload.ws}`,
        `perm: ${permissionMode}`,
        `bridge: ${bridgeBase}`,
      ].join("\n");
    }
    return { initResult, session, resumed, attachedFromPair };
  }

  async function ensureConnected(reason) {
    if (reconnecting) return hasLiveSession();
    if (hasLiveSession()) return true;
    reconnecting = true;
    try {
      // Prefer a fresh live pair from the launcher (handles secret rotation)
      if (reason && /visibility|pageshow|focus|online|send|timer/i.test(reason)) {
        const live = await tryFetchLivePair();
        if (live) pairPayload = live;
      }
      return await checkConnection();
    } finally {
      reconnecting = false;
    }
  }

  async function checkConnection() {
    const payload = pairPayload || loadPairFromStorage();
    pairPayload = payload;
    if (!payload) {
      setStatus("Not paired", "#ef4444");
      isConnected = false;
      return false;
    }
    try {
      await connectAcp(payload);
      return hasLiveSession();
    } catch (e) {
      console.warn("ACP connect failed:", e);
      setStatus("Offline — will retry", "#ef4444");
      isConnected = false;
      acpClient = null;
      scheduleReconnect("connect-fail");
      return false;
    }
  }

  // ---------- Chat UI ----------
  function addMessage(role, content, opts = {}) {
    const container = $("chat-container");
    hideWelcome();
    const msgDiv = document.createElement("div");
    msgDiv.className = `message ${role}`;
    if (role === "grok") {
      msgDiv.innerHTML = `
        <div class="avatar" aria-hidden="true">
          <img src="assets/spacexai-symbol-white.png" alt="">
        </div>
        <div class="message-body">
          <div class="message-bubble">${typeof content === "string" ? escapeHtml(content) : content}</div>
          <div class="message-meta">Grok</div>
        </div>`;
    } else {
      msgDiv.innerHTML = `
        <div class="message-body">
          <div class="message-bubble">${escapeHtml(content)}</div>
          <div class="message-meta">You</div>
        </div>`;
    }
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
    if (opts.persist !== false && typeof content === "string") {
      appendChatHistory({ role, text: content });
    }
    return msgDiv;
  }

  function startAgentTurnUi() {
    hideWelcome();
    const container = $("chat-container");
    const wrap = document.createElement("div");
    wrap.className = "message grok";
    wrap.innerHTML = `
      <div class="avatar" aria-hidden="true">
        <img src="assets/spacexai-symbol-white.png" alt="">
      </div>
      <div class="message-body">
        <div class="tool-log" style="display:none;"></div>
        <div class="thought-log" style="display:none;white-space:pre-wrap;"></div>
        <div class="message-bubble stream-bubble"></div>
        <div class="message-meta">Grok · streaming</div>
      </div>`;
    container.appendChild(wrap);
    container.scrollTop = container.scrollHeight;
    return {
      root: wrap,
      bubble: wrap.querySelector(".stream-bubble"),
      tools: wrap.querySelector(".tool-log"),
      thoughts: wrap.querySelector(".thought-log"),
      meta: wrap.querySelector(".message-meta"),
    };
  }

  function toolLabel(update) {
    const title = update.title || update.kind || "";
    // Prefer human title; never show raw call-UUID as the main label
    if (title && !/^call-[0-9a-f-]+/i.test(title)) return title;
    const kind = update.kind || update.toolName || update.name || "tool";
    return kind;
  }

  function statusBadge(status) {
    const s = String(status || "").toLowerCase();
    if (s === "completed" || s === "success") return { text: "done", color: "#22c55e" };
    if (s === "failed" || s === "error") return { text: "failed", color: "#f87171" };
    if (s === "in_progress" || s === "pending") return { text: "…", color: "#eab308" };
    return { text: status || "", color: "#666" };
  }

  function appendToolCard(toolsEl, update) {
    toolsEl.style.display = "block";
    const id =
      update.toolCallId || update.tool_call_id || update.title || Math.random();
    const safe =
      typeof CSS !== "undefined" && CSS.escape
        ? CSS.escape(String(id))
        : String(id).replace(/"/g, "");
    let card = toolsEl.querySelector(`[data-tool="${safe}"]`);
    if (!card) {
      card = document.createElement("div");
      card.dataset.tool = String(id);
      card.style.cssText =
        "background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:12px;color:var(--text-dim);font-family:var(--font-mono);";
      toolsEl.appendChild(card);
    }
    // Keep best title we've seen
    const label = toolLabel(update);
    if (label && label !== "tool") card.dataset.label = label;
    const display = card.dataset.label || label || "tool";
    const badge = statusBadge(update.status);
    card.innerHTML = `<span style="color:var(--accent);">›</span> <strong style="color:var(--text);font-weight:500;">${escapeHtml(
      String(display)
    )}</strong> <span style="color:${badge.color};margin-left:6px;font-size:11px;">${escapeHtml(
      badge.text
    )}</span>`;
  }

  async function sendMessage() {
    const input = $("prompt-input");
    const sendBtn = $("send-btn");
    const prompt = input.value.trim();
    if (!prompt || busy) return;

    if (!hasLiveSession()) {
      setStatus("Reconnecting…", "#eab308");
      const ok = await ensureConnected("send");
      if (!ok || !hasLiveSession()) {
        addMessage(
          "grok",
          "Not paired / disconnected. Open the join QR with your phone camera (or Settings → reconnect)."
        );
        return;
      }
    }

    addMessage("user", prompt);
    input.value = "";
    input.style.height = "auto";
    busy = true;
    sendBtn.disabled = true;
    setStatus("Agent working…", "#eab308");

    const ui = startAgentTurnUi();
    let text = "";
    let thoughtBuf = "";
    // Thoughts hidden by default — tap to expand
    ui.thoughts.style.display = "none";
    ui.thoughts.style.cursor = "pointer";
    ui.thoughts.title = "Tap to show/hide model thoughts";
    ui.thoughts.onclick = () => {
      ui.thoughts.dataset.open =
        ui.thoughts.dataset.open === "1" ? "0" : "1";
      if (ui.thoughts.dataset.open === "1") {
        ui.thoughts.style.display = "block";
        ui.thoughts.textContent =
          "💭 " + (thoughtBuf.replace(/\s+/g, " ").slice(0, 800) || "(empty)");
      } else {
        ui.thoughts.style.display = thoughtBuf ? "block" : "none";
        if (thoughtBuf) {
          ui.thoughts.textContent = "💭 thinking… (tap)";
        }
      }
    };

    try {
      const result = await acpClient.prompt(prompt, {
        sessionId: acpSessionId || acpClient.sessionId,
        onUpdate: (update) => {
          const kind = update.sessionUpdate || update.type;
          if (kind === "agent_message_chunk") {
            const chunk = update.content?.text || "";
            text += chunk;
            ui.bubble.textContent = text;
          } else if (kind === "agent_thought_chunk") {
            thoughtBuf += update.content?.text || "";
            if (ui.thoughts.dataset.open === "1") {
              ui.thoughts.style.display = "block";
              ui.thoughts.textContent =
                "💭 " + thoughtBuf.replace(/\s+/g, " ").slice(0, 800);
            } else if (thoughtBuf) {
              ui.thoughts.style.display = "block";
              ui.thoughts.textContent = "💭 thinking… (tap)";
            }
          } else if (kind === "tool_call" || kind === "tool_call_update") {
            appendToolCard(ui.tools, update);
          } else if (kind === "user_message_chunk") {
            /* ignore echo */
          } else if (kind === "available_commands_update") {
            /* ignore */
          }
          $("chat-container").scrollTop = $("chat-container").scrollHeight;
        },
      });

      if (!text.trim()) {
        ui.bubble.textContent =
          text ||
          `(turn complete: ${result?.stopReason || result?.stop_reason || "ok"})`;
      }
      ui.meta.textContent = `Grok • ${result?.stopReason || result?.stop_reason || "done"}`;
      const model =
        agentMeta?._meta?.modelState?.currentModelId || "connected";
      setStatus(`ACP • ${model}`, "#22c55e");

      const tools = Array.from(ui.tools.children)
        .map((el) => {
          if (el.dataset && el.dataset.label) return el.dataset.label;
          return (el.textContent || "").replace(/^[›>\s]+/, "").replace(/\s+(done|failed|…).*$/i, "").trim();
        })
        .filter(Boolean);
      appendChatHistory({
        role: "grok",
        text: ui.bubble.textContent || text,
        tools: tools.length ? tools : undefined,
      });
    } catch (err) {
      console.error(err);
      ui.bubble.textContent =
        "❌ " + (err.message || String(err)) + "\n\nTry reconnecting in Settings.";
      ui.meta.textContent = "Grok • error";
      setStatus("Error — tap settings", "#ef4444");
      appendChatHistory({
        role: "grok",
        text: ui.bubble.textContent,
      });
      if (String(err.message || "").includes("WebSocket closed")) {
        isConnected = false;
      }
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  // ---------- Files (ACP x.ai/fs/*) ----------
  function switchTab(tab) {
    const chatContainer = $("chat-container");
    const filesContainer = $("files-container");
    const inputArea = document.querySelector(".input-area");
    const tabChat = $("tab-chat");
    const tabFiles = $("tab-files");

    if (tab === "chat") {
      chatContainer.style.display = "block";
      filesContainer.style.display = "none";
      inputArea.style.display = "flex";
      tabChat.classList.add("active");
      tabFiles.classList.remove("active");
    } else {
      chatContainer.style.display = "none";
      filesContainer.style.display = "block";
      inputArea.style.display = "none";
      tabChat.classList.remove("active");
      tabFiles.classList.add("active");
      loadFiles(currentRelPath);
    }
  }

  function relFromAbs(abs) {
    const cwd = (pairPayload?.cwd || "").replace(/\/$/, "");
    if (abs.startsWith(cwd + "/")) return abs.slice(cwd.length + 1);
    if (abs === cwd) return "";
    return abs;
  }

  async function loadFiles(rel = "") {
    const listEl = $("file-list");
    const breadcrumbEl = $("breadcrumb");
    if (!listEl) return;

    if (!isConnected || !acpClient) {
      listEl.innerHTML =
        '<div style="padding:20px;text-align:center;color:#666;">Pair with desktop first</div>';
      return;
    }

    listEl.innerHTML =
      '<div style="padding:20px;text-align:center;color:#666;">Loading via ACP…</div>';
    currentRelPath = rel;
    breadcrumbEl.textContent = "/" + (rel || "");

    try {
      const result = await acpClient.fsList(rel || pairPayload.cwd);
      allFiles = result.files || [];
      renderFileList(allFiles);
    } catch (err) {
      console.warn("fsList failed", err);
      listEl.innerHTML = `<div style="padding:16px;color:#f87171;font-size:13px;">
        Files API unavailable on this agent build.<br>
        <span style="color:#888;">${escapeHtml(err.message)}</span><br><br>
        Tip: ask chat to list files — tools still work.
      </div>`;
    }
  }

  function renderFileList(files) {
    const listEl = $("file-list");
    if (!files.length) {
      listEl.innerHTML =
        '<div style="padding:20px;text-align:center;color:#666;">Empty directory</div>';
      return;
    }
    listEl.innerHTML = files
      .map((f) => {
        const icon = f.isDirectory ? "📁" : "📄";
        const name = escapeHtml(f.name);
        const pathAttr = escapeHtml(f.path || f.name);
        return `<div class="file-row" data-path="${pathAttr}" data-dir="${f.isDirectory ? "1" : "0"}"
          style="padding:14px 16px;border-bottom:1px solid #222;display:flex;align-items:center;gap:10px;cursor:pointer;">
          <span>${icon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;">${name}</span>
        </div>`;
      })
      .join("");

    listEl.querySelectorAll(".file-row").forEach((row) => {
      row.onclick = () => {
        const p = row.dataset.path;
        const isDir = row.dataset.dir === "1";
        if (isDir) {
          const rel = relFromAbs(p);
          loadFiles(rel);
        } else {
          openFile(p);
        }
      };
    });
  }

  function filterFiles() {
    const q = ($("file-search")?.value || "").toLowerCase();
    renderFileList(
      allFiles.filter((f) => (f.name || "").toLowerCase().includes(q))
    );
  }

  function goBack() {
    if (!currentRelPath) return;
    const parts = currentRelPath.split("/").filter(Boolean);
    parts.pop();
    loadFiles(parts.join("/"));
  }

  async function openFile(path) {
    try {
      const content = await acpClient.fsRead(path);
      const sheet = document.createElement("div");
      sheet.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:200;display:flex;flex-direction:column;padding:12px;";
      sheet.innerHTML = `
        <div style="background:#111;border-radius:16px;flex:1;display:flex;flex-direction:column;overflow:hidden;max-width:900px;margin:0 auto;width:100%;">
          <div style="padding:12px 16px;border-bottom:1px solid #222;font-size:13px;color:#aaa;word-break:break-all;">${escapeHtml(path)}</div>
          <textarea id="file-content" style="flex:1;background:#0a0a0a;color:#eee;border:none;padding:14px;font-family:ui-monospace,monospace;font-size:13px;resize:none;outline:none;">${escapeHtml(content)}</textarea>
          <div style="padding:12px;display:flex;gap:10px;border-top:1px solid #222;">
            <button id="file-save" style="flex:1;background:#ff1a1a;color:#fff;border:none;padding:14px;border-radius:9999px;font-weight:600;">Save</button>
            <button id="file-close" style="flex:1;background:#333;color:#fff;border:none;padding:14px;border-radius:9999px;">Close</button>
          </div>
        </div>`;
      document.body.appendChild(sheet);
      sheet.querySelector("#file-close").onclick = () => sheet.remove();
      sheet.querySelector("#file-save").onclick = async () => {
        const btn = sheet.querySelector("#file-save");
        btn.textContent = "Saving…";
        try {
          await acpClient.fsWrite(
            path,
            sheet.querySelector("#file-content").value
          );
          btn.textContent = "✅ Saved";
          setTimeout(() => sheet.remove(), 600);
        } catch (e) {
          alert("Save failed: " + e.message);
          btn.textContent = "Save";
        }
      };
    } catch (e) {
      alert("Open failed: " + e.message);
    }
  }

  // ---------- Settings / QR ----------
  function loadSettings() {
    const ta = $("pair-json");
    const p = pairPayload || loadPairFromStorage();
    if (ta && p) ta.value = JSON.stringify(p, null, 2);
    const perm = $("perm-mode");
    if (perm) perm.value = permissionMode;
  }

  function showSettings() {
    loadSettings();
    $("settings-modal").style.display = "flex";
  }

  async function savePairSettings() {
    const raw = $("pair-json").value.trim();
    const perm = $("perm-mode");
    if (perm) {
      permissionMode = perm.value || "auto";
      localStorage.setItem(PERM_MODE_KEY, permissionMode);
    }
    if (!raw) {
      $("settings-modal").style.display = "none";
      if (acpClient) acpClient.permissionMode = permissionMode;
      return;
    }
    const parsed = window.GrokPair
      ? window.GrokPair.parsePairPayload(raw)
      : (() => {
          try {
            return { ok: true, payload: JSON.parse(raw) };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        })();
    if (!parsed.ok) {
      alert(parsed.error || "Invalid pair payload");
      return;
    }
    savePairToStorage(parsed.payload);
    $("settings-modal").style.display = "none";
    const ok = await checkConnection();
    if (ok) {
      const attached =
        pairPayload?.sessionId &&
        acpSessionId &&
        String(pairPayload.sessionId) === String(acpSessionId);
      addMessage(
        "grok",
        attached
          ? `✅ Attached to desktop session.\n\nSession: ${acpSessionId}\nPermission: ${permissionMode}\n\nAgent memory matches that TUI/desktop session. Avoid prompting from TUI and phone at the same time.`
          : `✅ Paired with official Grok Build.\n\nSession: ${acpSessionId}\nPermission mode: ${permissionMode}\n\nSend a message — it runs on your PC.`
      );
    } else {
      addMessage(
        "grok",
        "❌ Could not complete ACP initialize. Is the launcher / agent serve running?"
      );
    }
  }

  function clearChat() {
    clearChatHistoryStorage(pairPayload || loadPairFromStorage());
    clearChatDom();
    historyRestored = true;
    const welcome = $("welcome-screen");
    if (welcome) {
      welcome.style.display = "";
      welcome.innerHTML = `<div class="welcome-logo"><img src="assets/spacexai-symbol-white.png" alt=""></div><h2>Chat cleared</h2><p>History on this device was removed. Agent session on the PC is unchanged.</p>`;
    }
    $("settings-modal").style.display = "none";
  }

  function clearPair() {
    clearChatHistoryStorage(pairPayload || loadPairFromStorage());
    localStorage.removeItem(PAIR_STORAGE_KEY);
    localStorage.removeItem(SESSION_STORAGE_KEY);
    pairPayload = null;
    acpSessionId = null;
    historyRestored = false;
    clearChatDom();
    disconnectAcp({ intentional: true });
    setStatus("Not paired", "#ef4444");
    if ($("pair-json")) $("pair-json").value = "";
    $("settings-modal").style.display = "none";
  }

  async function applyPairFromQrOrText(decodedText) {
    const parsed = window.GrokPair
      ? window.GrokPair.parsePairPayload(decodedText)
      : (() => {
          try {
            return { ok: true, payload: JSON.parse(decodedText) };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        })();
    if (!parsed.ok) {
      if (parsed.legacy) {
        alert("Legacy Express QR. Use Phase 2+ launcher: npm run launch");
        return false;
      }
      alert(parsed.error || "Invalid pair payload");
      return false;
    }
    savePairToStorage(parsed.payload);
    const ok = await checkConnection();
    if (ok) {
      const attached =
        pairPayload?.sessionId &&
        acpSessionId &&
        String(pairPayload.sessionId) === String(acpSessionId);
      addMessage(
        "grok",
        attached
          ? `✅ QR paired — attached to desktop session ${acpSessionId}.\n\nShared agent history (not live TUI mirror).`
          : `✅ QR paired — ACP ready.\n\nSession ${acpSessionId}\nSay hi or ask me to list files.`
      );
    }
    return ok;
  }

  function loadHtml5Qrcode() {
    return new Promise((resolve, reject) => {
      if (typeof Html5QrcodeScanner !== "undefined") {
        resolve();
        return;
      }
      const existing = document.querySelector("script[data-html5-qrcode]");
      if (existing) {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () =>
          reject(new Error("QR library failed to load"))
        );
        return;
      }
      const s = document.createElement("script");
      s.src = "vendor/html5-qrcode.min.js";
      s.dataset.html5Qrcode = "1";
      s.onload = () => resolve();
      s.onerror = () =>
        reject(new Error("Could not load local QR library (vendor/html5-qrcode.min.js)"));
      document.head.appendChild(s);
    });
  }

  function canUseInAppCamera() {
    // getUserMedia for QR requires a secure context (HTTPS or localhost).
    // LAN http://192.168.x.x is NOT secure — phone camera on the OS QR is the path.
    const secure =
      window.isSecureContext ||
      location.protocol === "https:" ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1";
    return !!secure && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async function startQRScan() {
    const modal = $("qr-modal");
    modal.style.display = "flex";

    // Preferred path: system camera → join URL → this app (works offline of HTTPS).
    if (!canUseInAppCamera()) {
      $("qr-reader").innerHTML = `
        <div style="text-align:left;padding:4px 4px 8px;font-size:13px;line-height:1.5;color:var(--text-dim);">
          <p style="color:var(--text);font-weight:500;margin-bottom:10px;">Use your phone camera — not in-app Scan</p>
          <ol style="padding-left:18px;margin:0 0 12px;">
            <li style="margin-bottom:8px;">On the <strong style="color:var(--text);">PC pair page</strong>, show the QR (it encodes the join URL).</li>
            <li style="margin-bottom:8px;">Open the QR with the <strong style="color:var(--text);">system camera</strong> (or share sheet).</li>
            <li style="margin-bottom:8px;">That opens <code style="color:var(--accent);">/join</code> and pairs this app automatically.</li>
          </ol>
          <p style="font-size:12px;color:var(--text-mute);margin-bottom:12px;">
            In-app camera scan needs HTTPS or localhost. On plain LAN HTTP it is blocked by the browser — that is expected.
          </p>
          <p style="font-size:12px;color:var(--text-mute);">
            Already paired this session? Close this and wait for reconnect, or pull a live pair via Settings → Save &amp; connect after refreshing.
          </p>
        </div>`;
      return;
    }

    $("qr-reader").innerHTML =
      '<p style="color:#888;font-size:13px;padding:12px;">Loading camera…</p>';
    try {
      await loadHtml5Qrcode();
    } catch (e) {
      $("qr-reader").innerHTML =
        '<p style="color:#f87171;font-size:13px;padding:12px;">' +
        escapeHtml(e.message) +
        "<br><br>Use your phone’s system camera on the desktop QR (join URL), or Settings → paste pair JSON.</p>";
      return;
    }
    $("qr-reader").innerHTML = "";
    html5QrcodeScanner = new Html5QrcodeScanner(
      "qr-reader",
      { fps: 10, qrbox: { width: 250, height: 250 } },
      false
    );
    html5QrcodeScanner.render(
      async (decodedText) => {
        stopQRScan();
        await applyPairFromQrOrText(decodedText);
      },
      () => {}
    );
  }

  function stopQRScan() {
    $("qr-modal").style.display = "none";
    if (html5QrcodeScanner) {
      html5QrcodeScanner.clear().catch(() => {});
      html5QrcodeScanner = null;
    }
  }

  function isStandalone() {
    if (window.GrokPwaDetect && typeof GrokPwaDetect.isStandalone === "function") {
      return GrokPwaDetect.isStandalone();
    }
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true ||
      document.referrer.includes("android-app://")
    );
  }

  function markPwaInstalled() {
    if (window.GrokPwaDetect && typeof GrokPwaDetect.markInstalled === "function") {
      GrokPwaDetect.markInstalled();
    }
  }

  /**
   * When the user is in a normal browser tab but we believe the PWA is
   * installed, surface a banner. Browsers cannot always force-open the
   * home-screen app — we deep-link to start_url and rely on OS link capture.
   */
  async function maybeShowOpenInstalledBanner() {
    if (isStandalone()) return;
    if (!window.GrokPwaDetect) return;
    let det = { installed: false, method: "none" };
    try {
      det = await GrokPwaDetect.detectInstalled();
    } catch {
      return;
    }
    if (!det.installed) return;

    const banner = $("open-pwa-banner");
    if (!banner) return;
    const copy = $("open-pwa-banner-copy");
    if (copy) {
      if (isIos()) {
        copy.textContent =
          "Open Grok Remote from your home screen (iOS can’t auto-switch from Safari).";
      } else if (isAndroid()) {
        copy.textContent =
          "Tap Open app, or enable “Open supported links” in Android app info for automatic handoff.";
      } else {
        copy.textContent = "Open the installed app window for the best experience.";
      }
    }
    banner.classList.add("show");
    const go = $("open-pwa-banner-go");
    const dismiss = $("open-pwa-banner-dismiss");
    if (go) {
      go.onclick = () => {
        // Navigate to start_url — Android may open the installed PWA when
        // handle_links / Open supported links is enabled.
        const u = new URL("/app/?source=open-installed", location.origin);
        u.searchParams.set("t", String(Date.now()));
        // Keep current pair in storage; also re-pass if present
        try {
          const raw = localStorage.getItem(PAIR_STORAGE_KEY);
          if (raw) {
            const b64 = btoa(unescape(encodeURIComponent(raw)))
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, "");
            u.searchParams.set("pair", b64);
          }
        } catch {
          /* ignore */
        }
        location.assign(u.toString());
      };
    }
    if (dismiss) {
      dismiss.onclick = () => {
        banner.classList.remove("show");
      };
    }
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
  }

  function isAndroid() {
    return /android/i.test(navigator.userAgent);
  }

  function showInstallBanner(force) {
    if (isStandalone()) return;
    if (!force && localStorage.getItem(INSTALL_DISMISS_KEY) === "1") return;
    const banner = $("install-banner");
    if (!banner) return;
    const copy = $("install-banner-copy");
    if (copy) {
      if (isIos()) {
        copy.textContent = "Share → Add to Home Screen for full-screen use";
      } else if (deferredPrompt) {
        copy.textContent = "Install for a full-screen home-screen app";
      } else {
        copy.textContent = "Add from the browser menu for a home-screen app";
      }
    }
    banner.classList.add("show");
  }

  function dismissInstallBanner() {
    const banner = $("install-banner");
    if (banner) banner.classList.remove("show");
    localStorage.setItem(INSTALL_DISMISS_KEY, "1");
  }

  function closeInstallModal() {
    const m = $("install-modal");
    if (m) m.style.display = "none";
  }

  function openInstallModal(stepsHtml, sub) {
    const m = $("install-modal");
    const steps = $("install-steps");
    const subEl = $("install-modal-sub");
    const primary = $("install-modal-primary");
    if (subEl) subEl.textContent = sub || "Install Grok Remote like a native app.";
    if (steps) steps.innerHTML = stepsHtml;
    if (primary) {
      primary.style.display = "block";
      if (deferredPrompt) {
        primary.textContent = "Install now";
        primary.onclick = () => installPWA();
      } else {
        primary.textContent = "Got it";
        primary.onclick = () => closeInstallModal();
      }
    }
    if (m) m.style.display = "flex";
  }

  function installPWA() {
    // Chrome/Edge native prompt when available (usually needs HTTPS; LAN may skip)
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(() => {
        deferredPrompt = null;
        dismissInstallBanner();
        closeInstallModal();
        updateInstallUi();
      });
      return;
    }

    // Already installed
    if (isStandalone()) {
      openInstallModal(
        "<li>You’re already running as an installed app.</li>",
        "Installed"
      );
      return;
    }

    // Platform-specific instructions (critical on iOS + LAN HTTP)
    if (isIos()) {
      openInstallModal(
        [
          "<li>Tap the <strong>Share</strong> button in Safari (square with arrow).</li>",
          "<li>Scroll and tap <strong>Add to Home Screen</strong>.</li>",
          "<li>Tap <strong>Add</strong> — open from the home screen for full-screen Grok Remote.</li>",
          "<li>Pair once via the join QR; the home-screen app keeps the same site data.</li>",
        ].join(""),
        "iPhone / iPad (Safari)"
      );
      return;
    }

    if (isAndroid()) {
      openInstallModal(
        [
          "<li>Open the browser menu <strong>⋮</strong>.</li>",
          "<li>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>",
          "<li>Confirm — launch from the home screen icon for standalone mode.</li>",
          "<li>On plain HTTP LAN, Chrome may only offer “Add to Home screen” (still works).</li>",
        ].join(""),
        "Android (Chrome)"
      );
      return;
    }

    openInstallModal(
      [
        "<li>Use the browser install / app menu if shown.</li>",
        "<li>Chrome: menu → <strong>Install Grok Remote</strong> or <strong>Cast, save, and share</strong>.</li>",
        "<li>Edge: app icon in the address bar → <strong>Install</strong>.</li>",
      ].join(""),
      "Desktop browser"
    );
  }

  function updateInstallUi() {
    const btn = $("install-btn");
    if (!btn) return;
    if (isStandalone()) {
      btn.style.display = "none";
      dismissInstallBanner();
      return;
    }
    // Always offer install entry on mobile / when prompt available
    btn.style.display = "inline-flex";
    if (deferredPrompt || isIos() || isAndroid()) {
      showInstallBanner(false);
    }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    // Register relative to /app/ so scope covers the PWA
    navigator.serviceWorker
      .register("sw.js", { scope: "./" })
      .then((reg) => {
        console.log("[pwa] service worker registered", reg.scope);
        // Check for updates when app resumes
        reg.update().catch(() => {});
      })
      .catch((err) => console.warn("[pwa] SW register failed", err));
  }

  function setupInput() {
    const input = $("prompt-input");
    if (!input) return;
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 120) + "px";
    });
  }

  /**
   * Support deep-link ?pair=<base64url(json)> from older QRs / manual links.
   */
  function loadPairFromQuery() {
    try {
      const u = new URL(location.href);
      const raw = u.searchParams.get("pair") || u.searchParams.get("p");
      if (!raw) return null;
      let text = raw;
      try {
        // base64url
        text = decodeURIComponent(raw);
        if (!text.trim().startsWith("{")) {
          const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
          text = atob(b64);
        }
      } catch (e) {
        /* already plain json */
      }
      const parsed = window.GrokPair
        ? window.GrokPair.parsePairPayload(text)
        : { ok: true, payload: JSON.parse(text) };
      if (!parsed.ok) return null;
      savePairToStorage(parsed.payload);
      // Clean URL
      u.searchParams.delete("pair");
      u.searchParams.delete("p");
      history.replaceState({}, "", u.pathname + u.search);
      return parsed.payload;
    } catch (e) {
      console.warn("query pair failed", e);
      return null;
    }
  }

  /**
   * If opened via same host as launcher, refresh pair from /api/pair.
   */
  async function tryFetchLivePair() {
    try {
      const res = await fetch("/api/pair", { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.v === 1 && data.ws) {
        savePairToStorage(data);
        return data;
      }
    } catch (e) {
      /* not served from launcher root */
    }
    // Launcher serves PWA under /app/ — pair API is on parent origin
    try {
      const res = await fetch(location.origin + "/api/pair", {
        cache: "no-store",
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.v === 1 && data.ws) {
        savePairToStorage(data);
        return data;
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  async function init() {
    console.log(`%c[Grok Remote] PWA v${APP_VERSION}`, "color:#888");
    if (isStandalone()) {
      document.body.classList.add("is-standalone");
      markPwaInstalled();
    }
    registerServiceWorker();
    // Fire-and-forget install detection for browser→PWA handoff UI
    maybeShowOpenInstalledBanner().catch(() => {});

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      updateInstallUi();
      showInstallBanner(true);
    });

    window.addEventListener("appinstalled", () => {
      deferredPrompt = null;
      localStorage.setItem(INSTALL_DISMISS_KEY, "1");
      dismissInstallBanner();
      updateInstallUi();
      console.log("[pwa] appinstalled");
    });

    pairPayload =
      loadPairFromQuery() ||
      (await tryFetchLivePair()) ||
      loadPairFromStorage();
    loadSettings();
    setupInput();

    // Restore phone-side transcript immediately (before ACP connect)
    if (pairPayload) {
      restoreChatHistory(pairPayload);
    }

    const status = $("connection-status");
    if (status) {
      status.style.cursor = "pointer";
      status.onclick = () => showSettings();
    }

    // Auto-reconnect when phone wakes / tab resumes / network returns
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        ensureConnected("visibility");
      }
    });
    window.addEventListener("pageshow", (ev) => {
      // bfcache restore on mobile Safari
      if (ev.persisted || !isConnected) ensureConnected("pageshow");
    });
    window.addEventListener("online", () => ensureConnected("online"));
    window.addEventListener("focus", () => {
      if (!isConnected || !acpClient?.ready) ensureConnected("focus");
    });

    updateInstallUi();
    // Soft prompt after a short delay if not installed
    setTimeout(() => {
      if (!isStandalone()) showInstallBanner(false);
    }, 2500);

    if (pairPayload) {
      acpSessionId = localStorage.getItem(SESSION_STORAGE_KEY);
      const ok = await checkConnection();
      if (ok) {
        const welcome = $("welcome-screen");
        // Only show connected tip when chat is still empty
        if (welcome && !document.querySelector("#chat-container .message")) {
          welcome.innerHTML = `<div class="welcome-logo"><img src="assets/spacexai-symbol-white.png" alt=""></div><h2>Connected</h2><p>Session ready on your PC. Send a message below.</p><p style="margin-top:10px;font-size:12px;color:var(--text-mute);">Tip: use <strong style="color:var(--success);font-weight:500;">Install</strong> to add Grok Remote to your home screen.</p>`;
        }
      }
    } else {
      setStatus("Not paired", "#ef4444");
    }
  }

  // Public API for inline handlers in HTML
  window.GrokRemote = {
    init,
    sendMessage,
    showSettings,
    savePairSettings,
    clearPair,
    clearChat,
    startQRScan,
    stopQRScan,
    switchTab,
    loadFiles,
    goBack,
    filterFiles,
    installPWA,
    dismissInstallBanner,
    closeInstallModal,
    checkConnection,
  };

  // Back-compat globals used by onclick=
  window.sendMessage = sendMessage;
  window.showSettings = showSettings;
  window.savePairSettings = savePairSettings;
  window.clearPair = clearPair;
  window.clearChat = clearChat;
  window.startQRScan = startQRScan;
  window.stopQRScan = stopQRScan;
  window.switchTab = switchTab;
  window.loadFiles = loadFiles;
  window.goBack = goBack;
  window.filterFiles = filterFiles;
  window.installPWA = installPWA;
  window.dismissInstallBanner = dismissInstallBanner;
  window.closeInstallModal = closeInstallModal;

  window.addEventListener("load", init);
})();
