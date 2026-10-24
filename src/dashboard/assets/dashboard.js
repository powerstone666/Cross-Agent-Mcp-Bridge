// ==========================================================================
// Cross-Agent-Mcp-Bridge Dashboard · Client Orchestrator
// Pure, reactive, functional client with all custom dropdowns & M3 UI.
// ==========================================================================

(() => {
  "use strict";

  // Application State
  const state = {
    loading: false,
    currentView: "overview",
    data: null,
    activityFilter: "all",
    taskQuery: "",
    selectedAgent: null,
    selectedSkill: null,
    selectedRule: null,
    taskModalAssignee: null,
    taskModalSkill: null,
    taskModalRule: null,
    claimModalTask: null,
    claimModalAgent: null,
    filterSkill: null,
    filterRule: null,
    filterAgent: null,
  };

  const root = document.documentElement;
  const themeToggle = document.getElementById("theme-toggle");
  const themeIcon = document.getElementById("theme-icon");

  // Helper: SVG Chevron Node Creation
  function createChevronSvg() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "dropdown-chevron");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("points", "6 9 12 15 18 9");
    svg.append(polyline);
    return svg;
  }

  // SVG Icon Templates
  const SVG_ICONS = {
    task: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>`,
    message: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,
    file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
    agent: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`,
    activity: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    cross: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
    sun: `<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>`,
    moon: `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>`,
  };

  // Helper: DOM Node Creation
  function el(tag, className = "", children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof children === "string") {
      node.textContent = children;
    } else if (Array.isArray(children)) {
      for (const child of children) {
        if (child) node.append(child);
      }
    }
    return node;
  }

  // Format Helper: Initials
  function initials(text) {
    if (!text) return "?";
    const parts = String(text).trim().split(/[\s_-]+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return String(text).slice(0, 2).toUpperCase();
  }

  // Format Helper: Relative Time
  function formatRelativeTime(isoString) {
    if (!isoString) return "";
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return "";
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 5) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  // Toast Notification System
  function showToast(message, type = "success") {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const toast = el("div", `toast toast-${type}`, [
      el("span", "toast-icon", type === "success" ? "✓" : "!"),
      el("span", "toast-text", message),
    ]);
    container.append(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(8px)";
      toast.style.transition = "all 200ms ease";
      setTimeout(() => toast.remove(), 220);
    }, 4000);
  }

  // Theme Management
  function applyTheme(theme) {
    root.dataset.theme = theme;
    localStorage.setItem("cross-agent-mcp-bridge-theme", theme);
    if (themeIcon) {
      themeIcon.innerHTML = theme === "dark" ? SVG_ICONS.sun : SVG_ICONS.moon;
    }
  }

  const savedTheme = localStorage.getItem("cross-agent-mcp-bridge-theme") ||
    (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  applyTheme(savedTheme);

  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      applyTheme(root.dataset.theme === "dark" ? "light" : "dark");
    });
  }

  // Navigation & View Switching
  function switchView(viewName) {
    state.currentView = viewName;
    document.querySelectorAll(".nav-link").forEach((link) => {
      link.classList.toggle("active", link.dataset.view === viewName);
    });
    document.querySelectorAll(".view-panel").forEach((panel) => {
      const match = panel.id === `view-${viewName}`;
      panel.classList.toggle("active", match);
      panel.hidden = !match;
    });
    window.location.hash = viewName;
  }

  document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", () => {
      if (link.dataset.view) switchView(link.dataset.view);
    });
  });

  document.querySelectorAll("[data-goto-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.gotoView;
      if (target) switchView(target);
    });
  });

  const initialHash = window.location.hash.replace("#", "");
  if (["overview", "tasks", "agents", "activity", "coordination"].includes(initialHash)) {
    switchView(initialHash);
  }

  // ==========================================================================
  // All Custom Dropdown Engine
  // ==========================================================================

  function closeAllDropdowns() {
    document.querySelectorAll(".custom-dropdown.open").forEach((dd) => {
      dd.classList.remove("open");
      dd.querySelector(".custom-dropdown-trigger")?.setAttribute("aria-expanded", "false");
    });
  }

  document.addEventListener("click", () => closeAllDropdowns());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllDropdowns();
  });

  function setupCustomDropdown({
    containerId,
    triggerValId,
    optionsListId,
    items,
    currentVal,
    onSelect,
    getTitle,
    getDesc,
    getCategory,
    emptyLabel = "None / Auto",
  }) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const trigger = container.querySelector(".custom-dropdown-trigger");
    const valSpan = document.getElementById(triggerValId);
    const panel = container.querySelector(".custom-dropdown-panel");
    const optionsList = document.getElementById(optionsListId);
    const searchInput = panel?.querySelector("input");

    // Prevent panel clicks from closing dropdown prematurely
    panel?.addEventListener("click", (e) => e.stopPropagation());

    trigger.onclick = (e) => {
      e.stopPropagation();
      const isOpen = container.classList.contains("open");
      closeAllDropdowns();
      if (!isOpen) {
        container.classList.add("open");
        trigger.setAttribute("aria-expanded", "true");
        if (searchInput) {
          searchInput.value = "";
          renderOptions(items);
          searchInput.focus();
        }
      }
    };

    function renderOptions(filteredItems) {
      if (!optionsList) return;
      optionsList.replaceChildren();

      // Clear / None option
      const clearItem = el("div", "dropdown-opt-item");
      clearItem.tabIndex = 0;
      clearItem.append(
        el("div", "dropdown-opt-title", emptyLabel),
        el("div", "dropdown-opt-desc", "Clear selection")
      );
      if (!currentVal) clearItem.classList.add("selected");
      clearItem.onclick = (e) => {
        e.stopPropagation();
        onSelect(null);
        closeAllDropdowns();
      };
      optionsList.append(clearItem);

      // Group by category if available
      const groups = new Map();
      for (const item of filteredItems) {
        const cat = getCategory ? getCategory(item) : "Available";
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat).push(item);
      }

      for (const [category, groupItems] of groups.entries()) {
        optionsList.append(el("div", "dropdown-opt-category", category));
        for (const item of groupItems) {
          const opt = el("div", "dropdown-opt-item");
          opt.tabIndex = 0;
          const titleText = getTitle ? getTitle(item) : item.name || item.id;
          const descText = getDesc ? getDesc(item) : item.description || "";

          opt.append(el("div", "dropdown-opt-title", titleText));
          if (descText) {
            opt.append(el("div", "dropdown-opt-desc", descText));
          }

          if (currentVal && (currentVal === item.id || currentVal === item.name || currentVal === item.agentName || currentVal === item.taskId)) {
            opt.classList.add("selected");
          }

          opt.onclick = (e) => {
            e.stopPropagation();
            onSelect(item);
            closeAllDropdowns();
          };
          optionsList.append(opt);
        }
      }
    }

    // Keyboard navigation across options
    function handleKeyNav(e) {
      if (!container.classList.contains("open")) return;
      const opts = Array.from(optionsList?.querySelectorAll(".dropdown-opt-item") || []);
      if (!opts.length) return;

      const currentIndex = opts.findIndex((node) => node.classList.contains("focused") || document.activeElement === node);

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const nextIndex = currentIndex < opts.length - 1 ? currentIndex + 1 : 0;
        opts.forEach((node, i) => node.classList.toggle("focused", i === nextIndex));
        opts[nextIndex].focus();
        opts[nextIndex].scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : opts.length - 1;
        opts.forEach((node, i) => node.classList.toggle("focused", i === prevIndex));
        opts[prevIndex].focus();
        opts[prevIndex].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        if (currentIndex >= 0 && opts[currentIndex]) {
          e.preventDefault();
          opts[currentIndex].click();
        }
      }
    }

    panel?.addEventListener("keydown", handleKeyNav);
    trigger.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && !container.classList.contains("open")) {
        e.preventDefault();
        trigger.click();
      } else {
        handleKeyNav(e);
      }
    });

    if (searchInput) {
      searchInput.onclick = (e) => e.stopPropagation();
      searchInput.oninput = (e) => {
        const q = e.target.value.toLowerCase().trim();
        const filtered = items.filter((item) => {
          const t = (getTitle ? getTitle(item) : item.name || item.id || item.agentName || item.title || "").toLowerCase();
          const d = (getDesc ? getDesc(item) : item.description || "").toLowerCase();
          return t.includes(q) || d.includes(q);
        });
        renderOptions(filtered);
      };
    }

    renderOptions(items);
  }

  // Active Modifiers Chips Bar
  function updateModifiersBar() {
    const bar = document.getElementById("selected-modifiers-bar");
    const container = document.getElementById("modifiers-chips");
    if (!bar || !container) return;

    const hasModifiers = state.selectedSkill || state.selectedRule || state.selectedAgent;
    if (!hasModifiers) {
      bar.hidden = true;
      container.replaceChildren();
      return;
    }

    bar.hidden = false;
    container.replaceChildren();

    if (state.selectedAgent) {
      const chip = el("span", "modifier-chip");
      chip.append(
        el("span", "", `Agent: @${state.selectedAgent.agentName}`),
        createRemoveBtn(() => {
          state.selectedAgent = null;
          document.getElementById("val-dispatch-agent").textContent = "Auto (@agent)";
          updateModifiersBar();
        })
      );
      container.append(chip);
    }

    if (state.selectedSkill) {
      const chip = el("span", "modifier-chip");
      chip.append(
        el("span", "", `Skill: ${state.selectedSkill.name}`),
        createRemoveBtn(() => {
          state.selectedSkill = null;
          document.getElementById("val-dispatch-skill").textContent = "None";
          updateModifiersBar();
        })
      );
      container.append(chip);
    }

    if (state.selectedRule) {
      const chip = el("span", "modifier-chip");
      chip.append(
        el("span", "", `Rule: ${state.selectedRule.name}`),
        createRemoveBtn(() => {
          state.selectedRule = null;
          document.getElementById("val-dispatch-rule").textContent = "None";
          updateModifiersBar();
        })
      );
      container.append(chip);
    }
  }

  function createRemoveBtn(onRemove) {
    const btn = el("span", "modifier-remove", "×");
    btn.onclick = (e) => {
      e.stopPropagation();
      onRemove();
    };
    return btn;
  }

  document.getElementById("btn-clear-modifiers")?.addEventListener("click", () => {
    state.selectedAgent = null;
    state.selectedSkill = null;
    state.selectedRule = null;
    document.getElementById("val-dispatch-agent").textContent = "Auto (@agent)";
    document.getElementById("val-dispatch-skill").textContent = "None";
    document.getElementById("val-dispatch-rule").textContent = "None";
    updateModifiersBar();
  });

  // Populate Custom Dropdowns for Dispatch
  function populateDispatchCustomDropdowns() {
    if (!state.data) return;

    // 1. Agent Custom Dropdown
    setupCustomDropdown({
      containerId: "dropdown-dispatch-agent",
      triggerValId: "val-dispatch-agent",
      optionsListId: "opts-dispatch-agent",
      items: state.data.agents || [],
      currentVal: state.selectedAgent?.agentName,
      emptyLabel: "Auto (@agent mention)",
      getTitle: (a) => `@${a.agentName} (${a.displayName || a.agentName})`,
      getDesc: (a) => `Status: ${a.activity || "Idle"} · ${a.connection || "Available"}`,
      getCategory: (a) => (a.connection || "Available").toUpperCase(),
      onSelect: (agent) => {
        state.selectedAgent = agent;
        document.getElementById("val-dispatch-agent").textContent = agent ? `@${agent.agentName}` : "Auto (@agent)";
        updateModifiersBar();
      },
    });

    // 2. Skill Custom Dropdown
    setupCustomDropdown({
      containerId: "dropdown-dispatch-skill",
      triggerValId: "val-dispatch-skill",
      optionsListId: "opts-dispatch-skill",
      items: state.data.skills || [],
      currentVal: state.selectedSkill?.id,
      emptyLabel: "No Skill",
      getTitle: (s) => s.name,
      getDesc: (s) => s.description,
      getCategory: (s) => s.category || "Skills",
      onSelect: (skill) => {
        state.selectedSkill = skill;
        document.getElementById("val-dispatch-skill").textContent = skill ? skill.name : "None";
        updateModifiersBar();
      },
    });

    // 3. Rule Custom Dropdown
    setupCustomDropdown({
      containerId: "dropdown-dispatch-rule",
      triggerValId: "val-dispatch-rule",
      optionsListId: "opts-dispatch-rule",
      items: state.data.rules || [],
      currentVal: state.selectedRule?.id,
      emptyLabel: "No Rule",
      getTitle: (r) => r.name,
      getDesc: (r) => r.description,
      getCategory: (r) => r.category || "Rules",
      onSelect: (rule) => {
        state.selectedRule = rule;
        document.getElementById("val-dispatch-rule").textContent = rule ? rule.name : "None";
        updateModifiersBar();
      },
    });
  }

  // Populate Custom Dropdowns for Task Modal
  function populateTaskModalCustomDropdowns() {
    if (!state.data) return;

    setupCustomDropdown({
      containerId: "dropdown-task-assignee",
      triggerValId: "val-task-assignee",
      optionsListId: "opts-task-assignee",
      items: state.data.agents || [],
      currentVal: state.taskModalAssignee?.agentName,
      emptyLabel: "Unassigned",
      getTitle: (a) => `@${a.agentName} (${a.displayName || a.agentName})`,
      getDesc: (a) => `Connection: ${a.connection || "Available"}`,
      getCategory: () => "Agents",
      onSelect: (agent) => {
        state.taskModalAssignee = agent;
        document.getElementById("val-task-assignee").textContent = agent ? `@${agent.agentName}` : "Unassigned";
      },
    });

    setupCustomDropdown({
      containerId: "dropdown-task-skill",
      triggerValId: "val-task-skill",
      optionsListId: "opts-task-skill",
      items: state.data.skills || [],
      currentVal: state.taskModalSkill?.id,
      emptyLabel: "None",
      getTitle: (s) => s.name,
      getDesc: (s) => s.description,
      getCategory: (s) => s.category || "Skills",
      onSelect: (skill) => {
        state.taskModalSkill = skill;
        document.getElementById("val-task-skill").textContent = skill ? skill.name : "None";
      },
    });

    setupCustomDropdown({
      containerId: "dropdown-task-rule",
      triggerValId: "val-task-rule",
      optionsListId: "opts-task-rule",
      items: state.data.rules || [],
      currentVal: state.taskModalRule?.id,
      emptyLabel: "None",
      getTitle: (r) => r.name,
      getDesc: (r) => r.description,
      getCategory: (r) => r.category || "Rules",
      onSelect: (rule) => {
        state.taskModalRule = rule;
        document.getElementById("val-task-rule").textContent = rule ? rule.name : "None";
      },
    });
  }

  // Populate Custom Filters for Tasks Board (Skill, Rule, Agent)
  function populateTasksBoardCustomFilters() {
    if (!state.data) return;

    // 1. Filter by Skill
    setupCustomDropdown({
      containerId: "dropdown-filter-skill",
      triggerValId: "val-filter-skill",
      optionsListId: "opts-filter-skill",
      items: state.data.skills || [],
      currentVal: state.filterSkill?.id,
      emptyLabel: "All Skills",
      getTitle: (s) => s.name,
      getDesc: (s) => s.description,
      getCategory: (s) => s.category || "Skills",
      onSelect: (skill) => {
        state.filterSkill = skill;
        const valEl = document.getElementById("val-filter-skill");
        if (valEl) valEl.textContent = skill ? skill.name : "All Skills";
        renderTasksView();
      },
    });

    // 2. Filter by Rule
    setupCustomDropdown({
      containerId: "dropdown-filter-rule",
      triggerValId: "val-filter-rule",
      optionsListId: "opts-filter-rule",
      items: state.data.rules || [],
      currentVal: state.filterRule?.id,
      emptyLabel: "All Rules",
      getTitle: (r) => r.name,
      getDesc: (r) => r.description,
      getCategory: (r) => r.category || "Rules",
      onSelect: (rule) => {
        state.filterRule = rule;
        const valEl = document.getElementById("val-filter-rule");
        if (valEl) valEl.textContent = rule ? rule.name : "All Rules";
        renderTasksView();
      },
    });

    // 3. Filter by Agent
    setupCustomDropdown({
      containerId: "dropdown-filter-agent",
      triggerValId: "val-filter-agent",
      optionsListId: "opts-filter-agent",
      items: state.data.agents || [],
      currentVal: state.filterAgent?.agentName,
      emptyLabel: "All Agents",
      getTitle: (a) => `@${a.agentName} (${a.displayName || a.agentName})`,
      getDesc: (a) => `Activity: ${a.activity || "Idle"}`,
      getCategory: () => "Agents",
      onSelect: (agent) => {
        state.filterAgent = agent;
        const valEl = document.getElementById("val-filter-agent");
        if (valEl) valEl.textContent = agent ? `@${agent.agentName}` : "All Agents";
        renderTasksView();
      },
    });
  }

  // Populate Custom Dropdowns for Claim File Modal
  function populateClaimModal() {
    if (!state.data) return;

    setupCustomDropdown({
      containerId: "dropdown-claim-task",
      triggerValId: "val-claim-task",
      optionsListId: "opts-claim-task",
      items: state.data.tasks || [],
      currentVal: state.claimModalTask?.taskId,
      emptyLabel: "Select associated task…",
      getTitle: (t) => t.title || t.taskId,
      getDesc: (t) => `Status: ${t.status || "open"} · ${t.assignedTo ? "Assigned: @" + t.assignedTo : "Unassigned"}`,
      getCategory: (t) => (t.status || "open").toUpperCase(),
      onSelect: (task) => {
        state.claimModalTask = task;
        const valEl = document.getElementById("val-claim-task");
        if (valEl) valEl.textContent = task ? (task.title || task.taskId) : "Select task…";
      },
    });

    setupCustomDropdown({
      containerId: "dropdown-claim-agent",
      triggerValId: "val-claim-agent",
      optionsListId: "opts-claim-agent",
      items: state.data.agents || [],
      currentVal: state.claimModalAgent?.agentName,
      emptyLabel: "Default participant",
      getTitle: (a) => `@${a.agentName} (${a.displayName || a.agentName})`,
      getDesc: (a) => `Activity: ${a.activity || "Idle"}`,
      getCategory: () => "Agents",
      onSelect: (agent) => {
        state.claimModalAgent = agent;
        const valEl = document.getElementById("val-claim-agent");
        if (valEl) valEl.textContent = agent ? `@${agent.agentName}` : "Default participant";
      },
    });
  }

  // Modals & Dialog Handling
  const taskDialog = document.getElementById("create-task-dialog");
  const claimDialog = document.getElementById("claim-file-dialog");

  document.getElementById("btn-new-task")?.addEventListener("click", () => {
    populateTaskModalCustomDropdowns();
    taskDialog?.showModal();
  });

  document.getElementById("btn-create-task-modal")?.addEventListener("click", () => {
    populateTaskModalCustomDropdowns();
    taskDialog?.showModal();
  });

  document.getElementById("btn-close-task-modal")?.addEventListener("click", () => taskDialog?.close());
  document.getElementById("btn-cancel-task")?.addEventListener("click", () => taskDialog?.close());

  document.getElementById("btn-open-claim-modal")?.addEventListener("click", () => {
    populateClaimModal();
    claimDialog?.showModal();
  });

  document.getElementById("btn-close-claim-modal")?.addEventListener("click", () => claimDialog?.close());
  document.getElementById("btn-cancel-claim")?.addEventListener("click", () => claimDialog?.close());

  // Quick Dispatch Button
  document.getElementById("btn-quick-dispatch")?.addEventListener("click", () => {
    switchView("overview");
    const input = document.getElementById("dispatch-input");
    input?.focus();
    input?.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // Manual Refresh Button
  const btnRefresh = document.getElementById("btn-refresh");
  btnRefresh?.addEventListener("click", async () => {
    btnRefresh.classList.add("loading");
    await loadDashboard();
    btnRefresh.classList.remove("loading");
    showToast("Dashboard synchronized");
  });

  // Task Creation Form Submission
  const createTaskForm = document.getElementById("create-task-form");
  createTaskForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const titleInput = document.getElementById("task-title-input");
    const descInput = document.getElementById("task-desc-input");
    const filesInput = document.getElementById("task-files-input");
    const submitBtn = document.getElementById("btn-save-task");

    const title = titleInput.value.trim();
    if (!title) return;

    const files = filesInput.value.split(",").map((f) => f.trim()).filter(Boolean);
    const assignedTo = state.taskModalAssignee ? state.taskModalAssignee.agentName : undefined;
    let description = descInput.value.trim();

    // Append skill and rule requirements if selected
    const requirements = [];
    if (state.taskModalSkill) requirements.push(`- Required Skill: \`${state.taskModalSkill.name}\``);
    if (state.taskModalRule) requirements.push(`- Enforced Rule: \`${state.taskModalRule.name}\` (${state.taskModalRule.description})`);

    if (requirements.length > 0) {
      description = `${description ? description + "\n\n" : ""}### Requirements & Standards\n${requirements.join("\n")}`;
    }

    submitBtn.disabled = true;
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, assignedTo, files }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to create task");
      showToast("Task created successfully");
      taskDialog?.close();
      createTaskForm.reset();
      state.taskModalAssignee = null;
      state.taskModalSkill = null;
      state.taskModalRule = null;
      document.getElementById("val-task-assignee").textContent = "Unassigned";
      document.getElementById("val-task-skill").textContent = "None";
      document.getElementById("val-task-rule").textContent = "None";
      await loadDashboard();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      submitBtn.disabled = false;
    }
  });

  // Claim File Form Submission
  const claimForm = document.getElementById("claim-file-form");
  claimForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById("claim-filepath-input");
    const submitBtn = document.getElementById("btn-save-claim");

    const filePath = fileInput.value.trim();
    const taskId = state.claimModalTask ? state.claimModalTask.taskId : null;
    const participantId = state.claimModalAgent ? state.claimModalAgent.agentName : undefined;

    if (!filePath) {
      showToast("Please enter a file path to claim", "warning");
      return;
    }
    if (!taskId) {
      showToast("Please select an associated task", "warning");
      return;
    }

    submitBtn.disabled = true;
    try {
      const res = await fetch("/api/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath, taskId, participantId }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to claim file");
      showToast("File claimed successfully");
      claimDialog?.close();
      claimForm.reset();
      state.claimModalTask = null;
      state.claimModalAgent = null;
      const valTask = document.getElementById("val-claim-task");
      if (valTask) valTask.textContent = "Select task…";
      const valAgent = document.getElementById("val-claim-agent");
      if (valAgent) valAgent.textContent = "Default participant";
      await loadDashboard();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      submitBtn.disabled = false;
    }
  });

  // Direct Agent Dispatch Form
  const dispatchForm = document.getElementById("dispatch-form");
  dispatchForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("dispatch-input");
    const submitBtn = document.getElementById("dispatch-submit-btn");
    const outputBox = document.getElementById("dispatch-output-box");
    const outputStatus = document.getElementById("dispatch-output-status");
    const outputPre = document.getElementById("dispatch-output-pre");

    let prompt = input.value.trim();
    if (!prompt) return;

    // Apply selected agent mention if not already prefixed
    if (state.selectedAgent && !prompt.startsWith("@")) {
      prompt = `@${state.selectedAgent.agentName} ${prompt}`;
    }

    // Attach selected skill and rule directives
    const directives = [];
    if (state.selectedSkill) {
      directives.push(`[Skill: ${state.selectedSkill.name}]`);
    }
    if (state.selectedRule) {
      directives.push(`[Rule: ${state.selectedRule.name} - ${state.selectedRule.description}]`);
    }

    if (directives.length > 0) {
      prompt = `${prompt}\n\nContext directives: ${directives.join(" ")}`;
    }

    submitBtn.disabled = true;
    outputBox.hidden = false;
    outputStatus.textContent = `Dispatching turn to relay…`;
    outputPre.textContent = `> ${prompt}\n\n`;

    try {
      const res = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Turn execution failed");
      outputStatus.textContent = `Turn completed successfully.`;
      outputPre.textContent += data.replyText || "(No output returned)";
      showToast("Turn completed");
      await loadDashboard();
    } catch (err) {
      outputStatus.textContent = `Error: ${err.message}`;
      outputPre.textContent += `[Error: ${err.message}]`;
      showToast(err.message, "error");
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.getElementById("btn-clear-output")?.addEventListener("click", () => {
    const box = document.getElementById("dispatch-output-box");
    if (box) box.hidden = true;
  });

  // Post Room Message Form
  const roomMsgForm = document.getElementById("room-message-form");
  roomMsgForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("room-message-input");
    const submitBtn = document.getElementById("room-message-btn");
    const message = input.value.trim();
    if (!message) return;

    submitBtn.disabled = true;
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to post note");
      input.value = "";
      showToast("Coordination note posted");
      await loadDashboard();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      submitBtn.disabled = false;
    }
  });

  // Task Search Filter
  document.getElementById("task-search-input")?.addEventListener("input", (e) => {
    state.taskQuery = e.target.value.toLowerCase().trim();
    renderTasksView();
  });

  // Activity Category Filter
  document.querySelectorAll("#activity-filter-chips .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#activity-filter-chips .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.activityFilter = chip.dataset.filter || "all";
      renderActivityView();
    });
  });

  // ==========================================================================
  // Renderers
  // ==========================================================================

  function render(data) {
    state.data = data;
    const workspaceName = data.workspace ? (data.workspace.split(/[\\/]/).filter(Boolean).at(-1) || data.workspace) : "Workspace";

    // Top Header & Sidebar Info
    document.getElementById("sidebar-workspace").textContent = workspaceName;
    document.getElementById("breadcrumb-workspace").textContent = workspaceName;
    document.getElementById("workspace-monogram").textContent = initials(workspaceName);
    document.getElementById("sidebar-room").textContent = `Room: ${data.roomId || "backend"}`;
    document.getElementById("breadcrumb-room").textContent = data.roomId || "backend";
    document.getElementById("last-updated").textContent = `Sync: ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;

    // Connection Status Dot
    const connCard = document.getElementById("connection-card");
    const connLabel = document.getElementById("connection-label");
    if (data.connected) {
      connCard.classList.add("connected");
      connCard.classList.remove("error");
      connLabel.textContent = "Relay online";
    } else {
      connCard.classList.remove("connected");
      connCard.classList.add("error");
      connLabel.textContent = "Disconnected";
    }

    // Nav Badges
    const taskCount = (data.tasks || []).length;
    const agentCount = (data.agents || []).length;
    const claimsCount = (data.fileClaims || []).length;
    document.getElementById("nav-task-count").textContent = String(taskCount);
    document.getElementById("nav-agent-count").textContent = String(agentCount);
    document.getElementById("nav-claims-count").textContent = String(claimsCount);

    // Metrics Grid
    const connectedAgents = (data.agents || []).filter((a) => (a.connection || "").toLowerCase() === "connected").length;
    document.getElementById("metric-connected-agents").textContent = String(connectedAgents);
    document.getElementById("metric-total-agents").textContent = `of ${agentCount} discovered`;

    const doneTasks = (data.tasks || []).filter((t) => t.status === "done").length;
    const activeTasks = taskCount - doneTasks;
    document.getElementById("metric-active-tasks").textContent = String(activeTasks);
    document.getElementById("metric-done-tasks").textContent = `${doneTasks} completed`;

    document.getElementById("metric-active-claims").textContent = String(claimsCount);
    document.getElementById("metric-events-count").textContent = String((data.events || []).length);

    // Render Subsections
    renderApprovalsBanner(data.approvals || []);
    renderOverviewTasks(data.tasks || []);
    renderOverviewAgents(data.agents || [], data.unavailableAgents || []);
    renderOverviewActivity(data.events || []);
    renderTasksView();
    renderAgentsView(data.agents || [], data.unavailableAgents || []);
    renderActivityView();
    renderCoordinationView(data.fileClaims || [], data.worktrees || []);
    renderDiagnostics(data.diagnostics || {});

    // Populate all custom dropdowns
    populateDispatchCustomDropdowns();
    populateTasksBoardCustomFilters();
  }

  // Approvals Attention Banner
  function renderApprovalsBanner(approvals) {
    const banner = document.getElementById("approvals-banner");
    const container = document.getElementById("approval-cards-container");
    const badge = document.getElementById("pending-approvals-count");
    if (!banner || !container) return;

    if (!approvals.length) {
      banner.hidden = true;
      container.replaceChildren();
      return;
    }

    banner.hidden = false;
    badge.textContent = `${approvals.length} pending`;
    container.replaceChildren();

    for (const item of approvals) {
      const card = el("div", "approval-card-item");
      const top = el("div", "approval-card-top");
      top.append(
        el("strong", "approval-summary", item.request?.summary || "Command execution requested"),
        el("span", "approval-kind-chip", item.request?.kind || "approval")
      );

      const details = [
        item.request?.kind ? `Type: ${item.request.kind}` : null,
        ...(item.request?.detailLines || []),
      ].filter(Boolean).join("\n");

      const codeBox = el("pre", "approval-details-box", details || "No extra detail lines provided");

      const btnGroup = el("div", "approval-btn-group");
      const btnAccept = el("button", "btn btn-primary btn-sm", [
        createIconNode("check"),
        el("span", "", "Approve"),
      ]);
      const btnDecline = el("button", "btn btn-danger btn-sm", [
        createIconNode("cross"),
        el("span", "", "Decline"),
      ]);
      const btnCancel = el("button", "btn btn-tonal btn-sm", "Cancel Turn");

      btnAccept.addEventListener("click", () => handleApprovalDecision(item.approvalId, "accept", btnAccept));
      btnDecline.addEventListener("click", () => handleApprovalDecision(item.approvalId, "decline", btnDecline));
      btnCancel.addEventListener("click", () => handleApprovalDecision(item.approvalId, "cancel", btnCancel));

      btnGroup.append(btnAccept, btnDecline, btnCancel);
      card.append(top, codeBox, btnGroup);
      container.append(card);
    }
  }

  async function handleApprovalDecision(approvalId, decision, button) {
    button.disabled = true;
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Decision failed");
      showToast(`Approval ${decision}ed`);
      await loadDashboard();
    } catch (err) {
      showToast(err.message, "error");
      button.disabled = false;
    }
  }

  // Overview Active Tasks List
  function renderOverviewTasks(tasks) {
    const list = document.getElementById("overview-task-list");
    if (!list) return;
    list.replaceChildren();

    const activeList = tasks.filter((t) => t.status !== "done").slice(0, 5);
    if (!activeList.length) {
      list.append(el("p", "empty-state", "No active room tasks. Click '+ New Task' above to start work."));
      return;
    }

    for (const task of activeList) {
      const row = el("div", "task-row-item");
      const left = el("div", "task-row-left");
      left.append(el("span", `col-dot dot-${task.status.replace("_", "")}`));
      const textBlock = el("div", "task-row-text");
      textBlock.append(
        el("strong", "", task.title || task.taskId),
        el("small", "", task.assignedTo ? `Assigned to @${task.assignedTo}` : "Unassigned")
      );
      left.append(textBlock);

      const statusDropdown = createTaskStatusDropdown(task);
      row.append(left, statusDropdown);
      list.append(row);
    }
  }

  // Overview Agents Compact List
  function renderOverviewAgents(agents, unavailableAgents) {
    const list = document.getElementById("overview-agent-list");
    const countBadge = document.getElementById("overview-agents-count");
    if (!list) return;
    list.replaceChildren();

    const all = [...agents];
    countBadge.textContent = `${agents.length} active`;

    if (!all.length && !unavailableAgents.length) {
      list.append(el("p", "empty-state", "No agents detected in registry."));
      return;
    }

    for (const agent of all) {
      const row = el("div", "agent-compact-row");
      const left = el("div", "agent-compact-left");
      left.append(el("div", "agent-compact-avatar", initials(agent.displayName || agent.agentName)));
      const info = el("div");
      info.append(
        el("strong", "agent-name", agent.displayName || agent.agentName),
        el("div", "hint-text", `@${agent.agentName}`)
      );
      left.append(info);

      const statusBadge = el("span", `status-badge ${(agent.connection || "available").toLowerCase()}`, agent.connection || "Available");
      row.append(left, statusBadge);
      list.append(row);
    }

    for (const un of unavailableAgents) {
      const row = el("div", "agent-compact-row");
      const left = el("div", "agent-compact-left");
      left.append(el("div", "agent-compact-avatar", initials(un.agentName)));
      const info = el("div");
      info.append(
        el("strong", "agent-name", un.agentName),
        el("div", "hint-text", un.reason || "Not installed")
      );
      left.append(info);
      row.append(left, el("span", "status-badge unavailable", "Unavailable"));
      list.append(row);
    }
  }

  // Overview Activity Feed
  function renderOverviewActivity(events) {
    const list = document.getElementById("overview-activity-list");
    if (!list) return;
    list.replaceChildren();

    const recent = [...events].reverse().slice(0, 5);
    if (!recent.length) {
      list.append(el("li", "empty-state", "No recent room activity."));
      return;
    }

    for (const item of recent) {
      const row = el("li", "activity-item");
      const icon = el("div", "activity-icon-box");
      icon.innerHTML = SVG_ICONS[resolveEventCategory(item.type)] || SVG_ICONS.activity;

      const content = el("div", "activity-content");
      content.append(
        el("p", "activity-summary-text", item.summary || item.type),
        el("span", "activity-meta-line", `${item.actor || "room"} · ${formatRelativeTime(item.timestamp)}`)
      );
      row.append(icon, content);
      list.append(row);
    }
  }

  // Requirements Parser (Skills & Rules)
  function parseRequirements(content) {
    if (!content) return { skill: null, rule: null };
    const skillMatch = content.match(/Required Skill:\s*`?([a-zA-Z0-9_-]+)`?/i);
    const ruleMatch = content.match(/Enforced Rule:\s*`?([a-zA-Z0-9_-]+)`?/i);
    return {
      skill: skillMatch ? skillMatch[1] : null,
      rule: ruleMatch ? ruleMatch[1] : null,
    };
  }

  // Full Tasks Board (Kanban Columns)
  function renderTasksView() {
    if (!state.data) return;
    const tasks = state.data.tasks || [];
    const query = state.taskQuery;

    const filtered = tasks.filter((t) => {
      // 1. Text Search Filter
      if (query) {
        const matchesQuery =
          (t.title || "").toLowerCase().includes(query) ||
          (t.assignedTo || "").toLowerCase().includes(query) ||
          (t.content || "").toLowerCase().includes(query) ||
          (t.description || "").toLowerCase().includes(query);
        if (!matchesQuery) return false;
      }
      // 2. Filter by Agent
      if (state.filterAgent && t.assignedTo !== state.filterAgent.agentName) {
        return false;
      }
      // 3. Filter by Skill
      if (state.filterSkill) {
        const text = ((t.content || "") + " " + (t.description || "")).toLowerCase();
        if (!text.includes(state.filterSkill.name.toLowerCase())) {
          return false;
        }
      }
      // 4. Filter by Rule
      if (state.filterRule) {
        const text = ((t.content || "") + " " + (t.description || "")).toLowerCase();
        if (!text.includes(state.filterRule.name.toLowerCase())) {
          return false;
        }
      }
      return true;
    });

    const columns = {
      open: document.getElementById("col-open-cards"),
      in_progress: document.getElementById("col-progress-cards"),
      review: document.getElementById("col-review-cards"),
      done: document.getElementById("col-done-cards"),
    };

    const counts = {
      open: document.getElementById("count-open"),
      in_progress: document.getElementById("count-in_progress"),
      review: document.getElementById("count-review"),
      done: document.getElementById("count-done"),
    };

    for (const key of Object.keys(columns)) {
      if (columns[key]) columns[key].replaceChildren();
      if (counts[key]) counts[key].textContent = "0";
    }

    const tally = { open: 0, in_progress: 0, review: 0, done: 0 };

    for (const task of filtered) {
      const colKey = task.status || "open";
      if (!columns[colKey]) continue;
      tally[colKey] = (tally[colKey] || 0) + 1;

      const card = el("div", "task-card");
      card.append(el("div", "task-card-title", task.title || task.taskId));

      if (task.description) {
        card.append(el("div", "task-card-desc", task.description));
      }

      // Check for skill and rule badges in content & description
      const reqs = parseRequirements((task.content || "") + " " + (task.description || ""));
      if (reqs.skill || reqs.rule) {
        const chipsContainer = el("div", "task-card-chips");
        if (reqs.skill) {
          const chip = el("span", "task-chip task-chip-skill", `✦ ${reqs.skill}`);
          chip.title = `Skill requirement: ${reqs.skill} (Click to filter)`;
          chip.onclick = (e) => {
            e.stopPropagation();
            state.filterSkill = state.data?.skills?.find((s) => s.name === reqs.skill || s.id === reqs.skill) || { name: reqs.skill, id: reqs.skill };
            const val = document.getElementById("val-filter-skill");
            if (val) val.textContent = reqs.skill;
            renderTasksView();
          };
          chipsContainer.append(chip);
        }
        if (reqs.rule) {
          const chip = el("span", "task-chip task-chip-rule", `⚡ ${reqs.rule}`);
          chip.title = `Rule requirement: ${reqs.rule} (Click to filter)`;
          chip.onclick = (e) => {
            e.stopPropagation();
            state.filterRule = state.data?.rules?.find((r) => r.name === reqs.rule || r.id === reqs.rule) || { name: reqs.rule, id: reqs.rule };
            const val = document.getElementById("val-filter-rule");
            if (val) val.textContent = reqs.rule;
            renderTasksView();
          };
          chipsContainer.append(chip);
        }
        card.append(chipsContainer);
      }

      const footer = el("div", "task-card-footer");
      const assigneeBox = el("div", "task-assignee");
      if (task.assignedTo) {
        assigneeBox.append(
          el("span", "assignee-avatar", initials(task.assignedTo)),
          el("span", "", `@${task.assignedTo}`)
        );
      } else {
        assigneeBox.textContent = "Unassigned";
      }

      const actionsMenu = el("div", "task-actions-menu");
      const statusDropdown = createTaskStatusDropdown(task);
      actionsMenu.append(statusDropdown);

      footer.append(assigneeBox, actionsMenu);
      card.append(footer);
      columns[colKey].append(card);
    }

    for (const key of Object.keys(counts)) {
      if (counts[key]) counts[key].textContent = String(tally[key] || 0);
    }

    for (const key of Object.keys(columns)) {
      if (columns[key] && !columns[key].children.length) {
        columns[key].append(el("p", "empty-state", "No tasks in this column"));
      }
    }
  }

  // Custom Task Status Dropdown (Zero native select)
  function createTaskStatusDropdown(task) {
    const container = el("div", "custom-dropdown status-dropdown");
    const sanitizedStatus = (task.status || "open").replace(/[^a-z0-9_]/gi, "");
    const trigger = el("button", `status-dropdown-trigger status-${sanitizedStatus}`);
    trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const statusMap = {
      open: { label: "Open", dotClass: "dot-open" },
      in_progress: { label: "In Progress", dotClass: "dot-progress" },
      review: { label: "Review", dotClass: "dot-review" },
      done: { label: "Done", dotClass: "dot-done" },
    };

    const currentMeta = statusMap[task.status] || { label: task.status, dotClass: "dot-open" };
    const dot = el("span", `col-dot ${currentMeta.dotClass}`);
    const labelSpan = el("span", "status-text", currentMeta.label);
    const chevron = createChevronSvg();
    trigger.append(dot, labelSpan, chevron);

    const panel = el("div", "status-dropdown-panel");
    panel.setAttribute("role", "listbox");
    panel.onclick = (e) => e.stopPropagation();

    const statuses = [
      { id: "open", label: "Open", dotClass: "dot-open" },
      { id: "in_progress", label: "In Progress", dotClass: "dot-progress" },
      { id: "review", label: "Review", dotClass: "dot-review" },
      { id: "done", label: "Done", dotClass: "dot-done" },
    ];

    for (const s of statuses) {
      const item = el("div", `status-opt-item ${task.status === s.id ? "selected" : ""}`);
      item.append(el("span", `col-dot ${s.dotClass}`), el("span", "", s.label));
      item.onclick = async (e) => {
        e.stopPropagation();
        closeAllDropdowns();
        if (task.status === s.id) return;

        trigger.disabled = true;
        labelSpan.textContent = "Updating…";
        try {
          const res = await fetch(`/api/tasks/${encodeURIComponent(task.taskId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: s.id }),
          });
          if (!res.ok) throw new Error((await res.json()).error || "Status update failed");
          showToast(`Task moved to ${s.label}`);
          await loadDashboard();
        } catch (err) {
          showToast(err.message, "error");
          labelSpan.textContent = currentMeta.label;
        } finally {
          trigger.disabled = false;
        }
      };
      panel.append(item);
    }

    trigger.onclick = (e) => {
      e.stopPropagation();
      const isOpen = container.classList.contains("open");
      closeAllDropdowns();
      if (!isOpen) {
        container.classList.add("open");
        trigger.setAttribute("aria-expanded", "true");
      }
    };

    container.append(trigger, panel);
    return container;
  }

  // Full Agent Fleet View
  function renderAgentsView(agents, unavailableAgents) {
    const grid = document.getElementById("full-agent-grid");
    if (!grid) return;
    grid.replaceChildren();

    for (const agent of agents) {
      const card = el("div", "agent-card");
      const header = el("div", "agent-card-header");
      const identity = el("div", "agent-card-identity");
      identity.append(
        el("div", "agent-card-avatar", initials(agent.displayName || agent.agentName)),
        el("div", "agent-card-info", [
          el("h3", "", agent.displayName || agent.agentName),
          el("span", "agent-card-mention", `@${agent.agentName}`),
        ])
      );
      const statusBadge = el("span", `status-badge ${(agent.connection || "available").toLowerCase()}`, agent.connection || "Available");
      header.append(identity, statusBadge);

      const meta = el("div", "agent-card-meta", [
        el("div", "meta-row", [el("span", "meta-key", "Status:"), el("span", "meta-val", agent.activity || "Idle")]),
        el("div", "meta-row", [el("span", "meta-key", "Connection:"), el("span", "meta-val", agent.connection || "Available")]),
      ]);

      const actions = el("div", "agent-card-actions");
      const msgBtn = el("button", "btn btn-primary btn-sm", "Message Agent");
      msgBtn.addEventListener("click", () => {
        switchView("overview");
        state.selectedAgent = agent;
        document.getElementById("val-dispatch-agent").textContent = `@${agent.agentName}`;
        updateModifiersBar();
        const dispatchInput = document.getElementById("dispatch-input");
        if (dispatchInput) {
          dispatchInput.value = `@${agent.agentName} `;
          dispatchInput.focus();
          dispatchInput.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
      actions.append(msgBtn);

      card.append(header, meta, actions);
      grid.append(card);
    }

    for (const un of unavailableAgents) {
      const card = el("div", "agent-card");
      const header = el("div", "agent-card-header");
      const identity = el("div", "agent-card-identity");
      identity.append(
        el("div", "agent-card-avatar", initials(un.agentName)),
        el("div", "agent-card-info", [
          el("h3", "", un.agentName),
          el("span", "agent-card-mention", `@${un.agentName}`),
        ])
      );
      header.append(identity, el("span", "status-badge unavailable", "Unavailable"));
      const meta = el("div", "agent-card-meta", [
        el("div", "meta-row", [el("span", "meta-key", "Reason:"), el("span", "meta-val", un.reason || "Not configured")]),
      ]);
      card.append(header, meta);
      grid.append(card);
    }
  }

  // Full Activity Stream View
  function renderActivityView() {
    const list = document.getElementById("full-activity-feed");
    if (!list || !state.data) return;
    list.replaceChildren();

    const events = [...(state.data.events || [])].reverse();
    const filter = state.activityFilter;

    const filtered = filter === "all"
      ? events
      : events.filter((e) => resolveEventCategory(e.type) === filter);

    if (!filtered.length) {
      list.append(el("li", "empty-state", "No activity recorded in this category."));
      return;
    }

    for (const item of filtered) {
      const row = el("li", "activity-item");
      const icon = el("div", "activity-icon-box");
      icon.innerHTML = SVG_ICONS[resolveEventCategory(item.type)] || SVG_ICONS.activity;

      const content = el("div", "activity-content");
      content.append(
        el("p", "activity-summary-text", item.summary || item.type),
        el("span", "activity-meta-line", `${item.actor || "room"} · ${formatRelativeTime(item.timestamp)}`)
      );
      row.append(icon, content);
      list.append(row);
    }
  }

  function resolveEventCategory(type) {
    if (!type) return "activity";
    if (type.includes("task")) return "task";
    if (type.includes("message")) return "message";
    if (type.includes("file") || type.includes("knowledge") || type.includes("worktree")) return "file";
    if (type.includes("agent") || type.includes("member")) return "agent";
    return "activity";
  }

  // Coordination View (Claims & Worktrees)
  function renderCoordinationView(claims, worktrees) {
    const claimsTbody = document.getElementById("claims-table-body");
    const worktreeTbody = document.getElementById("worktrees-table-body");

    if (claimsTbody) {
      claimsTbody.replaceChildren();
      if (!claims.length) {
        claimsTbody.append(createEmptyTableRow(5, "No active file claims in this room."));
      } else {
        for (const claim of claims) {
          const tr = el("tr");
          tr.append(
            el("td", "", claim.filePath),
            el("td", "", `@${claim.participantId}`),
            el("td", "", claim.taskId),
            el("td", "", formatRelativeTime(claim.claimedAt)),
            el("td", "", [createReleaseBtn(claim)])
          );
          claimsTbody.append(tr);
        }
      }
    }

    if (worktreeTbody) {
      worktreeTbody.replaceChildren();
      if (!worktrees.length) {
        worktreeTbody.append(createEmptyTableRow(3, "No task Git worktrees active."));
      } else {
        for (const wt of worktrees) {
          const tr = el("tr");
          tr.append(
            el("td", "", wt.taskId),
            el("td", "", wt.branch),
            el("td", "", wt.path)
          );
          worktreeTbody.append(tr);
        }
      }
    }
  }

  function createReleaseBtn(claim) {
    const btn = el("button", "btn btn-tonal btn-sm", "Release");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const res = await fetch("/api/claims/release", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filePath: claim.filePath,
            taskId: claim.taskId,
            participantId: claim.participantId,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error || "Release failed");
        showToast("File claim released");
        await loadDashboard();
      } catch (err) {
        showToast(err.message, "error");
        btn.disabled = false;
      }
    });
    return btn;
  }

  function createEmptyTableRow(cols, text) {
    const tr = el("tr");
    const td = el("td", "empty-state", text);
    td.colSpan = cols;
    tr.append(td);
    return tr;
  }

  // Diagnostics View
  function renderDiagnostics(diagnostics) {
    const list = document.getElementById("endpoint-list");
    if (!list) return;
    list.replaceChildren();

    const items = [
      ["Dashboard URL", diagnostics.dashboardUrl || window.location.origin],
      ["MCP Server Endpoint", diagnostics.mcpUrl || "http://127.0.0.1:38765/mcp"],
      ["Room File Directory", diagnostics.roomPath || "Unavailable"],
    ];

    for (const [label, val] of items) {
      const item = el("div", "endpoint-item");
      item.append(el("span", "", label), el("code", "", val));
      list.append(item);
    }
  }

  function createIconNode(iconName) {
    const span = el("span", "btn-icon");
    span.innerHTML = SVG_ICONS[iconName] || SVG_ICONS.activity;
    return span;
  }

  // ==========================================================================
  // Data Loading & Server-Sent Events (SSE)
  // ==========================================================================

  async function loadDashboard() {
    if (state.loading) return;
    state.loading = true;
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load relay data`);
      const data = await res.json();
      render(data);
    } catch (err) {
      console.error("Dashboard poll error:", err);
      const connCard = document.getElementById("connection-card");
      const connLabel = document.getElementById("connection-label");
      if (connCard) {
        connCard.classList.remove("connected");
        connCard.classList.add("error");
      }
      if (connLabel) connLabel.textContent = "Sync error";
    } finally {
      state.loading = false;
    }
  }

  // SSE Stream Listener
  const eventSource = new EventSource("/api/events");
  const sseEvents = ["room.activity", "approvals.changed", "agent.activity", "dashboard.invalidate"];
  for (const name of sseEvents) {
    eventSource.addEventListener(name, () => void loadDashboard());
  }

  eventSource.onopen = () => {
    const connCard = document.getElementById("connection-card");
    const connLabel = document.getElementById("connection-label");
    if (connCard) connCard.classList.add("connected");
    if (connLabel) connLabel.textContent = "Relay online";
  };

  eventSource.onerror = () => {
    const connCard = document.getElementById("connection-card");
    const connLabel = document.getElementById("connection-label");
    if (connCard) connCard.classList.remove("connected");
    if (connLabel) connLabel.textContent = "Reconnecting…";
  };

  // Initial Boot
  void loadDashboard();
  setInterval(() => void loadDashboard(), 10000);
})();
