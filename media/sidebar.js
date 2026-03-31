(function () {
  'use strict';
  var vscode = null;

  function surfaceFatalError(msg) {
    var b = document.getElementById('fatalBanner');
    if (b) { b.textContent = msg; b.classList.add('on'); }
    if (vscode) { try { vscode.postMessage({ type: 'webviewError', payload: msg }); } catch(_) {} }
  }

  try {
    vscode = acquireVsCodeApi();
  var initialSummary = JSON.parse(document.getElementById("root").dataset.initialSummary || "null");
  var D = function(id) { return document.getElementById(id); };

  // DOM refs
  var statusBadge = D('statusBadge'), statusTxt = D('statusTxt');
  var btnSettings = D('btnSettings'), btnRefresh = D('btnRefresh'), btnNewChat = D('btnNewChat');
  var settingsDrawer = D('settingsDrawer');
  var personaSelect = D('personaSelect'), modelSelect = D('modelSelect');
  var btnSyncModels = D('btnSyncModels'), btnApplyModel = D('btnApplyModel');
  var btnAddMcp = D('btnAddMcp'), btnReloadMcp = D('btnReloadMcp'), btnSaveMcp = D('btnSaveMcp');
  var btnOpenMcpSettings = D('btnOpenMcpSettings'), btnManageMcp = D('btnManageMcp');
  var mcpList = D('mcpList'), mcpCount = D('mcpCount');
  var homeView = D('homeView'), chatView = D('chatView');
  var btnBack = D('btnBack'), attachmentRow = D('attachmentRow');
  var sessionList = D('sessionList'), messages = D('messages');
  var editsBanner = D('editsBanner'), bannerTxt = D('bannerTxt');
  var btnApply = D('btnApply'), btnRevert = D('btnRevert');
  var chipMode = D('chipMode'), chipModel = D('chipModel');
  var taskInput = D('taskInput'), btnSend = D('btnSend'), btnAttach = D('btnAttach');
  var permBtn = D('permBtn'), permBtnIcon = D('permBtnIcon'), permBtnLabel = D('permBtnLabel');
  var scrollBtn = D('scrollBtn'), selfLearnToggle = D('selfLearnToggle');
  var learningBadge = D('learningBadge');
  var todoDrawer = D('todoDrawer'), todoDrawerList = D('todoDrawerList'), todoDrawerCount = D('todoDrawerCount');
  var filesDrawer = D('filesDrawer'), filesDrawerList = D('filesDrawerList'), filesDrawerCount = D('filesDrawerCount');

  // State
  var summary = null, models = [], mcpServers = [];
  var chatHistory = [], attachedFiles = [];
  var conversationMode = 'agent', inChat = false;
  var activeModelName = '', permMode = 'default';
  var autoRestoreSessionAttempted = false;
  var thinkingSteps = [], thinkingStartTime = null;
  var modePopupOpen = false, modelPopupOpen = false, permPopupOpen = false;
  var isBusy = false;
  var composeState = { mode: 'new', messageId: '', messageIndex: -1 };
  var pendingRequest = null;
  var streamBuffer = '';
  var streamBubble = null;
  var streamChunkQueue = [];
  var streamFlushTimer = null;
  var streamRenderBuffer = '';
  var currentTodos = [];
  var currentFiles = [];
  var todoDrawerCollapsed = true;
  var filesDrawerCollapsed = true;

  // --- Drawer render functions ---
  function renderTodoDrawer(todos) {
    if (!todoDrawer || !todoDrawerList || !Array.isArray(todos) || !todos.length) {
      if (todoDrawer) todoDrawer.classList.remove('visible');
      return;
    }
    currentTodos = todos;
    var doneCount = 0;
    todoDrawerList.innerHTML = '';
    for (var i = 0; i < todos.length; i++) {
      var t = todos[i];
      var status = String(t.status || 'pending').toLowerCase();
      var isDone = status === 'done' || status === 'completed';
      var isActive = status === 'in-progress' || status === 'in_progress';
      var isBlocked = status === 'blocked' || status === 'failed';
      if (isDone) doneCount++;
      var statusClass = isDone ? 'done' : isActive ? 'in-progress' : isBlocked ? 'blocked' : 'pending';
      var item = document.createElement('div');
      item.className = 'todo-item' + (isActive ? ' active' : '');
      var iconEl = document.createElement('span');
      iconEl.className = 'todo-icon ' + statusClass;
      if (isDone) iconEl.textContent = '\u2713';
      else if (isBlocked) iconEl.textContent = '\u2717';
      else if (!isActive) iconEl.textContent = '\u25CB';
      // in-progress uses CSS spinner via ::after
      var titleEl = document.createElement('span');
      titleEl.className = 'todo-title' + (isDone ? ' done' : isBlocked ? ' blocked' : '');
      titleEl.textContent = t.task || t.title || t.text || '';
      item.appendChild(iconEl);
      item.appendChild(titleEl);
      todoDrawerList.appendChild(item);
    }
    todoDrawerCount.textContent = doneCount + '/' + todos.length;
    todoDrawer.classList.add('visible');
    todoDrawer.classList.toggle('collapsed', todoDrawerCollapsed);
  }

  function renderFilesDrawer(files) {
    if (!filesDrawer || !filesDrawerList || !Array.isArray(files) || !files.length) {
      if (filesDrawer) filesDrawer.classList.remove('visible');
      return;
    }
    currentFiles = files;
    filesDrawerList.innerHTML = '';
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var fpath = String(f.path || f.file || f.filePath || f.fileName || '');
      var basename = fpath.split(/[\\/]/).pop() || fpath;
      var added = parseInt(f.additions || f.linesAdded || 0, 10) || 0;
      var removed = parseInt(f.deletions || f.linesRemoved || 0, 10) || 0;
      var item = document.createElement('div');
      item.className = 'file-item';
      item.dataset.filepath = fpath;
      var iconSpan = '<span class="file-item-icon">\uD83D\uDCCB</span>';
      var nameSpan = '<span class="file-item-name" title="' + esc(fpath) + '">' + esc(basename) + '</span>';
      var statsSpan = '<span class="file-item-stats">' +
        (added > 0 ? '<span class="file-stat-add">+' + added + '</span>' : '') +
        (removed > 0 ? '<span class="file-stat-del">\u2212' + removed + '</span>' : '') +
        '</span>';
      item.innerHTML = iconSpan + nameSpan + statsSpan;
      item.addEventListener('click', (function(p) {
        return function() { vscode.postMessage({ type: 'openFile', payload: p }); };
      })(fpath));
      filesDrawerList.appendChild(item);
    }
    filesDrawerCount.textContent = files.length + ' file' + (files.length === 1 ? '' : 's');
    filesDrawer.classList.add('visible');
    filesDrawer.classList.toggle('collapsed', filesDrawerCollapsed);
  }

  function resetDrawers() {
    currentTodos = []; currentFiles = [];
    if (todoDrawer) { todoDrawer.classList.remove('visible'); todoDrawerList.innerHTML = ''; todoDrawerCount.textContent = ''; }
    if (filesDrawer) { filesDrawer.classList.remove('visible'); filesDrawerList.innerHTML = ''; filesDrawerCount.textContent = ''; }
  }

  // Helpers
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function relTime(iso) {
    var d = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!isFinite(d) || d < 1) return 'just now';
    if (d < 60) return d + 'm ago';
    var h = Math.round(d / 60);
    return h < 24 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
  }
  function autoGrow(el) { if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; }
  function updateScrollButton() {
    if (!scrollBtn) return;
    var el = D('main');
    var show = false;
    if (inChat && el) {
      var overflow = el.scrollHeight > el.clientHeight + 8;
      var atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
      show = overflow && !atBottom;
    }
    scrollBtn.classList.toggle('visible', show);
  }
  function scheduleScrollButtonUpdate() { requestAnimationFrame(updateScrollButton); }
  function scrollBottom() {
    requestAnimationFrame(function() {
      var el = D('main');
      if (el) el.scrollTop = el.scrollHeight;
      updateScrollButton();
    });
  }
  function on(el, evt, fn) { if (el) el.addEventListener(evt, fn); }
  function makeMessageId() { return 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
  function resetComposeState() { composeState = { mode: 'new', messageId: '', messageIndex: -1 }; if (taskInput) taskInput.placeholder = conversationMode === 'ask' ? 'Ask Pulse a question…' : conversationMode === 'plan' ? 'Describe the change you want planned…' : 'Ask Pulse anything about your code…'; if (btnSend) btnSend.title = 'Send (Enter)'; }
  function beginEditMessage(messageId, messageIndex) {
    var item = chatHistory[messageIndex];
    if (!item || item.role !== 'user') return;
    composeState = { mode: 'edit', messageId: messageId, messageIndex: messageIndex };
    if (taskInput) {
      taskInput.value = item.text || item.content || '';
      autoGrow(taskInput);
      taskInput.focus();
      taskInput.setSelectionRange(taskInput.value.length, taskInput.value.length);
      taskInput.placeholder = 'Edit message and resend…';
    }
    if (btnSend) {
      btnSend.title = 'Save & Send';
    }
  }
  function beginRetryMessage(messageId, messageIndex) {
    var responseItem = chatHistory[messageIndex];
    if (!responseItem) return;
    var sourceText = '';
    for (var i = messageIndex - 1; i >= 0; i--) {
      if (chatHistory[i].role === 'user') {
        sourceText = chatHistory[i].text || chatHistory[i].content || '';
        break;
      }
    }
    composeState = { mode: 'retry', messageId: messageId, messageIndex: messageIndex };
    if (taskInput) {
      taskInput.value = sourceText;
      autoGrow(taskInput);
      taskInput.focus();
      taskInput.setSelectionRange(taskInput.value.length, taskInput.value.length);
      taskInput.placeholder = 'Retrying the last request…';
    }
    if (btnSend) {
      btnSend.title = 'Retry';
    }
    sendTask();
  }

  // Markdown rendering
  function renderMarkdown(raw) {
    if (!raw) return '';
    // Strip <break> tags, thinking artifacts, and clean up model output noise
    raw = raw.replace(/<break\\s*\\/?>/gi, '\\n').replace(/<\\/break>/gi, '\\n');
    // Strip raw JSON blocks that models sometimes emit as response text
    raw = raw.replace(/^\\s*\\{[\\s\\S]*?"response"\\s*:\\s*"[\\s\\S]*?"[\\s\\S]*?\\}\\s*$/gm, function(match) {
      try { var obj = JSON.parse(match); return obj.response || match; } catch(e) { return match; }
    });
    // Extract fenced code blocks first, replace with placeholders
    var blocks = [];
    var blockIdx = 0;
    var stripped = raw.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, function(_, lang, code) {
      var label = lang || 'code';
      var bid = 'cb-' + (blockIdx);
      var placeholder = '%%CODEBLOCK_' + (blockIdx++) + '%%';
      blocks.push('<div class="code-block"><div class="code-header"><span class="code-lang">' + esc(label) + '</span>' +
        '<button class="code-copy" data-bid="' + bid + '">Copy</button></div>' +
        '<pre id="' + bid + '"><code>' + esc(code) + '</code></pre></div>');
      return placeholder;
    });
    // Also match fenced code blocks without language
    stripped = stripped.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, function(_, code) {
      var bid = 'cb-' + (blockIdx);
      var placeholder = '%%CODEBLOCK_' + (blockIdx++) + '%%';
      blocks.push('<div class="code-block"><pre id="' + bid + '"><code>' + esc(code) + '</code></pre></div>');
      return placeholder;
    });
    // Now escape the rest
    var html = esc(stripped);
    // Inline code
    html = html.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
    // Bold and italic
    html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
    // Headings
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // Lists
    html = html.replace(/^[\\-\\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^(\\d+)\\. (.+)$/gm, '<li>$2</li>');
    // Wrap adjacent <li> in <ul>
    html = html.replace(/((?:<li>.*?<\\/li>\\n?)+)/g, '<ul>$1</ul>');
    // Links: [text](url)
    html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" title="$2">$1</a>');
    // Newlines to br (except inside pre/code)
    html = html.replace(/\\n/g, '<br>');
    // Restore code block placeholders
    for (var bi = 0; bi < blocks.length; bi++) {
      html = html.replace('%%CODEBLOCK_' + bi + '%%', blocks[bi]);
    }
    return html;
  }

  // Permission labels
  var PERM_LABELS = {
    'default': { icon: '\u2625', label: 'Default Approvals' },
    'full':    { icon: '\u26A0', label: 'Bypass Approvals' },
    'strict':  { icon: '\uD83D\uDD12', label: 'Require Approvals' }
  };

  function updatePermUI(mode) {
    permMode = mode || 'default';
    var info = PERM_LABELS[permMode] || PERM_LABELS['default'];
    if (permBtnIcon) permBtnIcon.textContent = info.icon;
    if (permBtnLabel) permBtnLabel.textContent = info.label;
    var popup = D('permPopup');
    if (popup) {
      popup.querySelectorAll('.perm-opt').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.perm === permMode);
      });
    }
  }

  // Conversation mode
  function renderConversationMode(mode) {
    conversationMode = mode || 'agent';
    if (chipMode) chipMode.textContent = conversationMode.toUpperCase();
    var popup = D('modePopup');
    if (popup) popup.querySelectorAll('.popup-opt').forEach(function(btn) { btn.classList.toggle('active', btn.dataset.mode === conversationMode); });
    if (taskInput && composeState.mode === 'new') {
      taskInput.placeholder = conversationMode === 'ask' ? 'Ask Pulse a question\u2026'
        : conversationMode === 'plan' ? 'Describe the change you want planned\u2026'
        : 'Ask Pulse anything about your code\u2026';
    }
  }

  // Popups
  function closeAllPopups() { closeModePopup(); closeModelPopup(); closePermPopup(); }
  function openModePopup() { closeAllPopups(); var p = D('modePopup'); if (p) p.classList.remove('hidden'); modePopupOpen = true; }
  function closeModePopup() { var p = D('modePopup'); if (p) p.classList.add('hidden'); modePopupOpen = false; }
  function openModelPopup() {
    closeAllPopups();
    var popup = D('modelPopup'), list = D('modelPopupList');
    if (!popup || !list) return;
    list.innerHTML = '';
    if (!models.length) { list.innerHTML = '<div style="padding:8px 10px;font-size:11px;opacity:.5">No models</div>'; }
    else { models.forEach(function(m) {
      var btn = document.createElement('button'); btn.type = 'button';
      btn.className = 'model-item' + (m.name === activeModelName ? ' active' : '');
      btn.title = describeModelTooltip(m);
      btn.addEventListener('click', function(e) { e.stopPropagation(); activeModelName = m.name;
        if (chipModel) { chipModel.textContent = m.name.split(':')[0].slice(0,14) || '\u2013'; chipModel.title = m.name; }
        vscode.postMessage({ type: 'setModel', payload: { role: 'planner', model: m.name } });
        vscode.postMessage({ type: 'setModel', payload: { role: 'editor', model: m.name } });
        vscode.postMessage({ type: 'setModel', payload: { role: 'fast', model: m.name } });
        closeModelPopup(); });
      var row = document.createElement('div'); row.className = 'model-item-row';
      var name = document.createElement('span'); name.className = 'model-item-name'; name.textContent = m.name;
      row.appendChild(name);
      if (m.name === activeModelName) row.appendChild(createModelBadge('Active', 'active'));
      btn.appendChild(row);

      var badges = document.createElement('div'); badges.className = 'model-item-badges';
      badges.appendChild(createModelBadge('Agent-ready', 'ready'));
      badges.appendChild(createModelBadge(sourceLabelForModel(m), sourceBadgeClassForModel(m)));
      if (m.supportsVision) badges.appendChild(createModelBadge('Vision', 'vision'));
      btn.appendChild(badges);
      list.appendChild(btn);
    }); }
    popup.classList.remove('hidden'); modelPopupOpen = true;
  }
  function createModelBadge(label, className) {
    var badge = document.createElement('span');
    badge.className = 'model-badge ' + className;
    badge.textContent = label;
    return badge;
  }
  function sourceLabelForModel(model) {
    if (!model || !model.source) return 'Compatible';
    if (model.source === 'running') return 'Running';
    if (model.source === 'local') return 'Local';
    return 'Configured';
  }
  function sourceBadgeClassForModel(model) {
    if (!model || !model.source) return 'configured';
    return model.source === 'running' ? 'running' : model.source === 'local' ? 'local' : 'configured';
  }
  function describeModelTooltip(model) {
    if (!model || !model.name) return 'Model';
    var parts = [model.name, 'Usable with the current agent', 'Source: ' + sourceLabelForModel(model)];
    if (model.supportsVision) parts.push('Supports vision/image tasks');
    return parts.join(' — ');
  }
  function closeModelPopup() { var p = D('modelPopup'); if (p) p.classList.add('hidden'); modelPopupOpen = false; }
  function openPermPopup() { closeAllPopups(); var p = D('permPopup'); if (p) { updatePermUI(permMode); p.classList.remove('hidden'); } permPopupOpen = true; }
  function closePermPopup() { var p = D('permPopup'); if (p) p.classList.add('hidden'); permPopupOpen = false; }
  document.addEventListener('click', closeAllPopups);

  // Thinking — GitHub Copilot-style step list
  var thinkingTimer = null, stepsCollapsed = false;
  function resetThinkingPanel() {
    if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
    stopReasoningLabelCycle();
    thinkingSteps = [];
    thinkingStartTime = null;
    stepsCollapsed = false;
    var panel = D('thinkingPanel'), title = D('thinkingTitle'), elapsed = D('thinkingElapsed'), list = D('stepsList');
    if (!panel) return;
    panel.classList.add('hidden');
    panel.classList.remove('done', 'steps-collapsed');
    if (title) title.textContent = 'Thinking…';
    if (elapsed) elapsed.textContent = '';
    if (list) list.innerHTML = '';
  }

  function startThinking() {
    thinkingSteps = []; thinkingStartTime = Date.now(); stepsCollapsed = false;
    var panel = D('thinkingPanel'), title = D('thinkingTitle'), elapsed = D('thinkingElapsed'), list = D('stepsList');
    if (!panel) return;
    panel.classList.remove('hidden', 'done');
    panel.classList.remove('steps-collapsed');
    if (title) title.textContent = 'Thinking\u2026';
    if (elapsed) elapsed.textContent = '';
    if (list) list.innerHTML = '';
    if (thinkingTimer) clearInterval(thinkingTimer);
    thinkingTimer = setInterval(function() {
      if (elapsed && thinkingStartTime) {
        var s = ((Date.now() - thinkingStartTime) / 1000).toFixed(0);
        elapsed.textContent = s + 's';
      }
    }, 1000);
  }
    var reasoningLabels = ['Thinking\u2026', 'Reasoning\u2026', 'Analyzing\u2026', 'Checking\u2026', 'Processing\u2026'];
    var reasoningLabelIdx = 0;
    var reasoningLabelTimer = null;
    function startReasoningLabelCycle(labelEl) {
      if (reasoningLabelTimer) return;
      reasoningLabelTimer = setInterval(function() {
        reasoningLabelIdx = (reasoningLabelIdx + 1) % reasoningLabels.length;
        if (labelEl) labelEl.textContent = reasoningLabels[reasoningLabelIdx];
      }, 1800);
    }
    function stopReasoningLabelCycle() {
      if (reasoningLabelTimer) { clearInterval(reasoningLabelTimer); reasoningLabelTimer = null; }
      reasoningLabelIdx = 0;
    }

    function addThinkingStep(step) {
    thinkingSteps.push(step);
    var title = D('thinkingTitle'), list = D('stepsList');
    var kind = step.kind || 'step';
    var label = step.step || 'Processing';
    if (!list) return;

    // Drawer updates — render without adding a step item
    if (kind === 'todo_update') { renderTodoDrawer(step.todos || []); return; }
    if (kind === 'files_changed') { renderFilesDrawer(step.files || []); return; }

    if (kind === 'reasoning') {
      // Update the live reasoning block — APPEND new chunk to accumulated text
      var active = list.querySelector('.step-reasoning-active');
      if (active) {
        var rt = active.querySelector('.step-reasoning-text');
        if (rt) {
          var incoming = String(step.detail || '');
          if (!incoming.trim()) { scrollBottom(); return; }
          // Avoid endlessly duplicating placeholder pulse text.
          var current = rt.textContent || '';
          var normalizedIncoming = incoming.replace(/\s+/g, ' ').trim();
          var normalizedTail = current.slice(Math.max(0, current.length - normalizedIncoming.length - 4)).replace(/\s+/g, ' ').trim();
          var isPlaceholder = /^(Reasoning through tools and code changes|Thinking through the next action)\.\.\.$/i.test(normalizedIncoming);
          if ((normalizedIncoming && normalizedTail === normalizedIncoming) || (isPlaceholder && current.indexOf(incoming) >= 0)) {
            scrollBottom(); return;
          }
          // Append new tokens; keep only the last 800 chars to avoid DOM bloat
          var joiner = current && !/\s$/.test(current) && !/^\s/.test(incoming) ? ' ' : '';
          var appended = current + joiner + incoming;
          rt.textContent = appended.length > 800 ? appended.slice(appended.length - 800) : appended;
        }
        scrollBottom(); return;
      }
      var item = document.createElement('div');
      item.className = 'step-item step-reasoning step-reasoning-active';
      var labelEl = document.createElement('span');
      labelEl.className = 'step-reasoning-label';
      labelEl.textContent = reasoningLabels[0];
      var textEl = document.createElement('span');
      textEl.className = 'step-reasoning-text';
      textEl.textContent = step.detail || '';
      item.appendChild(labelEl);
      item.appendChild(textEl);
      list.appendChild(item);
      if (title) title.textContent = 'Generating\u2026';
      startReasoningLabelCycle(labelEl);
      scrollBottom(); return;
    }

    // Seal the previous reasoning block so the next reasoning chunk starts fresh
    var prevActive = list.querySelector('.step-reasoning-active');
    if (prevActive) {
      prevActive.classList.remove('step-reasoning-active');
      var prevLabel = prevActive.querySelector('.step-reasoning-label');
      if (prevLabel) prevLabel.textContent = 'Thought';
      stopReasoningLabelCycle();
    }

    var item = document.createElement('div');
    item.className = 'step-item step-' + kind;

    if (kind === 'file_patch') {
      if (title) title.textContent = 'Generating patch\u2026';
      item.innerHTML =
        '<span class="step-icon">&#9998;</span>' +
        '<span class="step-label">Generating patch</span>' +
        '<span class="step-line-count">(' + esc(String(step.lineCount || 0)) + ' lines) in&nbsp;</span>' +
        '<span class="step-file-name">' + esc(step.file || '') + '</span>';
    } else if (kind === 'file_patched') {
      if (title) title.textContent = 'Edited ' + (step.file || '');
      item.innerHTML =
        '<span class="step-icon" style="color:var(--green)">&#10003;</span>' +
        '<span class="step-label">Edited</span>' +
        '<span class="step-file-name">' + esc(step.file || '') + '</span>' +
        '<span class="step-diff-added">+' + esc(String(step.linesAdded || 0)) + '</span>' +
        '<span class="step-diff-removed">\u2212' + esc(String(step.linesRemoved || 0)) + '</span>';
    } else if (kind === 'terminal') {
      if (title) title.textContent = 'Running terminal';
      item.innerHTML =
        '<span class="step-icon">&#9654;</span>' +
        '<span class="step-cmd">$ ' + esc(step.detail || step.step || '') + '</span>';
    } else {
      // Generic step
      if (title) title.textContent = label;
      item.innerHTML =
        '<span class="step-icon">' + esc(step.icon || '\u25cf') + '</span>' +
        '<span class="step-label">' + esc(label) + '</span>' +
        (step.detail ? '<span class="step-detail">' + esc(step.detail) + '</span>' : '');
    }

    list.appendChild(item);
    // Auto-scroll the step list itself if it overflows
    list.scrollTop = list.scrollHeight;
    scrollBottom();
  }
  function finishThinking(cancelled) {
    var panel = D('thinkingPanel'), title = D('thinkingTitle'), elapsed = D('thinkingElapsed'), list = D('stepsList');
    if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
    if (!panel) return;
    panel.classList.add('done');
    // Unseal any active reasoning block and stop label cycling
    stopReasoningLabelCycle();
    if (list) {
      var ar = list.querySelector('.step-reasoning-active');
      if (ar) {
        ar.classList.remove('step-reasoning-active');
        var arLabel = ar.querySelector('.step-reasoning-label');
        if (arLabel) arLabel.textContent = 'Thought';
      }
    }
    var sec = thinkingStartTime ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1) : '0';
    var count = thinkingSteps.length;
    if (title) title.textContent = cancelled ? 'Cancelled after ' + sec + 's' : 'Completed in ' + sec + 's \u00b7 ' + count + ' step' + (count !== 1 ? 's' : '');
    if (elapsed) elapsed.textContent = '';
    setBusyMode(false);
  }
  on(D('stepsToggleBtn'), 'click', function(e) {
    e.stopPropagation();
    var panel = D('thinkingPanel'); if (!panel) return;
    stepsCollapsed = !stepsCollapsed;
    panel.classList.toggle('steps-collapsed', stepsCollapsed);
  });

  // Drawer toggles
  on(D('todoDrawerToggle'), 'click', function() {
    todoDrawerCollapsed = !todoDrawerCollapsed;
    if (todoDrawer) todoDrawer.classList.toggle('collapsed', todoDrawerCollapsed);
  });
  on(D('filesDrawerToggle'), 'click', function() {
    filesDrawerCollapsed = !filesDrawerCollapsed;
    if (filesDrawer) filesDrawer.classList.toggle('collapsed', filesDrawerCollapsed);
  });

  // MCP utils
  function normalizeMcpServer(s) {
    var t = String(s && s.transport || 'stdio');
    var args = [];
    if (Array.isArray(s && s.args)) args = s.args.map(String);
    else if (typeof (s && s.args) === 'string') args = s.args.split(/\\r?\\n/).map(function(a) { return a.trim(); }).filter(Boolean);
    return { id: String(s && s.id || ''), enabled: s && s.enabled !== false, trust: String(s && s.trust || 'workspace'), transport: t, command: String(s && s.command || ''), url: String(s && s.url || ''), args: args };
  }
  function parseArgs(text) {
    var raw = String(text || '').trim(); if (!raw) return [];
    if (raw.charAt(0) === '[') { var p = JSON.parse(raw); if (!Array.isArray(p)) throw new Error('Args must be JSON array'); return p.map(String); }
    return raw.split(/\\r?\\n/).map(function(a) { return a.trim(); }).filter(Boolean);
  }
  function renderMcpServers(list) {
    mcpServers = (list || []).map(normalizeMcpServer);
    mcpCount.textContent = mcpServers.length === 1 ? '1 configured' : mcpServers.length + ' configured';
    if (!mcpServers.length) { mcpList.innerHTML = '<div class="mcp-empty fadein">No MCP servers. Add one to connect tools.</div>'; return; }
    mcpList.innerHTML = '';
    mcpServers.forEach(function(server, idx) {
      var card = document.createElement('div'); card.className = 'mcp-card fadein'; card.dataset.index = String(idx);
      var epLabel = server.transport === 'stdio' ? 'Command' : 'URL';
      var epValue = server.transport === 'stdio' ? server.command : server.url;
      card.innerHTML = '<div class="mcp-card-head"><div class="mcp-card-title"><input type="text" data-field="id" placeholder="server-name" value="' + esc(server.id) + '" /></div><label class="mcp-chip"><input type="checkbox" data-field="enabled" ' + (server.enabled ? 'checked' : '') + '/> On</label><button type="button" class="btn danger sm" data-action="remove">Remove</button></div>' +
        '<div class="mcp-grid"><select data-field="transport"><option value="stdio">stdio</option><option value="http">http</option><option value="sse">sse</option></select><select data-field="trust"><option value="workspace">workspace</option><option value="user">user</option><option value="system">system</option></select><div class="mcp-chip">' + esc(epLabel) + '</div></div>' +
        '<input type="text" data-field="endpoint" placeholder="' + esc(epLabel) + '" value="' + esc(epValue) + '" />' +
        '<textarea data-field="args" placeholder="[\\"arg1\\", \\"arg2\\"]">' + esc((server.args || []).join('\\n')) + '</textarea>';
      var ts = card.querySelector('select[data-field="transport"]'), trs = card.querySelector('select[data-field="trust"]');
      var ep = card.querySelector('input[data-field="endpoint"]'), ar = card.querySelector('textarea[data-field="args"]');
      var en = card.querySelector('input[data-field="enabled"]');
      ts.value = server.transport; trs.value = server.trust;
      var syncEp = function() { ep.placeholder = ts.value === 'stdio' ? 'Command' : 'URL'; ar.style.display = ts.value === 'stdio' ? 'block' : 'none'; };
      ts.addEventListener('change', syncEp); syncEp();
      card._read = function() { return { id: String(card.querySelector('input[data-field="id"]').value || '').trim(), enabled: Boolean(en.checked), trust: String(trs.value || 'workspace'), transport: String(ts.value || 'stdio'), command: String(ts.value === 'stdio' ? ep.value || '' : ''), url: String(ts.value === 'stdio' ? '' : ep.value || ''), args: parseArgs(String(ar.value || '')) }; };
      card.querySelector('[data-action="remove"]').addEventListener('click', function() { var cur = snapshotMcpServers(); cur.splice(idx, 1); renderMcpServers(cur); });
      mcpList.appendChild(card);
    });
  }
  function collectMcpServers() {
    return Array.from(mcpList.querySelectorAll('.mcp-card')).map(function(c) { return typeof c._read === 'function' ? c._read() : null; }).filter(Boolean).filter(function(s) {
      if (!s.id) return false;
      if (s.transport === 'stdio' && !s.command) throw new Error('Stdio server needs a command.');
      if ((s.transport === 'http' || s.transport === 'sse') && !s.url) throw new Error('HTTP/SSE server needs a URL.');
      return true;
    });
  }
  function snapshotMcpServers() { return Array.from(mcpList.querySelectorAll('.mcp-card')).map(function(c) { return typeof c._read === 'function' ? c._read() : null; }).filter(Boolean); }

  // Navigation
  function showHome() { inChat = false; homeView.classList.remove('hidden'); chatView.classList.add('hidden'); }
  function showChat() { inChat = true; homeView.classList.add('hidden'); chatView.classList.remove('hidden'); scrollBottom(); }

  // SVG icons for message action buttons (VS Code codicon style)
  var SVG_RETRY = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>';
  var SVG_COPY = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>';
  var SVG_COPY_OK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/></svg>';
  var SVG_EDIT = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/></svg>';

  /** Maximum diff lines to render per file to avoid DOM bloat */
  var DIFF_MAX_LINES = 200;

  /** Build HTML for an array of file diffs, rendered inline in chat */
  function renderDiffCards(diffs, isAutoApplied) {
    if (!diffs || !diffs.length) return '';
    var statusLabel = isAutoApplied ? 'Applied' : 'Pending';
    var h = '<div class="diff-section">';
    h += '<div style="font-size:11px;font-weight:600;color:var(--fg2);margin-bottom:4px">' + esc(diffs.length + ' file' + (diffs.length === 1 ? '' : 's') + ' changed') + ' \u2014 <span style="color:var(--accent)">' + esc(statusLabel) + '</span></div>';
    for (var i = 0; i < diffs.length; i++) {
      var d = diffs[i];
      var fname = d.fileName || d.filePath || 'unknown';
      var badge = '';
      if (d.isNew) badge = '<span class="diff-card-new">NEW</span>';
      else if (d.isDelete) badge = '<span class="diff-card-del">DEL</span>';
      h += '<div class="diff-card" data-diff-idx="' + i + '">';
      h += '<div class="diff-card-header">';
      h += '<span class="diff-card-arrow">\u25B6</span>';
      h += '<span class="diff-card-file">' + esc(fname) + '</span>';
      h += badge;
      h += '<span class="diff-card-badge">';
      if (d.additions > 0) h += '<span class="diff-stat-add">+' + d.additions + '</span>';
      if (d.deletions > 0) h += '<span class="diff-stat-del">\u2212' + d.deletions + '</span>';
      h += '</span>';
      h += '</div>';
      h += '<div class="diff-content">';
      if (d.hunks && d.hunks.length) {
        h += '<table class="diff-table">';
        var linesRendered = 0;
        for (var hi = 0; hi < d.hunks.length && linesRendered < DIFF_MAX_LINES; hi++) {
          var hunk = d.hunks[hi];
          if (hi > 0) {
            h += '<tr class="diff-tr-sep"><td class="diff-ln" colspan="2"></td><td class="diff-code" style="color:var(--fg3);font-style:italic;padding:2px 6px">\u22EE</td></tr>';
          }
          for (var li = 0; li < hunk.lines.length && linesRendered < DIFF_MAX_LINES; li++) {
            var ln = hunk.lines[li];
            var cls = ln.type === 'add' ? 'diff-tr-add' : ln.type === 'remove' ? 'diff-tr-del' : 'diff-tr-ctx';
            var olNum = ln.oldLine != null ? String(ln.oldLine) : '';
            var nlNum = ln.newLine != null ? String(ln.newLine) : '';
            h += '<tr class="' + cls + '">';
            h += '<td class="diff-ln">' + esc(olNum) + '</td>';
            h += '<td class="diff-ln">' + esc(nlNum) + '</td>';
            h += '<td class="diff-code">' + esc(ln.content) + '</td>';
            h += '</tr>';
            linesRendered++;
          }
        }
        h += '</table>';
        if (linesRendered >= DIFF_MAX_LINES) {
          h += '<div class="diff-truncated">Diff truncated \u2014 showing first ' + DIFF_MAX_LINES + ' lines</div>';
        }
      }
      h += '</div>';
      // Per-file accept/reject buttons
      if (!isAutoApplied) {
        h += '<div class="diff-file-actions" data-diff-file="' + esc(d.filePath || fname) + '">';
        h += '<button class="btn primary xs diff-file-accept" title="Accept this file">&#10003; Accept</button>';
        h += '<button class="btn danger xs diff-file-reject" title="Reject this file">&#10007; Reject</button>';
        h += '</div>';
      }
      h += '</div>';
    }
    if (!isAutoApplied) {
      h += '<div class="diff-actions">';
      h += '<button class="btn primary sm diff-keep-btn">Keep All</button>';
      h += '<button class="btn danger sm diff-undo-btn">Discard All</button>';
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  // Render messages
  function renderMessages() {
    if (!chatHistory.length) {
      messages.innerHTML = '<div class="empty fadein"><div class="empty-icon">&#9889;</div><div class="empty-h">What can I help you build?</div><div class="empty-p">Describe a task, ask a question, or paste code to get started</div></div>';
      scheduleScrollButtonUpdate();
      return;
    }
    messages.innerHTML = '';
    for (var i = 0; i < chatHistory.length; i++) {
      var m = chatHistory[i];
      if (!m.id) m.id = makeMessageId();
      var div = document.createElement('div');
      var role = m.role === 'assistant' ? 'agent' : m.role;
      div.className = 'msg ' + role + ' fadein';
      div.dataset.messageId = String(m.id || '');
      div.dataset.messageIndex = String(i);

      // Terminal blocks render as special expandable elements
      if (m.role === 'terminal' && m.isHtml) {
        div.innerHTML = m.text || '';
        // Add toggle handler for terminal blocks
        var termHeader = div.querySelector('.terminal-chat-header');
        if (termHeader) {
          termHeader.addEventListener('click', function(e) {
            e.stopPropagation();
            var block = this.parentElement;
            if (block) {
              var output = block.querySelector('.terminal-chat-output');
              if (output) output.classList.toggle('hidden');
              block.classList.toggle('open');
            }
          });
        }
        messages.appendChild(div);
        continue;
      }

      if (composeState.mode === 'edit' && String(m.id || '') === String(composeState.messageId || '')) {
        div.classList.add('editing');
      }
      var text = m.text || m.content || '';
      var html = renderMarkdown(text);
      // Append inline diff cards when available
      if (m.fileDiffs && m.fileDiffs.length > 0) {
        html += renderDiffCards(m.fileDiffs, m.autoApplied);
      }
      var rawTs = m.ts || m.createdAt || null;
      var ts = rawTs ? relTime(new Date(rawTs).toISOString()) : '';
      var footerActions = role === 'agent'
        ? '<button class="retry-btn" title="Retry">' + SVG_RETRY + '</button><button class="copy-btn" title="Copy message">' + SVG_COPY + '</button>'
        : '<button class="retry-btn edit-btn" title="Edit message">' + SVG_EDIT + '</button><button class="copy-btn" title="Copy message">' + SVG_COPY + '</button>';
      div.innerHTML = '<div class="bubble">' + html + '</div>' +
        '<div class="msg-footer">' +
        '<span class="msg-time">' + esc(ts) + '</span>' +
        '<div style="display:flex;gap:2px;align-items:center">' + footerActions + '</div>' +
        '</div>';
      (function(t, el, msgRole) {
        el.querySelector('.copy-btn').addEventListener('click', function(e) {
          e.stopPropagation();
          var target = e.currentTarget;
          navigator.clipboard.writeText(t).then(function() {
            target.innerHTML = SVG_COPY_OK;
            setTimeout(function() { target.innerHTML = SVG_COPY; }, 1400);
          });
        });
        if (msgRole === 'user') {
          var editBtn = el.querySelector('.edit-btn');
          if (editBtn) editBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            beginEditMessage(String(el.dataset.messageId || ''), Number(el.dataset.messageIndex || -1));
          });
          el.addEventListener('dblclick', function(e) {
            e.stopPropagation();
            beginEditMessage(String(el.dataset.messageId || ''), Number(el.dataset.messageIndex || -1));
          });
        }
        if (msgRole === 'agent') {
          var retryBtn = el.querySelector('.retry-btn');
          if (retryBtn) retryBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (isBusy) return;
            beginRetryMessage(String(el.dataset.messageId || ''), Number(el.dataset.messageIndex || -1));
          });
          // Diff card toggle handlers
          var diffHeaders = el.querySelectorAll('.diff-card-header');
          for (var dh = 0; dh < diffHeaders.length; dh++) {
            diffHeaders[dh].addEventListener('click', function(e) {
              e.stopPropagation();
              var card = this.parentElement;
              if (card) card.classList.toggle('open');
            });
          }
          // Diff Keep / Discard buttons
          var keepBtn = el.querySelector('.diff-keep-btn');
          if (keepBtn) keepBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            vscode.postMessage({ type: 'applyPending', payload: true });
            var sec = el.querySelector('.diff-actions');
            if (sec) sec.innerHTML = '<span style="font-size:11px;color:var(--green);font-weight:600">\u2713 Applied</span>';
          });
          var discardBtn = el.querySelector('.diff-undo-btn');
          if (discardBtn) discardBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            vscode.postMessage({ type: 'revertLast', payload: true });
            var sec = el.querySelector('.diff-actions');
            if (sec) sec.innerHTML = '<span style="font-size:11px;color:var(--red);font-weight:600">\u2717 Discarded</span>';
          });
          // Per-file accept/reject buttons
          var fileAcceptBtns = el.querySelectorAll('.diff-file-accept');
          for (var fa = 0; fa < fileAcceptBtns.length; fa++) {
            fileAcceptBtns[fa].addEventListener('click', function(e) {
              e.stopPropagation();
              var actionsDiv = this.parentElement;
              var filePath = actionsDiv ? actionsDiv.dataset.diffFile : '';
              if (filePath) {
                vscode.postMessage({ type: 'acceptFile', payload: filePath });
                if (actionsDiv) actionsDiv.innerHTML = '<span style="font-size:10px;color:var(--green);font-weight:600">\u2713 Accepted</span>';
              }
            });
          }
          var fileRejectBtns = el.querySelectorAll('.diff-file-reject');
          for (var fr = 0; fr < fileRejectBtns.length; fr++) {
            fileRejectBtns[fr].addEventListener('click', function(e) {
              e.stopPropagation();
              var actionsDiv = this.parentElement;
              var filePath = actionsDiv ? actionsDiv.dataset.diffFile : '';
              if (filePath) {
                vscode.postMessage({ type: 'rejectFile', payload: filePath });
                if (actionsDiv) actionsDiv.innerHTML = '<span style="font-size:10px;color:var(--red);font-weight:600">\u2717 Rejected</span>';
              }
            });
          }
        }
      })(text, div, role);
      messages.appendChild(div);
    }
    scheduleScrollButtonUpdate();
  }

  function renderAttachments(files) {
    attachedFiles = Array.isArray(files) ? files.slice() : [];
    if (!attachmentRow) return;
    if (!attachedFiles.length && !attachmentRow.querySelector('.img-preview')) { attachmentRow.innerHTML = ''; return; }
    var html = '<span class="attachment-label">Attached</span>' +
      attachedFiles.map(function(f) { return '<span class="chip" title="' + esc(f) + '">' + esc(f.split(/[\\\\/]/).pop()) + '</span>'; }).join('');
    // Preserve existing image previews
    var existing = attachmentRow.querySelectorAll('.img-preview');
    attachmentRow.innerHTML = html;
    for (var p = 0; p < existing.length; p++) {
      attachmentRow.appendChild(existing[p]);
    }
  }

  function addImagePreview(name, dataUrl) {
    if (!attachmentRow) return;
    // Show the label if not present
    if (!attachmentRow.querySelector('.attachment-label')) {
      var label = document.createElement('span');
      label.className = 'attachment-label';
      label.textContent = 'Attached';
      attachmentRow.insertBefore(label, attachmentRow.firstChild);
    }
    var wrap = document.createElement('span');
    wrap.className = 'img-preview';
    wrap.title = name;
    wrap.innerHTML = '<img src="' + dataUrl + '" class="img-thumb" /><span class="img-name">' + esc(name) + '</span><button class="img-remove" title="Remove">&times;</button>';
    wrap.querySelector('.img-remove').addEventListener('click', function(e) {
      e.stopPropagation();
      wrap.parentNode.removeChild(wrap);
      vscode.postMessage({ type: 'removeImage', payload: name });
    });
    attachmentRow.appendChild(wrap);
  }

  function renderSessions(list) {
    list = list || [];
    if (!list.length) { sessionList.innerHTML = '<div class="empty"><div class="empty-icon">&#128172;</div><div class="empty-h">No conversations yet</div><div class="empty-p">Start typing below to begin your first session</div></div>'; return; }
    sessionList.innerHTML = '';
    var VISIBLE_LIMIT = 4;
    var visibleCount = Math.min(list.length, VISIBLE_LIMIT);
    for (var i = 0; i < visibleCount; i++) {
      (function(s) {
        var d = document.createElement('div'); d.className = 'sitem'; d.dataset.sessionId = String(s.id || '');
        d.innerHTML = '<span class="sitem-title">' + esc(s.title || s.id) + '</span><div class="session-actions"><div class="session-meta"><span class="sitem-time">' + esc(relTime(s.updatedAt)) + '</span><span class="session-count">' + esc(String(s.messageCount || 0)) + ' msgs</span></div><button type="button" class="session-delete" title="Delete">&#128465;</button></div>';
        d.addEventListener('click', function() { if (s.id) vscode.postMessage({ type: 'openSession', payload: s.id }); });
        d.querySelector('.session-delete').addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); vscode.postMessage({ type: 'deleteSessionRequest', payload: s.id }); });
        sessionList.appendChild(d);
      })(list[i]);
    }
    if (list.length > VISIBLE_LIMIT) {
      var remaining = list.length - VISIBLE_LIMIT;
      var loadMore = document.createElement('button');
      loadMore.className = 'load-more-btn';
      loadMore.textContent = 'Load more (' + remaining + ')';
      loadMore.addEventListener('click', function() {
        loadMore.remove();
        for (var j = VISIBLE_LIMIT; j < list.length; j++) {
          (function(s) {
            var d = document.createElement('div'); d.className = 'sitem fadein'; d.dataset.sessionId = String(s.id || '');
            d.innerHTML = '<span class="sitem-title">' + esc(s.title || s.id) + '</span><div class="session-actions"><div class="session-meta"><span class="sitem-time">' + esc(relTime(s.updatedAt)) + '</span><span class="session-count">' + esc(String(s.messageCount || 0)) + ' msgs</span></div><button type="button" class="session-delete" title="Delete">&#128465;</button></div>';
            d.addEventListener('click', function() { if (s.id) vscode.postMessage({ type: 'openSession', payload: s.id }); });
            d.querySelector('.session-delete').addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); vscode.postMessage({ type: 'deleteSessionRequest', payload: s.id }); });
            sessionList.appendChild(d);
          })(list[j]);
        }
      });
      sessionList.appendChild(loadMore);
    }
  }

  function renderLoadedSession(session) {
    if (!session) return;
    pendingRequest = null;
    resetComposeState();
    resetDrawers();
    resetThinkingPanel();
    resetBannerBtns();
    if (editsBanner) editsBanner.classList.remove('on');
    if (bannerTxt) bannerTxt.textContent = 'Pending edits ready';
    attachedFiles = session.attachedFiles || [];
    renderAttachments(attachedFiles);
    if (Array.isArray(session.messages) && session.messages.length > 0) {
      chatHistory = session.messages.map(function(m) { return { id: m.id || makeMessageId(), role: m.role, text: m.content, ts: m.createdAt }; });
    } else {
      chatHistory = [{ id: makeMessageId(), role: 'user', text: session.objective || session.title || 'Session', ts: session.updatedAt || Date.now() }];
      if (session.lastResult) chatHistory.push({ id: makeMessageId(), role: 'assistant', text: session.lastResult, ts: session.updatedAt || Date.now() });
    }
    renderMessages(); showChat();
  }

  function handleSessionDeleted(payload) {
    if (payload && payload.wasActive) { chatHistory = []; attachedFiles = []; resetComposeState(); resetDrawers(); resetThinkingPanel(); resetBannerBtns(); if (editsBanner) editsBanner.classList.remove('on'); if (bannerTxt) bannerTxt.textContent = 'Pending edits ready'; renderAttachments(attachedFiles); renderMessages(); showHome(); }
  }

  // Render summary
  function renderSummary(s) {
    summary = s;
    var ok = s && (Boolean(s.ollamaReachable) || s.status === 'ready');
    statusBadge.className = 'badge ' + (ok ? 'on' : 'off');
    statusTxt.textContent = ok ? 'Online' : 'Offline';
    renderConversationMode((s && s.conversationMode) || 'agent');
    if (s && s.permissionMode) updatePermUI(s.permissionMode);
    if (s && s.persona && personaSelect) personaSelect.value = s.persona;
    if (s && typeof s.selfLearnEnabled === 'boolean' && selfLearnToggle) selfLearnToggle.checked = s.selfLearnEnabled;
    var model = (s && s.plannerModel) || '';
    activeModelName = model;
    chipModel.textContent = model.split(':')[0].slice(0, 14) || '\u2013';
    chipModel.title = model || 'none';
    var hasPending = s && s.hasPendingEdits;
    editsBanner.classList.toggle('on', Boolean(hasPending));
    if (hasPending) {
      var eCount = s && typeof s.pendingEditCount === 'number' ? s.pendingEditCount : 0;
      bannerTxt.textContent = eCount > 0 ? eCount + ' file' + (eCount === 1 ? '' : 's') + ' changed \u2014 review before approving' : 'Pending file edits \u2014 review before approving';
    }
    if (learningBadge) {
      var learningPct = s && typeof s.learningProgressPercent === 'number' ? s.learningProgressPercent : 0;
      learningBadge.textContent = 'Learning ' + Math.max(0, Math.min(100, Math.round(learningPct))) + '%';
      learningBadge.title = 'Self-improvement progress from recent tasks';
      learningBadge.style.display = learningPct > 0 ? '' : 'none';
    }
    if (s && typeof s.tokenUsagePercent === 'number') updateTokenRing(s.tokenUsagePercent);
    if (s && s.activeSessionId && !inChat && !autoRestoreSessionAttempted) {
      autoRestoreSessionAttempted = true;
      vscode.postMessage({ type: 'openSession', payload: s.activeSessionId });
    }
  }

  // Token ring
  function updateTokenRing(pct) {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    var ring = D('tokenRing'), arc = D('tokenRingArc'), label = D('tokenRingPct');
    if (ring) ring.classList.toggle('visible', pct > 0);
    if (arc) arc.setAttribute('stroke-dasharray', pct + ' ' + (100 - pct));
    if (label) label.textContent = pct + '%';
  }

  function updateModels(list) {
    models = list || [];
    var prev = modelSelect.value;
    modelSelect.innerHTML = '';
    if (!models.length) { modelSelect.innerHTML = '<option value="">No models found</option>'; return; }
    for (var i = 0; i < models.length; i++) {
      var model = models[i];
      var o = document.createElement('option');
      o.value = model.name;
      o.text = describeModelOption(model);
      o.title = describeModelTooltip(model);
      modelSelect.appendChild(o);
    }
    if (models.some(function(m) { return m.name === prev; })) modelSelect.value = prev;
  }

  function describeModelOption(model) {
    if (!model || !model.name) return '';
    var labels = ['Ready', sourceLabelForModel(model)];
    if (model.supportsVision) labels.push('Vision');
    return model.name + ' — ' + labels.join(' · ');
  }

  // Send task
  var sendArrowSvg = '<svg class="send-arrow" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';

  function setBusyMode(busy) {
    isBusy = busy;
    if (busy) {
      btnSend.disabled = false;
      btnSend.classList.add('stop');
      btnSend.title = 'Stop';
      btnSend.innerHTML = '&#9632;';
    } else {
      btnSend.classList.remove('stop');
      btnSend.title = composeState.mode === 'edit' ? 'Save & Send' : composeState.mode === 'retry' ? 'Retry' : 'Send (Enter)';
      btnSend.innerHTML = sendArrowSvg;
      btnSend.disabled = taskInput ? taskInput.value.trim().length === 0 : true;
    }
  }

  function sendTask() {
    if (isBusy) {
      vscode.postMessage({ type: 'cancelTask' });
      setBusyMode(false);
      finishThinking();
      return;
    }
    var text = taskInput.value.trim();
    if (!text) return;
    var action = composeState.mode || 'new';
    var messageId = composeState.messageId || '';
    var messageIndex = composeState.messageIndex;

    if (action === 'edit' && messageId) {
      if (messageIndex < 0 || !chatHistory[messageIndex] || String(chatHistory[messageIndex].id || '') !== messageId) {
        messageIndex = -1;
        for (var j = chatHistory.length - 1; j >= 0; j--) {
          if (String(chatHistory[j].id || '') === messageId) { messageIndex = j; break; }
        }
      }
      if (messageIndex >= 0) {
        chatHistory[messageIndex].text = text;
        chatHistory[messageIndex].content = text;
        chatHistory = chatHistory.slice(0, messageIndex + 1);
      }
      renderMessages();
    }

    taskInput.value = ''; taskInput.style.height = 'auto';
    setBusyMode(true);
    pendingRequest = { action: action, messageId: messageId };
    if (action === 'new') {
      chatHistory.push({ id: makeMessageId(), role: 'user', text: text, ts: Date.now() });
      renderMessages();
    }
    showChat(); startThinking(); resetDrawers(); scrollBottom();
    vscode.postMessage({ type: 'runTask', payload: { objective: text, action: action, messageId: messageId } });
    // Clear image previews after sending
    if (attachmentRow) {
      var imgPreviews = attachmentRow.querySelectorAll('.img-preview');
      for (var ip = 0; ip < imgPreviews.length; ip++) imgPreviews[ip].parentNode.removeChild(imgPreviews[ip]);
    }
    resetComposeState();
  }

  // Event listeners
  on(taskInput, 'input', function() { autoGrow(taskInput); if (!isBusy) btnSend.disabled = taskInput.value.trim().length === 0; });
  on(taskInput, 'keydown', function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTask(); } });
  on(btnSend, 'click', sendTask);

  // Scroll-to-bottom button
  (function() {
    var mainEl = D('main');
    if (mainEl) mainEl.addEventListener('scroll', function() {
      updateScrollButton();
    });
    on(scrollBtn, 'click', scrollBottom);
  }());

  // Code-copy event delegation (persistent)
  on(messages, 'click', function(e) {
    var btn = e.target;
    if (!btn || !btn.classList || !btn.classList.contains('code-copy')) return;
    e.stopPropagation();
    var header = btn.parentNode;
    var block = header && header.nextElementSibling;
    if (block && block.tagName === 'PRE') {
      navigator.clipboard.writeText(block.textContent || '').then(function() {
        var prev = btn.textContent;
        btn.textContent = '\u2713 Copied';
        setTimeout(function() { btn.textContent = prev; }, 1500);
      });
    }
  });

  // Self-learn toggle
  on(selfLearnToggle, 'change', function() { vscode.postMessage({ type: 'setSelfLearn', payload: selfLearnToggle.checked }); });

  // ── Drag-and-drop file attach ─────────────────────────────────
  (function() {
    var dropOverlay = D('dropOverlay');
    if (!dropOverlay) return;
    var dragCounter = 0;
    document.addEventListener('dragenter', function(e) {
      e.preventDefault();
      dragCounter++;
      if (dragCounter === 1) dropOverlay.classList.add('active');
    });
    document.addEventListener('dragleave', function(e) {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('active'); }
    });
    document.addEventListener('dragover', function(e) { e.preventDefault(); });
    document.addEventListener('drop', function(e) {
      e.preventDefault();
      dragCounter = 0;
      dropOverlay.classList.remove('active');
      var items = e.dataTransfer && e.dataTransfer.items;
      if (!items || !items.length) return;
      var paths = [];
      var imageFiles = [];
      var uriList = (e.dataTransfer && e.dataTransfer.getData('text/uri-list')) || '';
      if (uriList && uriList.trim()) {
        uriList.split(/\\r?\\n/).forEach(function(line) {
          var value = line.trim();
          if (value && value.charAt(0) !== '#') paths.push(value);
        });
      }
      var plainText = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
      if (plainText && plainText.trim()) {
        plainText.split(/\\r?\\n/).forEach(function(line) {
          var value = line.trim();
          if (value && value.indexOf('file:') === 0) paths.push(value);
        });
      }
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.kind === 'file') {
          var file = item.getAsFile();
          if (file && file.name) {
            var ext = (file.name.split('.').pop() || '').toLowerCase();
            var isImage = ['png','jpg','jpeg','gif','webp','bmp','svg'].indexOf(ext) !== -1;
            if (isImage && file.size < 10 * 1024 * 1024) {
              // Read image as base64 for vision model support
              imageFiles.push(file);
            } else {
              paths.push((file && file.path) ? file.path : file.name);
            }
          }
        } else if (item.kind === 'string' && (item.type === 'text/plain' || item.type === 'text/uri-list')) {
          item.getAsString(function(s) {
            if (s && s.trim()) {
              s.split(/\\r?\\n/).forEach(function(line) {
                var value = line.trim();
                if (value && value.charAt(0) !== '#') {
                  vscode.postMessage({ type: 'dropFiles', payload: [value] });
                }
              });
            }
          });
        }
      }
      if (paths.length > 0) vscode.postMessage({ type: 'dropFiles', payload: paths });
      // Read and preview image files
      imageFiles.forEach(function(imgFile) {
        var reader = new FileReader();
        reader.onload = function(ev) {
          var dataUrl = ev.target && ev.target.result;
          if (typeof dataUrl === 'string') {
            // Show preview in attachment row
            addImagePreview(imgFile.name, dataUrl);
            // Send to backend
            vscode.postMessage({ type: 'dropImage', payload: { name: imgFile.name, dataUrl: dataUrl } });
          }
        };
        reader.readAsDataURL(imgFile);
      });
    });
  }());

  // ── Tool configuration panel ──────────────────────────────────
  var TOOL_DEFS = [
    { id: 'workspace_scan', name: 'Workspace Scan', desc: 'Discover project files and structure' },
    { id: 'read_files', name: 'Read Files', desc: 'Read source file contents for context' },
    { id: 'create_file', name: 'Create File', desc: 'Create new files in the workspace' },
    { id: 'delete_file', name: 'Delete File', desc: 'Remove files from the workspace' },
    { id: 'search_files', name: 'Search Files', desc: 'Regex search across workspace files' },
    { id: 'list_dir', name: 'List Directory', desc: 'List contents of a directory' },
    { id: 'run_terminal', name: 'Terminal', desc: 'Run shell commands (build, test, install)' },
    { id: 'run_verification', name: 'Verification', desc: 'Run diagnostics and linting checks' },
    { id: 'web_search', name: 'Web Search', desc: 'Search the internet for documentation' },
    { id: 'git_diff', name: 'Git Diff', desc: 'View source control changes' },
    { id: 'mcp_status', name: 'MCP Status', desc: 'Check MCP server health' },
    { id: 'diagnostics', name: 'Diagnostics', desc: 'Retrieve active editor diagnostics' },
    { id: 'batch_edit', name: 'Batch Edit', desc: 'Apply targeted changes to multiple files at once' },
    { id: 'rename_file', name: 'Rename/Move', desc: 'Rename or move files in the workspace' },
    { id: 'find_references', name: 'Find References', desc: 'Find all usages of a symbol across the workspace' },
    { id: 'file_search', name: 'File Search', desc: 'Find files by name or glob pattern' },
    { id: 'get_problems', name: 'Problems', desc: 'Get VS Code diagnostics and errors' },
    { id: 'get_terminal_output', name: 'Terminal Output', desc: 'Get the last terminal command output' }
  ];
  var enabledTools = {};
  TOOL_DEFS.forEach(function(t) { enabledTools[t.id] = true; });

  function renderToolConfig() {
    var list = D('toolConfigList');
    if (!list) return;
    list.innerHTML = TOOL_DEFS.map(function(t) {
      var checked = enabledTools[t.id] !== false ? ' checked' : '';
      return '<div class="tool-config-item"><label><input type="checkbox" data-tool="' + esc(t.id) + '"' + checked + ' />' + esc(t.name) + '</label></div><div class="tool-config-desc">' + esc(t.desc) + '</div>';
    }).join('');
    list.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
      cb.addEventListener('change', function() {
        enabledTools[cb.dataset.tool] = cb.checked;
        vscode.postMessage({ type: 'setEnabledTools', payload: enabledTools });
      });
    });
  }
  renderToolConfig();
  on(D('btnToolsAll'), 'click', function() { TOOL_DEFS.forEach(function(t) { enabledTools[t.id] = true; }); renderToolConfig(); vscode.postMessage({ type: 'setEnabledTools', payload: enabledTools }); });
  on(D('btnToolsNone'), 'click', function() { TOOL_DEFS.forEach(function(t) { enabledTools[t.id] = false; }); renderToolConfig(); vscode.postMessage({ type: 'setEnabledTools', payload: enabledTools }); });

  on(btnNewChat, 'click', function() { autoRestoreSessionAttempted = true; chatHistory = []; attachedFiles = []; pendingRequest = null; resetComposeState(); resetDrawers(); resetThinkingPanel(); resetBannerBtns(); if (editsBanner) editsBanner.classList.remove('on'); if (bannerTxt) bannerTxt.textContent = 'Pending edits ready'; renderAttachments(attachedFiles); renderMessages(); showChat(); vscode.postMessage({ type: 'newConversation' }); taskInput.focus(); });
  on(btnBack, 'click', showHome);
  on(btnAttach, 'click', function() { vscode.postMessage({ type: 'attachContext' }); });
  on(btnSettings, 'click', function() { settingsDrawer.classList.toggle('open'); });
  on(btnRefresh, 'click', function() { vscode.postMessage({ type: 'ping' }); });

  on(chipMode, 'click', function(e) { e.stopPropagation(); modePopupOpen ? closeModePopup() : openModePopup(); });
  (function() { var p = D('modePopup'); if (!p) return; p.querySelectorAll('.popup-opt').forEach(function(btn) { btn.addEventListener('click', function(e) { e.stopPropagation(); var m = btn.dataset.mode; if (m && m !== conversationMode) vscode.postMessage({ type: 'setConversationMode', payload: m }); closeModePopup(); }); }); }());
  on(chipModel, 'click', function(e) { e.stopPropagation(); modelPopupOpen ? closeModelPopup() : openModelPopup(); });

  // Permission bar
  on(permBtn, 'click', function(e) { e.stopPropagation(); permPopupOpen ? closePermPopup() : openPermPopup(); });
  (function() { var p = D('permPopup'); if (!p) return; p.querySelectorAll('.perm-opt').forEach(function(btn) { btn.addEventListener('click', function(e) { e.stopPropagation(); var m = btn.dataset.perm; if (m) { vscode.postMessage({ type: 'setPermissionMode', payload: m }); updatePermUI(m); } closePermPopup(); }); }); }());

  on(btnSyncModels, 'click', function() { vscode.postMessage({ type: 'refreshModels' }); });
  on(btnApplyModel, 'click', function() { var m = modelSelect.value; if (m) { vscode.postMessage({ type: 'setModel', payload: { role: 'planner', model: m } }); vscode.postMessage({ type: 'setModel', payload: { role: 'editor', model: m } }); vscode.postMessage({ type: 'setModel', payload: { role: 'fast', model: m } }); } });
  on(personaSelect, 'change', function() { vscode.postMessage({ type: 'setPersona', payload: personaSelect.value }); });
  on(btnAddMcp, 'click', function() { mcpServers = snapshotMcpServers().concat([normalizeMcpServer({ enabled: true, trust: 'workspace', transport: 'stdio', args: [] })]); renderMcpServers(mcpServers); });
  on(btnReloadMcp, 'click', function() { vscode.postMessage({ type: 'reloadMcpServers' }); });
  on(btnOpenMcpSettings, 'click', function() { vscode.postMessage({ type: 'configureMcpServers' }); });
  on(btnManageMcp, 'click', function() { vscode.postMessage({ type: 'manageMcpConnections' }); });
  on(btnSaveMcp, 'click', function() { try { vscode.postMessage({ type: 'saveMcpServers', payload: collectMcpServers() }); } catch(e) {} });

  // Edits banner
  function resetBannerBtns() { btnApply.textContent = 'Approve'; btnApply.className = 'btn primary sm'; btnRevert.textContent = 'Reject'; btnRevert.className = 'btn danger sm'; }
  on(btnApply, 'click', function() { resetBannerBtns(); vscode.postMessage({ type: 'applyPending', payload: true }); });
  on(btnRevert, 'click', function() { resetBannerBtns(); vscode.postMessage({ type: 'revertLast', payload: true }); });

  // Message handler
  window.addEventListener('message', function(event) {
    var data = event.data || {}, type = data.type, payload = data.payload;
    if (type === 'runtimeSummary') { renderSummary(payload); return; }
    if (type === 'models') { updateModels(payload); return; }
    if (type === 'mcpServers') { renderMcpServers(payload); return; }
    if (type === 'sessions') { renderSessions(payload); return; }
    if (type === 'sessionLoaded') { renderLoadedSession(payload); return; }
    if (type === 'sessionDeleted') { handleSessionDeleted(payload); return; }
    if (type === 'sessionAttachments') { renderAttachments(payload); return; }
    if (type === 'thinkingStep') { addThinkingStep(payload); return; }
    if (type === 'terminalOutput') {
      // Render terminal output as an expandable block in chat
      if (payload && typeof payload.command === 'string') {
        var termId = makeMessageId();
        var exitOk = payload.exitCode === 0;
        var termHtml = '<div class="terminal-chat-block' + (exitOk ? '' : ' terminal-error') + '">' +
          '<div class="terminal-chat-header" data-termid="' + esc(termId) + '">' +
          '<span class="terminal-chat-icon">&#9654;</span>' +
          '<span class="terminal-chat-cmd">$ ' + esc(payload.command) + '</span>' +
          '<span class="terminal-chat-status">' + (exitOk ? '\\u2713' : '\\u2717 exit ' + (payload.exitCode != null ? payload.exitCode : '?')) + '</span>' +
          '<span class="terminal-chat-toggle">\\u25BC</span>' +
          '</div>' +
          '<pre class="terminal-chat-output hidden">' + esc(payload.output || '(no output)') + '</pre>' +
          '</div>';
        chatHistory.push({ id: termId, role: 'terminal', text: termHtml, ts: Date.now(), isHtml: true });
        renderMessages(); scrollBottom();
      }
      return;
    }
    if (type === 'streamChunk') {
      if (!isBusy) return;
      streamBuffer += (payload || '');
      if (!streamBubble) {
        // Create streaming bubble with placeholder skeleton
        streamBubble = document.createElement('div');
        streamBubble.className = 'msg agent fadein streaming-active';
        streamBubble.innerHTML = '<div class="bubble stream-bubble">' +
          '<div class="stream-placeholder">' +
          '<div class="stream-placeholder-line"></div>' +
          '<div class="stream-placeholder-line"></div>' +
          '<div class="stream-placeholder-line"></div>' +
          '</div>' +
          '<span class="stream-text" style="display:none"></span>' +
          '<span class="stream-cursor" style="display:none"></span></div>';
        messages.appendChild(streamBubble);
        streamRenderBuffer = '';
      }
      // Queue chunk for smooth rendering
      streamChunkQueue.push(payload || '');
      if (!streamFlushTimer) {
        streamFlushTimer = setInterval(function() {
          if (streamChunkQueue.length === 0) {
            clearInterval(streamFlushTimer);
            streamFlushTimer = null;
            return;
          }
          // Flush queued chunks with slight smoothing
          var chunk = streamChunkQueue.shift();
          streamRenderBuffer += chunk;
          if (streamBubble) {
            // Remove placeholder once text starts flowing
            var ph = streamBubble.querySelector('.stream-placeholder');
            if (ph) ph.parentNode.removeChild(ph);
            var textEl = streamBubble.querySelector('.stream-text');
            var cursor = streamBubble.querySelector('.stream-cursor');
            if (textEl) { textEl.style.display = 'inline'; textEl.innerHTML = renderMarkdown(streamRenderBuffer); }
            if (cursor) cursor.style.display = 'inline-block';
          }
          scrollBottom();
        }, 18); // ~18ms between renders for premium smoothness
      }
      return;
    }
    if (type === 'taskResult') {
      var isCancelled = payload && payload.cancelled;
      // Flush remaining chunks immediately
      if (streamFlushTimer) { clearInterval(streamFlushTimer); streamFlushTimer = null; }
      streamChunkQueue = [];
      streamRenderBuffer = '';
      // Remove temporary streaming bubble
      if (streamBubble && streamBubble.parentNode) {
        streamBubble.parentNode.removeChild(streamBubble);
      }
      streamBubble = null;
      streamBuffer = '';
      finishThinking(isCancelled);
      if (!isCancelled) {
        // Update drawers with final state
        if (payload && payload.todos && payload.todos.length) renderTodoDrawer(payload.todos);
        if (payload && payload.fileDiffs && payload.fileDiffs.length) renderFilesDrawer(payload.fileDiffs);

        var text = (payload && payload.responseText) || 'Task completed.';
        // Clean response: strip raw JSON wrappers that models sometimes emit
        // Handle single JSON object or multiple concatenated JSON objects
        if (text && (text.charAt(0) === '{' || text.charAt(0) === '[')) {
          try {
            var parsed = JSON.parse(text);
            if (parsed && typeof parsed.response === 'string' && parsed.response.length > 0) { text = parsed.response; }
            else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              if (parsed.summary) text = String(parsed.summary);
              else if (parsed.text) text = String(parsed.text);
            }
          } catch(e) {
            // May be multiple concatenated JSON objects — extract .response from each
            var jsonParts = text.match(/\\{[^{}]*(?:\\{[^{}]*\\}[^{}]*)*\\}/g);
            if (jsonParts && jsonParts.length > 0) {
              var extracted = [];
              for (var jp = 0; jp < jsonParts.length; jp++) {
                try {
                  var p = JSON.parse(jsonParts[jp]);
                  if (p && typeof p.response === 'string' && p.response.length > 0) extracted.push(p.response);
                } catch(e2) {}
              }
              if (extracted.length > 0) text = extracted[extracted.length - 1];
            }
          }
        }
        // Strip markdown sections that duplicate drawer data
        text = text.replace(/##\\s*(TODOs?|Tasks?|What I found|What changed|Verification|Changes made|Files? changed)[\\s\\S]*?(?=\\n##|$)/gi, '');
        // Strip <break> tags
        text = text.replace(/<break\\s*\\/?>/gi, '\\n').replace(/<\\/break>/gi, '\\n');
        // Remove leading/trailing whitespace artifacts
        text = text.trim();
        // If text became empty after cleanup, use fallback
        if (!text) text = 'Task completed.';
        if (payload && payload.autoApplied && payload.proposedEdits > 0) {
          text += '\\n\\n\\u2705 **' + payload.proposedEdits + ' edit(s) auto-applied** (bypass mode active)';
        }
        // Update banner text with actual file count when pending edits exist
        if (payload && payload.proposedEdits > 0 && !payload.autoApplied) {
          var fc = payload.proposedEdits;
          bannerTxt.textContent = fc + ' file' + (fc === 1 ? '' : 's') + ' changed \u2014 review before applying';
        }
        var diffData = (payload && payload.fileDiffs && payload.fileDiffs.length > 0) ? payload.fileDiffs : null;
        var wasAutoApplied = Boolean(payload && payload.autoApplied);
        var shouldReplaceAgent = pendingRequest && pendingRequest.action === 'retry' && pendingRequest.messageId;
        if (shouldReplaceAgent) {
          var replaced = false;
          for (var k = chatHistory.length - 1; k >= 0; k--) {
            if (String(chatHistory[k].id || '') === String(pendingRequest.messageId)) {
              chatHistory[k].text = text;
              chatHistory[k].content = text;
              chatHistory[k].ts = Date.now();
              chatHistory[k].role = 'assistant';
              chatHistory[k].fileDiffs = diffData;
              chatHistory[k].autoApplied = wasAutoApplied;
              replaced = true;
              break;
            }
          }
          if (!replaced) {
            chatHistory.push({ id: makeMessageId(), role: 'agent', text: text, ts: Date.now(), fileDiffs: diffData, autoApplied: wasAutoApplied });
          }
        } else {
          chatHistory.push({ id: makeMessageId(), role: 'agent', text: text, ts: Date.now(), fileDiffs: diffData, autoApplied: wasAutoApplied });
        }
        renderMessages(); scrollBottom();
      }
      pendingRequest = null;
      vscode.postMessage({ type: 'ping' });
      return;
    }
    if (type === 'actionResult') {
      finishThinking(false);
      var txt = String(payload || '');
      if (txt && txt.indexOf('Approval mode set') !== 0 && txt.indexOf('Permission mode set') !== 0 && txt.indexOf('Updated ') !== 0 && txt.indexOf('Mode set to') !== 0 && txt.indexOf('MCP servers updated') !== 0) {
        chatHistory.push({ id: makeMessageId(), role: 'agent', text: txt, ts: Date.now() });
        renderMessages(); scrollBottom();
      }
      pendingRequest = null;
      vscode.postMessage({ type: 'ping' });
      return;
    }
  });

  // Bootstrap
  if (initialSummary) renderSummary(initialSummary);
  window.addEventListener('error', function(e) { surfaceFatalError(e && e.error ? String(e.error.stack || e.error.message || e.error) : String(e.message || 'Unknown error')); });
  window.addEventListener('unhandledrejection', function(e) { surfaceFatalError(String(e && e.reason ? (e.reason.stack || e.reason.message || e.reason) : 'Unhandled rejection')); });
  vscode.postMessage({ type: 'webviewReady' });
  vscode.postMessage({ type: 'loadDashboard' });
  setTimeout(function() { if (!summary) vscode.postMessage({ type: 'ping' }); }, 800);
  setTimeout(function() { if (!summary) vscode.postMessage({ type: 'ping' }); }, 3000);
  setInterval(function() { vscode.postMessage({ type: 'ping' }); }, 30000);

  // Auto-focus the textarea when the webview gains focus (fixes VS Code sidebar focus)
  window.addEventListener('focus', function() {
    if (taskInput && !isBusy) { setTimeout(function() { taskInput.focus(); }, 0); }
  });
  // Give initial focus so user can type immediately
  setTimeout(function() { if (taskInput) taskInput.focus(); }, 200);

  } catch (error) {
    surfaceFatalError(error instanceof Error ? error.stack || error.message : String(error));
  }
}());
