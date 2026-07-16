/**
 * Grok Remote PWA app logic — Phases 2–5
 * Depends on: window.createAcpClient, window.GrokPair (from launcher /lib/*)
 */
(function () {
  const PAIR_STORAGE_KEY = "grokRemotePairV1";
  const SESSION_STORAGE_KEY = "grokRemoteSessionId";
  const PERM_MODE_KEY = "grokRemotePermMode";

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
    pairPayload = payload;
    localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(payload));
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
    const resumeId =
      acpSessionId || localStorage.getItem(SESSION_STORAGE_KEY) || null;
    const { initResult, session } = await client.handshake({
      cwd: payload.cwd,
      createSession: true,
      resumeSessionId: resumeId,
    });

    acpClient = client;
    agentMeta = initResult;
    acpSessionId = session?.sessionId || session?.session_id || null;
    if (acpSessionId) {
      localStorage.setItem(SESSION_STORAGE_KEY, acpSessionId);
    }
    isConnected = true;
    pairPayload = payload;

    const model =
      initResult?._meta?.modelState?.currentModelId ||
      session?.models?.currentModelId ||
      "";
    setStatus(model ? `ACP • ${model}` : "ACP connected", "#22c55e");

    const detail = $("pair-status-detail");
    if (detail) {
      detail.textContent = `cwd: ${payload.cwd}\nsession: ${acpSessionId || "—"}\nws: ${payload.ws}\nperm: ${permissionMode}\nbridge: ${bridgeBase}`;
    }
    return { initResult, session };
  }

  async function ensureConnected(reason) {
    if (reconnecting) return isConnected;
    if (isConnected && acpClient && acpClient.ready) return true;
    reconnecting = true;
    try {
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
      return true;
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
  function addMessage(role, content) {
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

    if (!isConnected || !acpClient || !acpClient.ready) {
      setStatus("Reconnecting…", "#eab308");
      const ok = await ensureConnected("send");
      if (!ok || !acpClient?.ready) {
        addMessage(
          "grok",
          "Not paired / disconnected. Open /join again or reconnect in Settings."
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
        sessionId: acpSessionId,
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
    } catch (err) {
      console.error(err);
      ui.bubble.textContent =
        "❌ " + (err.message || String(err)) + "\n\nTry reconnecting in Settings.";
      ui.meta.textContent = "Grok • error";
      setStatus("Error — tap settings", "#ef4444");
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
      addMessage(
        "grok",
        `✅ Paired with official Grok Build.\n\nSession: ${acpSessionId}\nPermission mode: ${permissionMode}\n\nSend a message — it runs on your PC.`
      );
    } else {
      addMessage(
        "grok",
        "❌ Could not complete ACP initialize. Is the launcher / agent serve running?"
      );
    }
  }

  function clearPair() {
    localStorage.removeItem(PAIR_STORAGE_KEY);
    localStorage.removeItem(SESSION_STORAGE_KEY);
    pairPayload = null;
    acpSessionId = null;
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
      addMessage(
        "grok",
        `✅ QR paired — ACP ready.\n\nSession ${acpSessionId}\nSay hi or ask me to list files.`
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

  async function startQRScan() {
    const modal = $("qr-modal");
    modal.style.display = "flex";
    $("qr-reader").innerHTML =
      '<p style="color:#888;font-size:13px;padding:12px;">Loading camera…</p>';
    try {
      await loadHtml5Qrcode();
    } catch (e) {
      $("qr-reader").innerHTML =
        '<p style="color:#f87171;font-size:13px;padding:12px;">' +
        escapeHtml(e.message) +
        "<br><br>Use Settings → paste pair JSON, or open the join URL on this device.</p>";
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

  function installPWA() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.finally(() => {
      deferredPrompt = null;
      if ($("install-btn")) $("install-btn").style.display = "none";
    });
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
    console.log("%c[Grok Remote] Phase 3+ app (local assets)", "color:#888");
    // Drop any broken SW that may have cached unpkg-dependent HTML
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => r.unregister().catch(() => {}));
      });
      // Optional re-register lightweight SW later — skip for now to avoid cache traps
    }
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      if ($("install-btn")) $("install-btn").style.display = "inline-block";
    });

    pairPayload =
      loadPairFromQuery() ||
      (await tryFetchLivePair()) ||
      loadPairFromStorage();
    loadSettings();
    setupInput();

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

    if (pairPayload) {
      acpSessionId = localStorage.getItem(SESSION_STORAGE_KEY);
      const ok = await checkConnection();
      if (ok) {
        const welcome = $("welcome-screen");
        if (welcome) {
          welcome.innerHTML = `<h2>✅ Connected</h2><p>Session ready on your PC. Send a message below.</p><p style="margin-top:8px;font-size:12px;color:#555;">Re-opens auto-reconnect. Chat is on the agent server (not the TUI transcript).</p>`;
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
    startQRScan,
    stopQRScan,
    switchTab,
    loadFiles,
    goBack,
    filterFiles,
    installPWA,
    checkConnection,
  };

  // Back-compat globals used by onclick=
  window.sendMessage = sendMessage;
  window.showSettings = showSettings;
  window.savePairSettings = savePairSettings;
  window.clearPair = clearPair;
  window.startQRScan = startQRScan;
  window.stopQRScan = stopQRScan;
  window.switchTab = switchTab;
  window.loadFiles = loadFiles;
  window.goBack = goBack;
  window.filterFiles = filterFiles;
  window.installPWA = installPWA;

  window.addEventListener("load", init);
})();
