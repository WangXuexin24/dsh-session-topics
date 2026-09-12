/**
 * dsh-session-topics — client half.
 *
 * Adds a TOPIC layer to the sidebar so sessions can be grouped by subject,
 * which the official browser cannot do: official grouping is by Workspace, and
 * Workspace membership is derived from each session's recorded `cwd`, so every
 * session started in one directory lands in one group forever.
 *
 * Model (v2)
 * ----------
 * Topics are WORKSPACE-SCOPED. A topic belongs to exactly one Workspace, so a
 * session can never be filed outside the Workspace that owns it. Two reasons:
 *
 *  1. It matches the host's own model. The Workspace registry guarantees one
 *     session belongs to one workspace, and `insertSessionBefore` orders
 *     sessions per workspace; a cross-workspace topic would silently break both
 *     readings.
 *  2. It keeps the workspace legible. If every session could migrate into a
 *     global topic, the workspace sections would empty out and the user would
 *     lose the answer to "which project is this from?".
 *
 * Topics nest one level (`parentId`), giving topic → sub-topic. The data model
 * is recursive; only the UI is capped, by MAX_TOPIC_DEPTH.
 *
 * Design constraints (deliberate)
 * -------------------------------
 * - CLIENT ONLY. Grouping is a view concern; state is persisted by the
 *   browser-side store (`defineStore({ persist })`), so the host half stays an
 *   empty shell and nothing here can stall `dsh web` startup.
 * - No destructive capability: no session deletion, no subprocess, no script
 *   generation. Only the RPCs the official browser already calls are used.
 * - Never writes the official `dsh.workspace.view.v*` store key.
 * - Never depends on an action's RETURN VALUE: a store implementation is free
 *   not to surface one (Redux-style), so every mutation that must be atomic is
 *   a single action.
 *
 * Shell layout contract (learned from the official ui-workspace bundle):
 * the shell hands the occupant a region that is `flex:1 1 0%; min-height:0;
 * overflow:hidden`, and the occupant must be a `flex:1; min-height:0` column
 * with its OWN inner `overflow-y:auto` scroller. Without that the content is
 * clipped at the region's height and cannot be scrolled — the sidebar looks
 * frozen even though the JS thread is perfectly healthy.
 *
 * Loader contract: this file is a pre-bundled browser artifact in the
 * `window.__ModuleLoader__` format; `require()` resolves platform modules.
 *
 * @module dsh-session-topics/client
 */

window.__ModuleLoader__.load({
  id: "dsh-session-topics",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { defineStore } = require("@deepseek-ai/dsh-client-store");

    const h = react.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = react;

    /** Locale namespace owned by this plugin. */
    const NS = "sessionTopics";

    /** How many topic levels the UI renders and allows (1 = flat topics). */
    const MAX_TOPIC_DEPTH = 2;

    /** Persisted-state key. v2 is a breaking schema change from v1 (global topics). */
    const PERSIST_KEY = "dsh.session.topics.v2";

    /**
     * Rolling backup of the last non-empty grouping.
     *
     * The grouping is the user's own work, so it gets a second copy: a future
     * bug in a maintenance pass must not be able to destroy it silently. This
     * exists because one already did.
     */
    const BACKUP_KEY = "dsh.session.topics.v2.bak";

    /** Expansion keys are namespaced so topic ids and workspace ids cannot collide. */
    const wsKey = (workspaceId) => "ws:" + String(workspaceId);

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      "section.title": "会话",
      "action.newTopic": "新建话题",
      "action.newTopic.hint": "在这个工作区里新建话题",
      "action.newSubtopic": "新建子话题",
      "action.newSubtopic.hint": "在这个话题下新建子话题",
      "topic.untitled": "新话题",
      "topic.loose": "未归话题",
      "topic.empty": "把会话拖到这里",
      "topic.rename": "重命名",
      "topic.delete": "删除话题",
      "topic.delete.hint": "连同子话题一起删除；会话回到「未归话题」，会话本身不受影响",
      "empty.sessions": "暂无会话",
      "rail.sessions": "会话话题",
      "other.title": "其他",
      "session.rename": "重命名会话",
      "session.fork": "分叉会话",
      "session.archive": "归档会话",
      "session.unfile": "移出话题",
      "workspace.rename": "重命名工作区",
      "workspace.delete": "删除工作区",
      "workspace.delete.confirm": "将把「{name}」从工作区列表中移除。文件夹与会话记录会保留。确定删除吗？",
      "time.justNow": "刚刚",
      "time.minutes": "{n} 分钟前",
      "time.hours": "{n} 小时前",
      "time.days": "{n} 天前",
      "time.months": "{n} 个月前",
      "time.years": "{n} 年前",
      "recover.text": "分组不见了？上次存有 {n} 个话题。",
      "recover.action": "恢复",
      "recover.dismiss": "忽略",
    };

    /** English dictionary. */
    const en = {
      "section.title": "Sessions",
      "action.newTopic": "New topic",
      "action.newTopic.hint": "Create a topic in this workspace",
      "action.newSubtopic": "New sub-topic",
      "action.newSubtopic.hint": "Create a sub-topic under this topic",
      "topic.untitled": "New topic",
      "topic.loose": "No topic",
      "topic.empty": "Drag sessions here",
      "topic.rename": "Rename",
      "topic.delete": "Delete topic",
      "topic.delete.hint": "Removes this topic and its sub-topics; sessions return to \"No topic\" and are never touched",
      "empty.sessions": "No sessions",
      "rail.sessions": "Session topics",
      "other.title": "Other",
      "session.rename": "Rename session",
      "session.fork": "Fork session",
      "session.archive": "Archive session",
      "session.unfile": "Remove from topic",
      "workspace.rename": "Rename workspace",
      "workspace.delete": "Delete workspace",
      "workspace.delete.confirm": "This removes \"{name}\" from the workspace list. Its folder and session logs are kept. Delete it?",
      "time.justNow": "just now",
      "time.minutes": "{n} min ago",
      "time.hours": "{n} h ago",
      "time.days": "{n} d ago",
      "time.months": "{n} mo ago",
      "time.years": "{n} y ago",
      "recover.text": "Grouping is empty. The last backup held {n} topics.",
      "recover.action": "Restore",
      "recover.dismiss": "Dismiss",
    };

    /** Custom MIME type carrying the dragged session id. */
    const DND_SESSION = "application/x-dsh-session-topic";

    // ---------------------------------------------------------------------
    // Store: workspace-scoped topics + assignment + expansion.
    // ---------------------------------------------------------------------

    let topicSeq = 0;

    /** Mint a collision-resistant topic id. */
    function mintTopicId() {
      topicSeq += 1;
      return "st" + Date.now().toString(36) + "-" + topicSeq.toString(36);
    }

    /** Normalize a stored topic list, dropping malformed entries. */
    function readTopics(value) {
      if (!Array.isArray(value)) return [];
      const out = [];
      for (const topic of value) {
        if (topic === null || typeof topic !== "object") continue;
        if (typeof topic.id !== "string" || topic.id === "") continue;
        if (typeof topic.workspaceId !== "string" || topic.workspaceId === "") continue;
        out.push({
          id: topic.id,
          workspaceId: topic.workspaceId,
          parentId: typeof topic.parentId === "string" && topic.parentId !== "" ? topic.parentId : null,
          name: typeof topic.name === "string" ? topic.name : "",
        });
      }
      return out;
    }

    /** Append a topic under an optional parent and expand the branch above it. */
    function createTopicImpl(state, workspaceId, parentId, name) {
      const id = mintTopicId();
      const title = typeof name === "string" && name.trim() !== "" ? name.trim() : "";
      const parent = typeof parentId === "string" && parentId !== "" ? parentId : null;
      state.topics = [...readTopics(state.topics), { id, workspaceId: String(workspaceId), parentId: parent, name: title }];
      const nextExpanded = { ...state.expanded, [wsKey(workspaceId)]: true, [id]: true };
      if (parent !== null) nextExpanded[parent] = true;
      state.expanded = nextExpanded;
    }

    /** Rename one topic. */
    function renameTopicImpl(state, id, name) {
      const title = typeof name === "string" ? name.trim() : "";
      state.topics = readTopics(state.topics).map((topic) => (topic.id === id ? { ...topic, name: title } : topic));
    }

    /**
     * Create a topic AND file the given sessions into it, in ONE state write.
     *
     * Deliberately atomic: chaining `createTopic()` into `assignSession()` would
     * require reading the new id back out of the first action, and a store is
     * free not to return action values. Relying on that return would silently
     * file nothing at all.
     */
    function createTopicWithSessionsImpl(state, workspaceId, parentId, sessionIds) {
      createTopicImpl(state, workspaceId, parentId, "");
      const created = state.topics[state.topics.length - 1];
      const next = { ...state.assignments };
      for (const sessionId of sessionIds) next[sessionId] = created.id;
      state.assignments = next;
    }

    /** Collect a topic id together with every descendant id. */
    function subtreeIds(topics, rootId) {
      const ids = [rootId];
      const seen = new Set(ids);
      for (let i = 0; i < ids.length; i += 1) {
        for (const topic of topics) {
          if (topic.parentId === ids[i] && !seen.has(topic.id)) {
            seen.add(topic.id);
            ids.push(topic.id);
          }
        }
      }
      return ids;
    }

    /** Remove a topic and its whole subtree. Its sessions fall back to loose. */
    function deleteTopicImpl(state, id) {
      const topics = readTopics(state.topics);
      const doomed = new Set(subtreeIds(topics, id));
      state.topics = topics.filter((topic) => !doomed.has(topic.id));
      const nextAssignments = {};
      for (const [sessionId, topicId] of Object.entries(state.assignments)) {
        if (!doomed.has(topicId)) nextAssignments[sessionId] = topicId;
      }
      state.assignments = nextAssignments;
      const nextExpanded = { ...state.expanded };
      for (const topicId of doomed) delete nextExpanded[topicId];
      state.expanded = nextExpanded;
    }

    /** File one session under a topic, or clear it with `null` to send it back to loose. */
    function assignSessionImpl(state, sessionId, topicId) {
      const next = { ...state.assignments };
      const exists = readTopics(state.topics).some((topic) => topic.id === topicId);
      if (topicId === null || topicId === undefined || !exists) delete next[sessionId];
      else next[sessionId] = topicId;
      state.assignments = next;
    }

    /**
     * Collapse writes `false` and keeps the key; only an absent key means
     * "never touched" (so auto-expand never fights a deliberate collapse).
     */
    function setExpandedImpl(state, key, expanded) {
      state.expanded = { ...state.expanded, [key]: expanded };
    }

    /**
     * Drop assignments for sessions/topics that no longer exist, and topics
     * whose workspace is gone. Keeps the persisted map from accumulating
     * invisible orphans across renames and deletions.
     */
    function retainImpl(state, liveSessionIds, liveTopicIds, liveWorkspaceIds) {
      const sessions = new Set(liveSessionIds);
      const topics = new Set(liveTopicIds);
      const workspaces = new Set(liveWorkspaceIds);

      /**
       * FAIL SAFE. This function is a garbage collector, so its only licence is
       * to remove what it can PROVE is dead. An empty comparison set means "the
       * caller has not loaded this yet", not "everything is gone".
       *
       * Conflating the two is exactly what wiped every folder on every refresh:
       * a boot-window call arrived with no workspaces and the whole topic map
       * was declared orphaned. Never make a destructive pass without positive
       * evidence.
       */
      if (workspaces.size === 0) return;

      const currentTopics = readTopics(state.topics);
      const keptTopics = currentTopics.filter(
        (topic) => topics.has(topic.id) && workspaces.has(topic.workspaceId),
      );
      if (keptTopics.length !== currentTopics.length) state.topics = keptTopics;

      // Same rule for session-scoped state: no session list means no evidence.
      if (sessions.size === 0) return;

      const keptIds = new Set(keptTopics.map((topic) => topic.id));
      const current = state.assignments === undefined ? {} : state.assignments;
      const nextAssignments = {};
      let changed = false;
      for (const [sessionId, topicId] of Object.entries(current)) {
        if (sessions.has(sessionId) && keptIds.has(topicId)) nextAssignments[sessionId] = topicId;
        else changed = true;
      }
      if (changed) state.assignments = nextAssignments;

      // Expansion keys are addresses too: a deleted topic or workspace would
      // otherwise leave a dead key in the persisted blob forever.
      const stored = state.expanded === undefined ? {} : state.expanded;
      const nextExpanded = {};
      let expandedChanged = false;
      for (const [key, value] of Object.entries(stored)) {
        const workspaceScoped = key.slice(0, 3) === "ws:";
        const alive = workspaceScoped ? workspaces.has(key.slice(3)) : keptIds.has(key);
        if (alive) nextExpanded[key] = value;
        else expandedChanged = true;
      }
      if (expandedChanged) state.expanded = nextExpanded;
    }

    /** Replace the whole grouping from a backup snapshot, after a loss. */
    function restoreImpl(state, snapshot) {
      state.topics = readTopics(snapshot === null || snapshot === undefined ? [] : snapshot.topics);
      state.assignments = snapshot !== null && snapshot !== undefined
        && typeof snapshot.assignments === "object" && snapshot.assignments !== null
        ? { ...snapshot.assignments }
        : {};
      state.expanded = snapshot !== null && snapshot !== undefined
        && typeof snapshot.expanded === "object" && snapshot.expanded !== null
        ? { ...snapshot.expanded }
        : {};
    }

    /** Create the topics store handle (identity is per-registration, never module level). */
    function createTopicsStore() {
      return defineStore({
        init: () => ({ topics: [], assignments: {}, expanded: {} }),
        persist: PERSIST_KEY,
        actions: {
          createTopic: createTopicImpl,
          createTopicWithSessions: createTopicWithSessionsImpl,
          renameTopic: renameTopicImpl,
          deleteTopic: deleteTopicImpl,
          assignSession: assignSessionImpl,
          setExpanded: setExpandedImpl,
          retain: retainImpl,
          restore: restoreImpl,
        },
      });
    }

    // ---------------------------------------------------------------------
    // Styles — injected once per fiber, removed on dispose.
    // Sizing follows the official browser (14px row titles, 8px radius, the
    // label aliases) and honours the shell scroll contract documented above.
    // ---------------------------------------------------------------------

    const ELEVATED = "var(--dsw-alias-button-elevated-fill,color-mix(in srgb,currentColor 10%,transparent))";
    const BORDER = "var(--dsw-alias-border-secondary,color-mix(in srgb,currentColor 16%,transparent))";
    const LABEL = "var(--dsw-alias-label-primary,inherit)";
    const LABEL_DIM = "var(--dsw-alias-label-tertiary,inherit)";

    const CSS = [
      // Root fills the region the shell hands us; .dst-list scrolls inside it.
      ".dst-root{box-sizing:border-box;display:flex;flex-direction:column;flex:1;min-height:0;padding-right:8px}",
      ".dst-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:2px 0 2px 4px;min-width:0;flex:none}",
      ".dst-head-title{font-size:12px;line-height:20px;font-weight:600;letter-spacing:.02em;color:" + LABEL_DIM + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dst-btn{display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:" + LABEL_DIM + ";font:inherit;font-size:12px;line-height:20px;cursor:pointer;padding:0 5px;border-radius:6px;white-space:nowrap;flex:none}",
      ".dst-btn:hover{color:" + LABEL + ";background:" + ELEVATED + "}",
      // The one scroller. flex:1 + min-height:0 is what makes overflow-y work.
      ".dst-list{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto;padding-bottom:16px;scrollbar-gutter:stable}",
      ".dst-row{display:flex;align-items:center;gap:6px;min-width:0;min-height:28px;padding:0 4px 0 8px;border-radius:8px;cursor:pointer;user-select:none;color:" + LABEL + ";position:relative}",
      ".dst-row:hover{background:" + ELEVATED + "}",
      ".dst-row.is-current{background:" + ELEVATED + "}",
      ".dst-caret{flex:none;width:12px;text-align:center;opacity:.55;font-size:9px;line-height:1;user-select:none}",
      ".dst-row-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px}",
      ".dst-row-count{flex:none;font-size:12px;line-height:20px;color:" + LABEL_DIM + "}",
      ".dst-row-time{flex:none;font-size:12px;line-height:20px;color:" + LABEL_DIM + ";white-space:nowrap}",
      // Insertion indicator for drag-reorder: a line on the half being targeted.
      ".dst-drop-before{box-shadow:inset 0 2px 0 0 var(--dsw-alias-state-business-primary,currentColor)}",
      ".dst-drop-after{box-shadow:inset 0 -2px 0 0 var(--dsw-alias-state-business-primary,currentColor)}",
      ".dst-ws-head{font-weight:600}",
      ".dst-topic-head .dst-row-label{font-weight:400}",
      // Row actions stay out of the way until the row is hovered or focused.
      ".dst-actions{display:flex;align-items:center;gap:1px;flex:none;opacity:0;transition:opacity .12s var(--ds-ease-in-out,linear)}",
      ".dst-row:hover .dst-actions,.dst-row:focus-within .dst-actions{opacity:1}",
      ".dst-kids{display:flex;flex-direction:column;gap:1px;margin-left:10px;padding-left:6px;border-left:1px solid " + BORDER + "}",
      ".dst-drop{box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,currentColor) inset}",
      ".dst-empty{font-size:12px;line-height:20px;color:" + LABEL_DIM + ";padding:0 8px 2px;font-style:italic}",
      // Recovery bar: shown only when the grouping is empty but a backup exists.
      ".dst-recover{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:6px 8px;margin:0 0 6px;border-radius:8px;border:1px solid " + BORDER + ";background:" + ELEVATED + "}",
      ".dst-input{border:.5px solid " + BORDER + ";background:" + ELEVATED + ";color:inherit;font:inherit;font-size:14px;line-height:20px;border-radius:4px;padding:0 2px;min-width:0;width:100%;outline:none}",
      // Right-click menu: fixed at the pointer, above the sidebar's own content.
      ".dst-menu{position:fixed;z-index:60;min-width:140px;max-height:calc(100vh - 16px);overflow-y:auto;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-elevated,Canvas);border:1px solid " + BORDER + ";box-shadow:0 8px 24px rgba(0,0,0,.22);display:flex;flex-direction:column;gap:1px}",
      ".dst-menu-title{font-size:12px;line-height:20px;color:" + LABEL_DIM + ";padding:2px 8px 4px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dst-menu-item{border:0;background:transparent;color:" + LABEL + ";font:inherit;font-size:13px;line-height:20px;text-align:left;padding:4px 8px;border-radius:6px;cursor:pointer;white-space:nowrap}",
      ".dst-menu-item:hover{background:" + ELEVATED + "}",
      ".dst-menu-sep{height:1px;margin:3px 4px;background:" + BORDER + "}",
    ].join("");

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /** Whether a session row should be listed: real rows only, plus the current blank draft. */
    function isListable(summary, currentId, archivedIds) {
      if (summary === undefined) return false;
      // Subagent-origin sessions are hidden by the shared sidebar projection.
      // `origin` is the ONLY correct discriminator here. `parentId` is fork
      // LINEAGE, not subagent parentage: a forked session is an ordinary
      // session that happens to remember its source, and filtering on
      // `parentId` silently hides every fork — the child looks like it
      // vanished after the user forks.
      if (summary.origin === "subagent") return false;
      // Archived sessions keep their accounting slot but leave every grouping surface.
      if (archivedIds.has(summary.id)) return false;
      // A blank session shows only while it is the selected draft.
      if (summary.blank && summary.id !== currentId) return false;
      return true;
    }

    /**
     * Human-facing age of a session ("5 分钟前", "3 天前"). The official browser
     * shows this on every row; dropping it left the list undatable.
     * @param now - Reference timestamp in ms.
     * @param then - The session's `updatedAt` in ms.
     * @param t - Locale lookup.
     * @returns the localized relative time, or an empty string when unknown.
     */
    function formatRelative(now, then, t) {
      if (typeof then !== "number" || !isFinite(then)) return "";
      const delta = now - then;
      // A clock skew that puts the session in the future reads as "just now".
      if (delta < 60000) return t("time.justNow");
      const minutes = Math.floor(delta / 60000);
      if (minutes < 60) return t("time.minutes").replace("{n}", String(minutes));
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t("time.hours").replace("{n}", String(hours));
      const days = Math.floor(hours / 24);
      if (days < 30) return t("time.days").replace("{n}", String(days));
      const months = Math.floor(days / 30);
      if (months < 12) return t("time.months").replace("{n}", String(months));
      return t("time.years").replace("{n}", String(Math.floor(months / 12)));
    }

    /**
     * Render a session row.
     *
     * Carries the session actions the official browser exposed and that a
     * shadowing browser MUST keep working: rename (inline), fork and archive
     * (right-click menu). Dropping the official row wholesale would silently
     * remove them — the caller owns that regression, not the user.
     */
    function SessionRow(props) {
      const {
        summary, current, renaming, now, onOpen, onReorder, onDragStateChange,
        onMenu, onRenameCommit, onRenameCancel, t,
      } = props;
      /** Which half of the row a drag is hovering: null | 'before' | 'after'. */
      const [dropHalf, setDropHalf] = useState(null);
      const [draft, setDraft] = useState(summary.displayTitle === undefined ? "" : summary.displayTitle);
      const inputRef = useRef(null);
      const label = summary.displayTitle !== undefined && summary.displayTitle !== ""
        ? summary.displayTitle
        : String(summary.id);
      const age = formatRelative(now, summary.updatedAt, t);

      useEffect(() => {
        if (renaming && inputRef.current !== null && inputRef.current.focus !== undefined) {
          inputRef.current.focus();
          if (inputRef.current.select !== undefined) inputRef.current.select();
        }
      }, [renaming]);

      return h(
        "div",
        {
          className: "dst-row dst-session"
            + (summary.id === current ? " is-current" : "")
            + (dropHalf === null ? "" : " dst-drop-" + dropHalf),
          draggable: !renaming,
          title: renaming ? undefined : label,
          "data-session-id": String(summary.id),
          onClick: () => { if (!renaming) onOpen(summary.id); },
          onContextMenu: (event) => {
            event.preventDefault();
            onMenu(event, {
              kind: "session",
              id: String(summary.id),
              title: label,
              assigned: props.assigned === true,
            });
          },
          onDragStart: (event) => {
            if (renaming) return;
            event.dataTransfer.setData(DND_SESSION, String(summary.id));
            event.dataTransfer.effectAllowed = "move";
            onDragStateChange(String(summary.id));
          },
          onDragEnd: () => { onDragStateChange(null); setDropHalf(null); },
          onDragOver: (event) => {
            if (!event.dataTransfer.types.includes(DND_SESSION)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            // Which half of the row decides insert-before vs insert-after, so a
            // drag onto a row REORDERS instead of silently creating a folder.
            const node = event.currentTarget;
            let half = "after";
            if (node !== null && node !== undefined && typeof node.getBoundingClientRect === "function") {
              const rect = node.getBoundingClientRect();
              half = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
            }
            setDropHalf(half);
          },
          onDragLeave: () => { setDropHalf(null); },
          onDrop: (event) => {
            const dragged = event.dataTransfer.getData(DND_SESSION);
            const half = dropHalf === null ? "after" : dropHalf;
            setDropHalf(null);
            event.preventDefault();
            event.stopPropagation();
            if (dragged === "" || dragged === String(summary.id)) return;
            onReorder(dragged, String(summary.id), half === "after");
          },
        },
        h("span", { className: "dst-caret" }, summary.running ? "\u25CF" : ""),
        renaming
          ? h("input", {
              ref: inputRef,
              className: "dst-input",
              value: draft,
              onClick: (event) => { event.stopPropagation(); },
              onChange: (event) => { setDraft(event.target.value); },
              onBlur: () => { onRenameCommit(String(summary.id), draft); },
              onKeyDown: (event) => {
                if (event.key === "Enter") { event.preventDefault(); onRenameCommit(String(summary.id), draft); }
                else if (event.key === "Escape") { event.preventDefault(); onRenameCancel(); }
              },
            })
          : h("span", { className: "dst-row-label" }, label),
        !renaming && age !== "" && h("span", { className: "dst-row-time" }, age),
      );
    }

    /**
     * Small right-click menu. Rendered at the pointer inside the sidebar's
     * stacking context, and dismissed by any outside press or Escape.
     * @param props - menu position, items and dismissal callback.
     * @returns the menu element tree.
     */
    function ContextMenu(props) {
      const { menu, onDismiss } = props;
      const menuRef = useRef(null);

      useEffect(() => {
        /**
         * Dismiss on any press OUTSIDE the menu.
         *
         * The listener is capture-phase so it wins against row handlers. That
         * is exactly why containment must be checked explicitly: a capture
         * listener also sees presses INSIDE the menu, and dismissing there
         * unmounts the item before its `click` can ever land — every menu item
         * silently becomes decoration. `stopPropagation` from a bubble-phase
         * React handler cannot help, because capture runs first.
         */
        const onDown = (event) => {
          const node = menuRef.current;
          const target = event === null || event === undefined ? null : event.target;
          if (node !== null && node !== undefined && target !== null && target !== undefined
            && typeof node.contains === "function" && node.contains(target) === true) return;
          onDismiss();
        };
        const onKey = (event) => { if (event.key === "Escape") onDismiss(); };
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        return () => {
          document.removeEventListener("mousedown", onDown, true);
          document.removeEventListener("keydown", onKey, true);
        };
      }, [onDismiss]);

      /**
       * Keep the menu inside the viewport.
       *
       * Placed at the raw cursor position, a right-click near the bottom edge
       * pushes the trailing items past the viewport — the menu looks correct
       * but its last entries (Archive, Delete) become physically unclickable.
       * Measured after mount and clamped, rather than guessed before render.
       */
      useEffect(() => {
        const node = menuRef.current;
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== "function") return;
        const rect = node.getBoundingClientRect();
        const pad = 8;
        const viewportW = typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : rect.right;
        const viewportH = typeof window !== "undefined" && window.innerHeight > 0 ? window.innerHeight : rect.bottom;
        const left = Math.max(pad, Math.min(menu.x, viewportW - rect.width - pad));
        const top = Math.max(pad, Math.min(menu.y, viewportH - rect.height - pad));
        if (node.style !== undefined && node.style !== null) {
          node.style.left = left + "px";
          node.style.top = top + "px";
        }
      }, [menu]);

      const items = menu.items.filter((item) => item !== null);
      if (items.length === 0) return null;

      return h(
        "div",
        {
          ref: menuRef,
          className: "dst-menu",
          style: { left: menu.x + "px", top: menu.y + "px" },
          onContextMenu: (event) => { event.preventDefault(); },
        },
        h("div", { className: "dst-menu-title", title: menu.title }, menu.title),
        items.map((item, index) => (item.separator === true
          ? h("div", { key: "sep" + String(index), className: "dst-menu-sep" })
          : h("button", {
              key: item.label,
              className: "dst-menu-item",
              onClick: () => { onDismiss(); item.run(); },
            }, item.label))),
      );
    }

    /**
     * A topic folder (recursive up to MAX_TOPIC_DEPTH) with its sub-topics and
     * member sessions. Always rendered, even with zero members, so "New topic"
     * gives instant feedback instead of appearing to do nothing.
     */
    function TopicFolder(props) {
      const {
        topic, depth, members, childTopics, renderTopic, renderSession, expanded,
        onToggle, onDropOnTopic, onAddSubtopic,
        onRenameTopic, onDeleteTopic, t,
      } = props;
      const [over, setOver] = useState(false);
      // A topic that has no name yet opens straight into rename mode, so both
      // "New topic" and drag-to-create land on a focused input. Deriving this
      // from the name — rather than a passed-around id — keeps the folder
      // independent of whether the store returns action values.
      const [editing, setEditing] = useState(topic.name === "");
      const [draft, setDraft] = useState(topic.name);
      const inputRef = useRef(null);

      useEffect(() => {
        if (editing && inputRef.current !== null && inputRef.current.focus !== undefined) {
          inputRef.current.focus();
        }
      }, [editing]);

      const name = topic.name !== "" ? topic.name : t("topic.untitled");
      const canNest = depth + 1 < MAX_TOPIC_DEPTH;

      /** Commit the inline rename and leave edit mode. */
      const commit = useCallback(() => {
        setEditing(false);
        onRenameTopic(topic.id, draft);
      }, [draft, onRenameTopic, topic.id]);

      const header = h(
        "div",
        {
          className: "dst-row dst-topic-head" + (over ? " dst-drop" : ""),
          title: name,
          "data-topic-id": topic.id,
          onClick: () => { if (!editing) onToggle(topic.id, !expanded); },
          onDragOver: (event) => {
            if (!event.dataTransfer.types.includes(DND_SESSION)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setOver(true);
          },
          onDragLeave: () => { setOver(false); },
          onDrop: (event) => {
            const dragged = event.dataTransfer.getData(DND_SESSION);
            setOver(false);
            event.preventDefault();
            event.stopPropagation();
            if (dragged === "") return;
            onDropOnTopic(dragged, topic.id);
          },
        },
        h("span", { className: "dst-caret" }, expanded ? "\u25BE" : "\u25B8"),
        editing
          ? h("input", {
              ref: inputRef,
              className: "dst-input",
              value: draft,
              placeholder: t("topic.untitled"),
              onClick: (event) => { event.stopPropagation(); },
              onChange: (event) => { setDraft(event.target.value); },
              onBlur: commit,
              onKeyDown: (event) => {
                if (event.key === "Enter") { event.preventDefault(); commit(); }
                else if (event.key === "Escape") { setDraft(topic.name); setEditing(false); }
              },
            })
          : h("span", { className: "dst-row-label" }, name),
        !editing && h("span", { className: "dst-row-count" }, String(members.length)),
        !editing && h(
          "span",
          { className: "dst-actions" },
          canNest && h("button", {
            className: "dst-btn",
            title: t("action.newSubtopic.hint"),
            onClick: (event) => { event.stopPropagation(); onAddSubtopic(topic); },
          }, "+"),
          h("button", {
            className: "dst-btn",
            title: t("topic.rename"),
            onClick: (event) => { event.stopPropagation(); setDraft(topic.name); setEditing(true); },
          }, "\u270E"),
          h("button", {
            className: "dst-btn",
            title: t("topic.delete") + " — " + t("topic.delete.hint"),
            onClick: (event) => { event.stopPropagation(); onDeleteTopic(topic.id); },
          }, "\u00D7"),
        ),
      );

      const kids = expanded
        ? h(
            "div",
            { className: "dst-kids" },
            childTopics.map((child) => renderTopic(child, depth + 1)),
            members.length === 0 && childTopics.length === 0
              ? h("div", { className: "dst-empty" }, t("topic.empty"))
              : members.map((summary) => renderSession(summary, true)),
          )
        : null;

      return h("div", { className: "dst-topic" }, header, kids);
    }

    /** One workspace section: header with its own "new topic" action, then its topics and loose sessions. */
    function WorkspaceSection(props) {
      const {
        workspace, loose, rootTopics, renderTopic, renderSession, expanded,
        onToggleWorkspace, onAddTopic, onUnfile, onMenu, startSession,
        renaming, onRenameWorkspace, onRenameCancel, t,
      } = props;
      const open = expanded[wsKey(workspace.workspaceId)] !== false;
      const [draft, setDraft] = useState(workspace.title);
      const inputRef = useRef(null);

      useEffect(() => {
        if (renaming && inputRef.current !== null && inputRef.current.focus !== undefined) {
          inputRef.current.focus();
          if (inputRef.current.select !== undefined) inputRef.current.select();
        }
      }, [renaming]);

      /** Dropping onto "no topic" pulls the session out of whatever topic held it. */
      const looseDrop = {
        onDragOver: (event) => {
          if (!event.dataTransfer.types.includes(DND_SESSION)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        },
        onDrop: (event) => {
          const dragged = event.dataTransfer.getData(DND_SESSION);
          event.preventDefault();
          event.stopPropagation();
          if (dragged === "") return;
          onUnfile(dragged, String(workspace.workspaceId));
        },
      };

      return h(
        "div",
        null,
        h(
          "div",
          {
            className: "dst-row dst-ws-head",
            title: workspace.path,
            "data-workspace-id": String(workspace.workspaceId),
            onClick: () => { onToggleWorkspace(wsKey(workspace.workspaceId), !open); },
            onContextMenu: (event) => {
              event.preventDefault();
              onMenu(event, {
                kind: "workspace",
                id: String(workspace.workspaceId),
                title: workspace.title,
              });
            },
          },
          h("span", { className: "dst-caret" }, open ? "\u25BE" : "\u25B8"),
          renaming
            ? h("input", {
                ref: inputRef,
                className: "dst-input",
                value: draft,
                onClick: (event) => { event.stopPropagation(); },
                onChange: (event) => { setDraft(event.target.value); },
                onBlur: () => { onRenameWorkspace(String(workspace.workspaceId), draft); },
                onKeyDown: (event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onRenameWorkspace(String(workspace.workspaceId), draft);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setDraft(workspace.title);
                    onRenameCancel();
                  }
                },
              })
            : h("span", { className: "dst-row-label" }, workspace.title),
          h("span", { className: "dst-row-count" }, String(loose.length + rootTopics.reduce((sum, entry) => sum + entry.total, 0))),
          h(
            "span",
            { className: "dst-actions" },
            h("button", {
              className: "dst-btn",
              title: t("action.newTopic.hint"),
              onClick: (event) => { event.stopPropagation(); onAddTopic(workspace.workspaceId); },
            }, "+"),
            h("button", {
              className: "dst-btn",
              title: t("section.title"),
              onClick: (event) => { event.stopPropagation(); startSession(workspace.workspaceId); },
            }, "\u25A1"),
          ),
        ),
        open && h(
          "div",
          { className: "dst-kids" },
          rootTopics.map((entry) => renderTopic(entry.topic, 0)),
          h("div", { key: "__loose__" },
            h("div", {
              className: "dst-row dst-loose-head",
              title: t("session.unfile"),
              ...looseDrop,
            },
            h("span", { className: "dst-caret" }, ""),
            h("span", { className: "dst-row-label" }, t("topic.loose")),
            h("span", { className: "dst-row-count" }, String(loose.length)),
            ),
            loose.length > 0 && h("div", { className: "dst-kids" },
              loose.map((summary) => renderSession(summary, false))),
          ),
        ),
      );
    }

    /**
     * The browsing region occupying `sidebar.workspaces`.
     * @param props - composed slot props (shell share + store + injected actions + locale).
     * @returns the region element tree.
     */
    function TopicsBrowser(props) {
      const {
        wide, expandSidebar, useSessions, useWorkspaces, useStore, actions,
        startSession, open, renameSession, forkSession, archiveSession,
        renameWorkspace, deleteWorkspace, insertSessionBefore, t,
      } = props;

      useEffect(() => {
        const style = document.createElement("style");
        style.setAttribute("data-plugin", "dsh-session-topics");
        style.textContent = CSS;
        document.head.append(style);
        return () => { style.remove(); };
      }, []);

      useEffect(() => {
        const id = setInterval(() => { setNow(Date.now()); }, 60000);
        return () => { clearInterval(id); };
      }, []);

      const workspaces = useWorkspaces((state) => state.items);
      const workspacePhase = useWorkspaces((state) => state.phase);
      const archivedSessionIds = useWorkspaces((state) => state.archivedSessionIds);
      const list = useSessions((state) => state);
      const topics = useStore((state) => state.topics);
      const assignments = useStore((state) => state.assignments);
      const expanded = useStore((state) => state.expanded);

      const [dragging, setDragging] = useState(null);
      /** Open right-click menu: { x, y, title, items } or null. */
      const [menu, setMenu] = useState(null);
      /** Session or workspace currently being renamed inline. */
      const [renamingId, setRenamingId] = useState(null);
      /**
       * Reference clock for the "5 min ago" column. Ticked once a minute so the
       * ages stay honest on a sidebar nobody is touching.
       */
      const [now, setNow] = useState(() => Date.now());

      const current = list !== undefined ? list.current : undefined;
      const archived = useMemo(
        () => new Set(archivedSessionIds === undefined ? [] : archivedSessionIds),
        [archivedSessionIds],
      );

      const ready = workspacePhase === "ready" && list !== undefined && list.phase === "ready";

      /** sessionId -> workspaceId, so a cross-workspace drop can be refused. */
      const workspaceOf = useMemo(() => {
        const map = new Map();
        for (const workspace of workspaces) {
          for (const sessionId of workspace.sessionIds) map.set(String(sessionId), String(workspace.workspaceId));
        }
        return map;
      }, [workspaces]);

      const liveSessionIds = useMemo(() => {
        if (list === undefined || list.byId === undefined) return [];
        return Object.keys(list.byId);
      }, [list]);
      const liveTopicIds = useMemo(() => topics.map((topic) => topic.id), [topics]);
      const liveWorkspaceIds = useMemo(
        () => workspaces.map((workspace) => String(workspace.workspaceId)),
        [workspaces],
      );

      const retainedRef = useRef("");
      useEffect(() => {
        /**
         * Only prune once the host lists have actually arrived.
         *
         * During the boot window the persisted topic map is ALREADY loaded while
         * `workspaces` and `byId` are still empty. Pruning then reads "not
         * loaded yet" as "deleted", concludes every topic belongs to a vanished
         * workspace, and destroys the entire grouping — on every single refresh.
         */
        if (!ready) return;
        // Content-based, so replacing one workspace with another also re-runs
        // the pass (a length-only signature would miss that swap).
        const signature = liveWorkspaceIds.join(",")
          + "|" + liveTopicIds.join(",")
          + "|" + String(liveSessionIds.length);
        if (signature === retainedRef.current) return;
        retainedRef.current = signature;
        actions.retain(liveSessionIds, liveTopicIds, liveWorkspaceIds);
      }, [actions, ready, liveSessionIds, liveTopicIds, liveWorkspaceIds]);

      /**
       * Keep a rolling backup of the last non-empty grouping.
       *
       * The grouping is hand-built by the user and cannot be regenerated, so it
       * gets a second copy. Best-effort by design: private mode or a quota error
       * must never break rendering.
       */
      useEffect(() => {
        if (topics.length === 0) return;
        try {
          const payload = JSON.stringify({ topics, assignments, expanded });
          if (window.localStorage.getItem(BACKUP_KEY) !== payload) {
            window.localStorage.setItem(BACKUP_KEY, payload);
          }
        } catch (error) {
          // Storage unavailable — the live copy in the store is still correct.
        }
      }, [assignments, expanded, topics]);

      /** Backup snapshot, read once per mount, offered only when the map is empty. */
      const [backup] = useState(() => {
        try {
          const raw = window.localStorage.getItem(BACKUP_KEY);
          if (raw === null || raw === "") return null;
          const parsed = JSON.parse(raw);
          return parsed !== null && typeof parsed === "object" && Array.isArray(parsed.topics) ? parsed : null;
        } catch (error) {
          return null;
        }
      });
      const [recoverDismissed, setRecoverDismissed] = useState(false);
      const canRecover = topics.length === 0
        && recoverDismissed === false
        && backup !== null
        && backup.topics.length > 0;

      /** Summaries of one workspace in host accounting order, filtered for display. */
      const summariesOf = useCallback((workspace) => {
        if (!ready) return [];
        const out = [];
        for (const sessionId of workspace.sessionIds) {
          const summary = list.byId[sessionId];
          if (isListable(summary, current, archived)) out.push(summary);
        }
        return out;
      }, [archived, current, list, ready]);

      /** Topics of one workspace, in store order, plus a parent -> children index. */
      const topicsOf = useMemo(() => (workspaceId) => {
        const own = topics.filter((topic) => topic.workspaceId === String(workspaceId));
        const byParent = new Map();
        const ids = new Set(own.map((topic) => topic.id));
        for (const topic of own) {
          // A parent that does not exist in this workspace makes the child a root.
          const parent = topic.parentId !== null && ids.has(topic.parentId) ? topic.parentId : null;
          if (!byParent.has(parent)) byParent.set(parent, []);
          byParent.get(parent).push(topic);
        }
        return byParent;
      }, [topics]);

      /** File a session under a topic, refusing a cross-workspace move. */
      const onDropOnTopic = useCallback((sessionId, topicId) => {
        const topic = topics.find((entry) => entry.id === topicId);
        if (topic === undefined) return;
        if (workspaceOf.get(String(sessionId)) !== topic.workspaceId) return;
        actions.assignSession(sessionId, topicId);
        actions.setExpanded(topicId, true);
      }, [actions, topics, workspaceOf]);

      /**
       * Drag a session onto another session: REORDER, not group.
       *
       * Dropping a row on a row is the official browser's reorder gesture, and
       * it must stay that way. Conflating it with "make a folder" stole a
       * gesture the user already had, and made the two ideas impossible to tell
       * apart. Grouping is now explicit: drop on a topic header, or use "+".
       *
       * @param draggedId - Session being moved.
       * @param targetId - Session it was dropped on.
       * @param after - True to land below the target, false to land above it.
       */
      const onReorder = useCallback((draggedId, targetId, after) => {
        const draggedWorkspace = workspaceOf.get(String(draggedId));
        const targetWorkspace = workspaceOf.get(String(targetId));
        // Reordering across workspaces is refused: the host orders per workspace.
        if (draggedWorkspace === undefined || draggedWorkspace !== targetWorkspace) return;
        if (String(draggedId) === String(targetId)) return;
        const workspace = workspaces.find((entry) => String(entry.workspaceId) === targetWorkspace);
        const order = workspace === undefined ? [] : workspace.sessionIds.map(String);
        let anchor = String(targetId);
        if (after) {
          const index = order.indexOf(String(targetId));
          anchor = index === -1 || index + 1 >= order.length ? undefined : order[index + 1];
          // Dropping just above the dragged row's own next slot is a no-op.
          if (anchor === String(draggedId)) return;
        }
        if (anchor === String(draggedId)) return;
        Promise.resolve(insertSessionBefore(targetWorkspace, String(draggedId), anchor))
          .catch((error) => {
            console.warn("dsh-session-topics: reorder failed", error);
          });
      }, [insertSessionBefore, workspaceOf, workspaces]);

      /** Create an empty topic at the root of a workspace. */
      const onAddTopic = useCallback((workspaceId) => {
        actions.createTopic(workspaceId, null, "");
      }, [actions]);

      /** Create a sub-topic under a topic, if depth allows. */
      const onAddSubtopic = useCallback((topic) => {
        actions.createTopic(topic.workspaceId, topic.id, "");
        actions.setExpanded(topic.id, true);
      }, [actions]);

      /** Pull a session out of its topic, back to the workspace's "no topic" bucket. */
      const onUnfile = useCallback((sessionId, workspaceId) => {
        if (workspaceOf.get(String(sessionId)) !== String(workspaceId)) return;
        actions.assignSession(sessionId, null);
      }, [actions, workspaceOf]);

      /** Rename a session through the host binding, then leave inline edit mode. */
      const onRenameCommit = useCallback((sessionId, title) => {
        setRenamingId(null);
        const next = typeof title === "string" ? title.trim() : "";
        if (next === "") return;
        Promise.resolve(renameSession(sessionId, next)).catch((error) => {
          console.warn("dsh-session-topics: rename session failed", error);
        });
      }, [renameSession]);

      /** Rename a workspace through the host registry, then leave inline edit mode. */
      const onRenameWorkspace = useCallback((workspaceId, title) => {
        setRenamingId(null);
        const next = typeof title === "string" ? title.trim() : "";
        if (next === "") return;
        Promise.resolve(renameWorkspace(workspaceId, next)).catch((error) => {
          console.warn("dsh-session-topics: rename workspace failed", error);
        });
      }, [renameWorkspace]);

      /**
       * Build the right-click menu for a session or a workspace. Every action
       * here existed in the official browser and must keep working, because
       * this browser replaced it.
       */
      const onMenu = useCallback((event, target) => {
        const items = [];
        if (target.kind === "session") {
          items.push({ label: t("session.rename"), run: () => { setRenamingId(target.id); } });
          items.push({ label: t("session.fork"), run: () => { forkSession(target.id); } });
          items.push({ separator: true });
          if (target.assigned === true) {
            items.push({ label: t("session.unfile"), run: () => { actions.assignSession(target.id, null); } });
          }
          items.push({ label: t("session.archive"), run: () => {
            Promise.resolve(archiveSession(target.id)).catch((error) => {
              console.warn("dsh-session-topics: archive session failed", error);
            });
          } });
        } else {
          items.push({ label: t("action.newTopic"), run: () => { actions.createTopic(target.id, null, ""); } });
          items.push({ separator: true });
          items.push({ label: t("workspace.rename"), run: () => { setRenamingId("ws:" + target.id); } });
          items.push({ label: t("workspace.delete"), run: () => {
            if (window.confirm(t("workspace.delete.confirm").replace("{name}", target.title)) !== true) return;
            Promise.resolve(deleteWorkspace(target.id)).catch((error) => {
              console.warn("dsh-session-topics: delete workspace failed", error);
            });
          } });
        }
        setMenu({ x: event.clientX, y: event.clientY, title: target.title, items });
      }, [actions, archiveSession, deleteWorkspace, forkSession, t]);

      /**
       * Render one session row. `assigned` tells the row whether it currently
       * sits inside a topic, which decides if "remove from topic" is offered.
       */
      const renderSession = useCallback((summary, assigned) => h(SessionRow, {
        key: String(summary.id),
        summary,
        current,
        assigned,
        now,
        t,
        renaming: renamingId === String(summary.id),
        onOpen: open,
        onReorder,
        onDragStateChange: setDragging,
        onMenu,
        onRenameCommit,
        onRenameCancel: () => { setRenamingId(null); },
      }), [current, now, onMenu, onRenameCommit, onReorder, open, renamingId, t]);

      /**
       * Render one topic and its subtree. Members are ordered by the parent
       * workspace's host accounting order, so filing a session never reshuffles
       * it relative to how the official browser would show it.
       */
      const renderTopic = useCallback((topic, depth, index, membersOf, childrenOf) => h(TopicFolder, {
        key: topic.id,
        topic,
        depth,
        members: membersOf.get(topic.id) === undefined ? [] : membersOf.get(topic.id),
        childTopics: childrenOf.get(topic.id) === undefined ? [] : childrenOf.get(topic.id),
        renderTopic: (child, childDepth) => renderTopic(child, childDepth, 0, membersOf, childrenOf),
        renderSession,
        expanded: expanded[topic.id] !== false,
        onToggle: (id, next) => { actions.setExpanded(id, next); },
        onDropOnTopic,
        onAddSubtopic,
        onRenameTopic: (id, name) => { actions.renameTopic(id, name); },
        onDeleteTopic: (id) => { actions.deleteTopic(id); },
        t,
      }), [actions, expanded, onAddSubtopic, onDropOnTopic, renderSession, t]);

      if (wide === false) {
        return h("button", {
          className: "dst-btn",
          title: t("rail.sessions"),
          onClick: () => { expandSidebar(); },
        }, "\u25A4");
      }

      if (!ready) {
        return h("div", { className: "dst-root" },
          h("div", { className: "dst-head" }, h("span", { className: "dst-head-title" }, t("section.title"))),
          h("div", { className: "dst-list" }, h("div", { className: "dst-empty" }, t("empty.sessions"))));
      }

      // Sessions no workspace accounts for must stay reachable.
      const strays = [];
      {
        const summaries = summariesOf({ sessionIds: list.ids });
        for (const summary of summaries) {
          if (workspaceOf.get(String(summary.id)) === undefined) strays.push(summary);
        }
      }

      const sections = workspaces.map((workspace) => {
        const summaries = summariesOf(workspace);
        const byParent = topicsOf(workspace.workspaceId);

        /** Direct members of every topic, ordered by host accounting order. */
        const membersOf = new Map();
        for (const summary of summaries) {
          const topicId = assignments[summary.id];
          if (topicId === undefined) continue;
          if (!membersOf.has(topicId)) membersOf.set(topicId, []);
          membersOf.get(topicId).push(summary);
        }

        const loose = summaries.filter((summary) => assignments[summary.id] === undefined);

        /** Direct members plus the whole subtree, for the header count. */
        const totalOf = (topicId, guard) => {
          if (guard > MAX_TOPIC_DEPTH + 2) return 0;
          let total = (membersOf.get(topicId) === undefined ? [] : membersOf.get(topicId)).length;
          for (const child of byParent.get(topicId) === undefined ? [] : byParent.get(topicId)) {
            total += totalOf(child.id, guard + 1);
          }
          return total;
        };

        const rootTopics = (byParent.get(null) === undefined ? [] : byParent.get(null))
          .map((topic) => ({ topic, total: totalOf(topic.id, 0) }));

        // Attach the index maps to the renderer for this workspace's subtree.
        const childIndexOf = new Map();
        for (const [parent, children] of byParent) childIndexOf.set(parent, children);

        return h(WorkspaceSection, {
          key: String(workspace.workspaceId),
          workspace,
          loose,
          rootTopics,
          renderTopic: (topic, depth) => renderTopic(topic, depth, 0, membersOf, childIndexOf),
          renderSession,
          expanded,
          onToggleWorkspace: (key, next) => { actions.setExpanded(key, next); },
          onAddTopic,
          onUnfile,
          onMenu,
          startSession,
          renaming: renamingId === "ws:" + String(workspace.workspaceId),
          onRenameWorkspace,
          onRenameCancel: () => { setRenamingId(null); },
          t,
        });
      });

      return h(
        "div",
        { className: "dst-root" },
        h(
          "div",
          { className: "dst-head" },
          h("span", { className: "dst-head-title" }, t("section.title")),
        ),
        h(
          "div",
          { className: "dst-list" },
          canRecover && h("div", { key: "__recover__", className: "dst-recover" },
            h("span", { className: "dst-row-label", style: { flex: "1 1 100%", fontSize: "12px", lineHeight: "18px" } },
              t("recover.text").replace("{n}", String(backup.topics.length))),
            h("button", {
              className: "dst-btn",
              onClick: () => { actions.restore(backup); },
            }, t("recover.action")),
            h("button", {
              className: "dst-btn",
              onClick: () => { setRecoverDismissed(true); },
            }, t("recover.dismiss")),
          ),
          sections,
          strays.length > 0 && h("div", { key: "__strays__" },
            h("div", { className: "dst-head-title", style: { padding: "6px 0 2px 4px" } }, t("other.title")),
            h("div", { className: "dst-kids" }, strays.map((summary) => renderSession(summary, false))),
          ),
        ),
        menu !== null && h(ContextMenu, { menu, onDismiss: () => { setMenu(null); } }),
      );
    }

    /** Required client services (cordis fiber inject). */
    const inject = ["slots", "sessions", "workspaces", "locale"];

    /**
     * Register the topic browser into the sidebar hole.
     *
     * `sidebar.workspaces` is a `single`/`root` slot and the official browser
     * registers at priority 0; the single-slot shadow rule elects the LOWEST
     * priority, so -1 takes the hole. No child slot is declared: the official
     * entry already owns `sidebar.workspaces.directoryFlow`.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-session-topics: dictionaries");

      const injected = () => ({
        startSession: (workspaceId) => {
          if (workspaceId !== undefined) ctx.sessions.create({ workspaceId }).catch(() => {});
        },
        open: (sessionId) => { ctx.sessions.open(sessionId); },
        // Session actions the official browser exposed. This plugin shadows that
        // browser, so it inherits the duty to keep every one of them working.
        renameSession: async (sessionId, title) => {
          const binding = ctx.sessions.binding(sessionId);
          const session = binding === undefined ? undefined : binding.session;
          if (session === undefined) throw new Error("unknown session " + String(sessionId));
          const result = await session.rename(title);
          if (!result.ok) throw new Error(result.error.message);
        },
        forkSession: (sessionId) => {
          ctx.sessions.fork({ sessionId, increaseTitle: true })
            .then((childId) => { ctx.sessions.open(childId); })
            .catch(() => {});
        },
        archiveSession: async (sessionId) => { await ctx.workspaces.archiveSession(sessionId); },
        renameWorkspace: async (workspaceId, title) => { await ctx.workspaces.rename(workspaceId, title); },
        deleteWorkspace: async (workspaceId) => { await ctx.workspaces.delete(workspaceId); },
        // Reorder within a workspace; this is the official drag gesture and it
        // is persisted in the host's session accounting, not in this store.
        insertSessionBefore: async (workspaceId, sessionId, beforeSessionId) => {
          await ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId);
        },
      });

      ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register(
        {
          name: "sidebar.workspaces",
          priority: -1,
          store: createTopicsStore(),
          inject: injected,
          locale: NS,
          registrant: "dsh-session-topics",
        },
        TopicsBrowser,
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
