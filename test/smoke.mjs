/**
 * Offline smoke test for dsh-session-topics' client half.
 *
 * Runs the real `lib/client.js` against stub React / store / slot plumbing so
 * the grouping logic is exercised without a browser. The harness is a
 * miniature React on purpose:
 *
 *   - function components are invoked like the real thing, so the returned tree
 *     is the rendered one and hover/drop handlers are reachable;
 *   - hook state PERSISTS across render passes, keyed by component identity, so
 *     state bugs (a rename box that never opens) actually surface;
 *   - effects honour their dependency list;
 *   - store actions deliberately DO NOT surface return values, modelling a
 *     Redux-style store, so the plugin may never read a value back out of one.
 */
let loaded = null;

// --- stub the browser module loader -------------------------------------
/** Captured from the style element the component injects, for CSS assertions. */
let injectedCss = '';

/** Document-level listeners, so press-outside dismissal can be exercised. */
const docListeners = [];

/** Deliver a synthetic document event to every listener registered for it. */
function fireDocument(type, event) {
  for (const entry of docListeners.slice()) {
    if (entry.type === type) entry.fn(event);
  }
}

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec;
    },
  },
};
globalThis.document = {
  head: { append() {} },
  createElement() {
    return {
      _attrs: {},
      setAttribute(key, value) { this._attrs[key] = value; },
      remove() {},
      set textContent(value) { injectedCss = value; },
      get textContent() { return injectedCss; },
    };
  },
  // Real listener registration: the context menu's dismissal logic is only
  // testable if the harness can actually deliver a document-level press.
  addEventListener(type, fn) { docListeners.push({ type, fn }); },
  removeEventListener(type, fn) {
    const index = docListeners.findIndex((entry) => entry.type === type && entry.fn === fn);
    if (index !== -1) docListeners.splice(index, 1);
  },
};
globalThis.window.confirm = () => true;
globalThis.window.innerWidth = 800;
globalThis.window.innerHeight = 600;

/** In-memory localStorage, so persistence and backup behaviour is testable. */
const storage = new Map();
globalThis.window.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

// The sidebar ticks a 1-minute clock for the relative-time column. Timers are
// stubbed so the harness stays synchronous and the process can exit.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

// Resolve as a file URL: `pathToFileURL(pathname)` would double the drive letter on Windows.
const clientUrl = new URL('../lib/client.js', import.meta.url);
await import(clientUrl.href);

if (loaded === null) throw new Error('module loader was never called');
if (loaded.id !== 'dsh-session-topics') throw new Error('unexpected module id: ' + loaded.id);

// --- miniature React -----------------------------------------------------
const hookStore = new Map();
let cursor = 0;
let currentHooks = null;

/** Give one component instance its own hook slots (nested calls save/restore). */
function renderComponent(fn, props) {
  const identity = fn.name + '|' + (props.key === undefined ? '' : String(props.key));
  let hooks = hookStore.get(identity);
  if (hooks === undefined) {
    hooks = [];
    hookStore.set(identity, hooks);
  }
  const savedCursor = cursor;
  const savedHooks = currentHooks;
  currentHooks = hooks;
  cursor = 0;
  try {
    return fn(props);
  } finally {
    currentHooks = savedHooks;
    cursor = savedCursor;
  }
}

/** Take the next hook slot for the component currently rendering. */
function slot() {
  const index = cursor;
  cursor += 1;
  return index;
}

const react = {
  createElement(type, props, ...children) {
    const element = { type, props: props === null || props === undefined ? {} : props, children: children.flat() };
    if (typeof type === 'function') {
      return { type, props: element.props, children: [renderComponent(type, element.props)] };
    }
    // Emulate React attaching a ref to a host node, and give nodes a
    // `contains` so containment checks behave like the DOM's.
    if (element.props.ref !== undefined && element.props.ref !== null) {
      element.props.ref.current = element;
    }
    element.style = {};
    // A fixed box keeps the menu's viewport clamp deterministic.
    element.getBoundingClientRect = () => ({ top: 0, left: 0, right: 140, bottom: 120, width: 140, height: 120 });
    element.contains = (node) => {
      if (node === element) return true;
      for (const child of element.children) {
        if (child !== null && typeof child === 'object'
          && typeof child.contains === 'function' && child.contains(node) === true) return true;
      }
      return false;
    };
    return element;
  },
  useState(initial) {
    const index = slot();
    // Capture THIS instance's slot array: setters run from event handlers,
    // long after the render pass has restored the module-level cursor.
    const hooks = currentHooks;
    if (!(index in hooks)) {
      hooks[index] = typeof initial === 'function' ? initial() : initial;
    }
    const set = (next) => {
      hooks[index] = typeof next === 'function' ? next(hooks[index]) : next;
    };
    return [hooks[index], set];
  },
  useMemo(fn) {
    slot();
    return fn();
  },
  useCallback(fn) {
    slot();
    return fn;
  },
  useRef(initial) {
    const index = slot();
    const hooks = currentHooks;
    if (!(index in hooks)) hooks[index] = { current: initial };
    return hooks[index];
  },
  useEffect(fn, deps) {
    const index = slot();
    const prev = currentHooks[index];
    const changed = prev === undefined
      || deps === undefined
      || prev.deps.length !== deps.length
      || deps.some((dep, i) => !Object.is(dep, prev.deps[i]));
    currentHooks[index] = { deps: deps === undefined ? [] : deps };
    if (changed) fn();
  },
};

// --- stub store / modules ------------------------------------------------
const storeSpecs = [];

/** Minimal defineStore: real state mutation + bound actions. */
function defineStore(spec) {
  const state = spec.init();
  const actions = {};
  for (const [name, fn] of Object.entries(spec.actions)) {
    // Model a Redux-style store: action RETURN VALUES are deliberately not
    // surfaced. The plugin must never depend on reading a value back out of an
    // action, so the harness must not hand one over either.
    actions[name] = (...args) => { fn(state, ...args); };
  }
  storeSpecs.push({ persist: spec.persist, state });
  return { __state: state, __actions: actions };
}

const moduleExports = loaded.factory((name) => {
  if (name === 'react') return react;
  if (name === '@deepseek-ai/dsh-client-store') return { defineStore };
  throw new Error('unexpected require: ' + name);
});

// --- stub the client root context ---------------------------------------
let registration = null;
const opened = [];
const createdSessions = [];
const ctx = {
  effect() {},
  locale: { register() {} },
  sessions: {
    open: (id) => opened.push(id),
    create: (input) => { createdSessions.push(input); return Promise.resolve('new'); },
  },
  slots: {
    inject(_name, factory) { factory(); },
    register(spec, component) { registration = { spec, component }; },
  },
};

moduleExports.apply(ctx);

if (registration === null) throw new Error('apply() did not register into the slot');
if (registration.spec.name !== 'sidebar.workspaces') throw new Error('registered into the wrong slot');
if (!(registration.spec.priority < 0)) throw new Error('priority must shadow the official 0');

// --- stub data: TWO workspaces, so workspace scoping is testable ---------
const WS_A = 'ws-a';
const WS_B = 'ws-b';

/** Ages are relative to the harness clock so the time buckets are testable. */
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.now();

const sessions = {
  's-a1': { id: 's-a1', displayTitle: '插件审计（一）', blank: false, running: false, updatedAt: T0 - 5 * MIN },
  's-a2': { id: 's-a2', displayTitle: '插件审计（二）', blank: false, running: false, updatedAt: T0 - 3 * DAY },
  's-a3': { id: 's-a3', displayTitle: '无关的甲', blank: false, running: false, updatedAt: T0 - 20000 },
  // A FORK: it has a parentId (lineage) but NO subagent origin, so it must be
  // listed. Filtering on parentId hid every forked session.
  's-fork': { id: 's-fork', displayTitle: '分叉出来的', blank: false, running: false, updatedAt: T0 - 2 * HOUR, parentId: 's-a1' },
  's-sub': { id: 's-sub', displayTitle: '子代理', blank: false, running: false, updatedAt: T0 - 25 * MIN, origin: 'subagent' },
  's-arc': { id: 's-arc', displayTitle: '已归档', blank: false, running: false, updatedAt: T0 - 20 * MIN },
  's-b1': { id: 's-b1', displayTitle: '乙区会话一', blank: false, running: false, updatedAt: T0 - 15 * MIN },
  's-b2': { id: 's-b2', displayTitle: '乙区会话二', blank: false, running: false, updatedAt: T0 - 10 * MIN },
};

const sessionList = {
  ids: Object.keys(sessions),
  byId: sessions,
  current: 's-a3',
  phase: 'ready',
};

const workspaceItems = [
  {
    workspaceId: WS_A,
    path: 'D:\\DSH',
    title: 'DSH',
    sessionIds: ['s-a1', 's-a2', 's-a3', 's-fork', 's-sub', 's-arc'],
    createdAt: '2026-08-15T02:51:19.050Z',
  },
  {
    workspaceId: WS_B,
    path: 'D:\\DSH-plugin',
    title: 'DSH-plugin',
    sessionIds: ['s-b1', 's-b2'],
    createdAt: '2026-09-02T11:55:22.821Z',
  },
];

const store = registration.spec.store;

/** Host RPC calls the browser makes, recorded for assertions. */
const rpc = {
  renameSession: [], forkSession: [], archiveSession: [],
  renameWorkspace: [], deleteWorkspace: [], insertSessionBefore: [],
};

/** Relative-time strings, so the age column can be asserted literally. */
const TIME_KEYS = {
  'time.justNow': '刚刚',
  'time.minutes': '{n} 分钟前',
  'time.hours': '{n} 小时前',
  'time.days': '{n} 天前',
  'time.months': '{n} 个月前',
  'time.years': '{n} 年前',
};

/** Render once with the current store state. */
function render() {
  return renderComponent(registration.component, {
    wide: true,
    expandSidebar() {},
    useSessions: (selector) => selector(sessionList),
    useWorkspaces: (selector) => selector({
      items: workspaceItems,
      phase: 'ready',
      archivedSessionIds: ['s-arc'],
    }),
    useStore: (selector) => selector(store.__state),
    actions: store.__actions,
    startSession(workspaceId) { createdSessions.push(workspaceId); },
    open: (id) => opened.push(id),
    // Session/workspace actions inherited from the official browser.
    renameSession: (id, title) => { rpc.renameSession.push([id, title]); return Promise.resolve(); },
    forkSession: (id) => { rpc.forkSession.push(id); },
    archiveSession: (id) => { rpc.archiveSession.push(id); return Promise.resolve(); },
    renameWorkspace: (id, title) => { rpc.renameWorkspace.push([id, title]); return Promise.resolve(); },
    deleteWorkspace: (id) => { rpc.deleteWorkspace.push(id); return Promise.resolve(); },
    insertSessionBefore: (ws, id, before) => { rpc.insertSessionBefore.push([ws, id, before]); return Promise.resolve(); },
    t: (key) => (TIME_KEYS[key] === undefined ? key : TIME_KEYS[key]),
  });
}

/**
 * Render during the boot window: nothing from the host has arrived yet.
 *
 * This is what the FIRST frames after a page reload look like — the persisted
 * topic map is already in the store, while workspaces and sessions are still
 * `pending`. Any maintenance pass that runs here is comparing against an empty
 * world.
 */
function renderBeforeDataArrives() {
  return renderComponent(registration.component, {
    wide: true,
    expandSidebar() {},
    useSessions: (selector) => selector({ ids: [], byId: {}, current: undefined, phase: 'pending' }),
    useWorkspaces: (selector) => selector({ items: [], phase: 'pending', archivedSessionIds: [] }),
    useStore: (selector) => selector(store.__state),
    actions: store.__actions,
    startSession() {},
    open() {},
    renameSession: () => Promise.resolve(),
    forkSession() {},
    archiveSession: () => Promise.resolve(),
    renameWorkspace: () => Promise.resolve(),
    deleteWorkspace: () => Promise.resolve(),
    insertSessionBefore: () => Promise.resolve(),
    t: (key) => (TIME_KEYS[key] === undefined ? key : TIME_KEYS[key]),
  });
}

/** Collect every rendered text leaf. */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out; }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (typeof node === 'object' && node.children !== undefined) texts(node.children, out);
  return out;
}

/** Depth-first search for the first element matching a predicate. */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  for (const child of node.children === undefined ? [] : node.children) {
    const hit = find(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
}

/** Every element matching a predicate. */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  for (const child of node.children === undefined ? [] : node.children) findAll(child, predicate, out);
  return out;
}

/** A rendered session row (the draggable DOM element) by its title. */
const rowFor = (tree, title) => find(tree, (node) =>
  node.props !== undefined && node.props.draggable === true && node.props.title === title);

/** The rendered topic folder headers. */
const topicHeads = (tree) => findAll(tree, (node) => node.props !== undefined
  && typeof node.props.className === 'string'
  && node.props.className.indexOf('dst-topic-head') !== -1);

/** The rendered workspace sections, by title. */
const sectionFor = (tree, title) => find(tree, (node) =>
  node.props !== undefined && node.props.workspace !== undefined && node.props.workspace.title === title);

/** A synthetic drop event carrying one dragged session id. */
const dropEvent = (sessionId) => ({
  preventDefault() {},
  stopPropagation() {},
  dataTransfer: { getData: () => sessionId, types: ['application/x-dsh-session-topic'] },
});

const fail = [];
const check = (label, ok) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) fail.push(label);
};

// --- module + store contract --------------------------------------------
check('persist key is plugin-owned v2 (never the official view key)',
  storeSpecs[0].persist === 'dsh.session.topics.v2');

// --- first render --------------------------------------------------------
const first = render();
const firstTexts = texts(first);

check('lists session titles from workspace A', firstTexts.includes('插件审计（一）') && firstTexts.includes('无关的甲'));
check('lists session titles from workspace B', firstTexts.includes('乙区会话一'));
check('renders both workspace titles', firstTexts.includes('DSH') && firstTexts.includes('DSH-plugin'));
check('hides subagent-origin sessions', !firstTexts.includes('子代理'));
check('hides archived sessions', !firstTexts.includes('已归档'));

// --- REGRESSION: a FORKED session must be listed -------------------------
// It carries a parentId (lineage) but is an ordinary session. Filtering on
// parentId made forked sessions vanish right after the user forked them.
check('lists a forked session (parentId is lineage, not subagent origin)',
  firstTexts.includes('分叉出来的'));

// --- REGRESSION: the relative-time column --------------------------------
check('shows "just now" for a fresh session', firstTexts.includes('刚刚'));
check('shows minutes for a recent session', firstTexts.includes('5 分钟前'));
check('shows hours for a session from today', firstTexts.includes('2 小时前'));
check('shows days for an older session', firstTexts.includes('3 天前'));
check('shows a loose bucket per workspace',
  firstTexts.filter((text) => text === 'topic.loose').length === 2);
const headerNode = find(first, (node) => node.props !== undefined
  && typeof node.props.className === 'string' && node.props.className === 'dst-head');
check('the header carries no global New-topic button',
  headerNode !== null
  && findAll(headerNode, (node) => node.props !== undefined && node.props.title === 'action.newTopic.hint').length === 0);
check('each workspace row carries its own New-topic button',
  findAll(first, (node) => node.props !== undefined && node.props.title === 'action.newTopic.hint').length === 2);

// --- per-workspace "new topic" ------------------------------------------
const sectionA = sectionFor(first, 'DSH');
check('found workspace A section', sectionA !== null);
sectionA.props.onAddTopic(WS_A);

check('a topic was created in workspace A', store.__state.topics.length === 1);
check('the new topic is owned by workspace A', store.__state.topics[0].workspaceId === WS_A);

const withEmpty = render();
check('an EMPTY topic still renders a folder row', topicHeads(withEmpty).length === 1);
check('the empty folder invites a drop', texts(withEmpty).includes('topic.empty'));
check('a new topic opens its rename box straight away',
  findAll(withEmpty, (n) => n.props !== undefined && n.props.className === 'dst-input').length === 1);

// Name it through the rename box, exercising the real input → commit path.
// NOTE: the harness does not re-render on setState the way React does, so a
// render pass goes between the keystroke and the commit — that is exactly the
// re-render React performs, and the commit closure needs it.
const renameInput = findAll(withEmpty, (n) => n.props !== undefined && n.props.className === 'dst-input')[0];
check('found the rename input', renameInput !== undefined);
renameInput.props.onChange({ target: { value: '插件审计' } });

const afterTyping = render();
const liveInput = findAll(afterTyping, (n) => n.props !== undefined && n.props.className === 'dst-input')[0];
check('the rename box survives the keystroke', liveInput !== undefined);
liveInput.props.onBlur();

const named = render();
check('the committed name is shown on the folder row', texts(named).includes('插件审计'));

// --- dragging a row onto a row REORDERS (it does not make a folder) ------
// The official browser reorders on this gesture. Conflating it with "create a
// topic" stole a gesture the user already had and blurred the boundary
// between ordering and grouping.
store.__actions.deleteTopic(store.__state.topics[0].id);
check('setup: no topics before the reorder checks', store.__state.topics.length === 0);

/** Hover a row's half so the drop lands above or below it. */
const hoverHalf = (title, clientY) => {
  const row = rowFor(render(), title);
  row.props.onDragOver({
    dataTransfer: { types: ['application/x-dsh-session-topic'] },
    clientY,
    currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 28 }) },
    preventDefault() {},
  });
};

// Top half of the third row -> insert BEFORE it. Workspace A order is
// ['s-a1', 's-a2', 's-a3', 's-sub', 's-arc'].
hoverHalf('无关的甲', 2);
rowFor(render(), '无关的甲').props.onDrop(dropEvent('s-a1'));
check('dropping on the top half inserts before the target',
  rpc.insertSessionBefore.length === 1
  && rpc.insertSessionBefore[0][0] === WS_A
  && rpc.insertSessionBefore[0][1] === 's-a1'
  && rpc.insertSessionBefore[0][2] === 's-a3');
check('reordering created no topic', store.__state.topics.length === 0);
check('reordering changed no assignment', Object.keys(store.__state.assignments).length === 0);

// Bottom half -> insert before the target's successor in host order, which is
// 's-fork' (workspace A order: s-a1, s-a2, s-a3, s-fork, s-sub, s-arc).
rpc.insertSessionBefore.length = 0;
hoverHalf('无关的甲', 26);
rowFor(render(), '无关的甲').props.onDrop(dropEvent('s-a1'));
check('dropping on the bottom half inserts after the target',
  rpc.insertSessionBefore.length === 1 && rpc.insertSessionBefore[0][2] === 's-fork');

// --- cross-workspace reorder is refused ---------------------------------
rpc.insertSessionBefore.length = 0;
rowFor(render(), '乙区会话一').props.onDrop(dropEvent('s-a1'));
check('a cross-workspace reorder is refused', rpc.insertSessionBefore.length === 0);

// --- drop onto a topic header still FILES the session -------------------
sectionFor(render(), 'DSH').props.onAddTopic(WS_A);
const topicId = store.__state.topics[0].id;
const head = topicHeads(render())[0];
check('found a topic header to drop on', head !== undefined);
head.props.onDrop(dropEvent('s-a3'));
check('dropping on a header files that session', store.__state.assignments['s-a3'] === topicId);

// Cross-workspace drop onto a header is refused too.
head.props.onDrop(dropEvent('s-b1'));
check('cross-workspace drop on a header is refused', store.__state.assignments['s-b1'] === undefined);

// --- nesting -------------------------------------------------------------
const nestedTree = render();
const nestedSection = sectionFor(nestedTree, 'DSH');
check('found workspace A again', nestedSection !== null);
const topicProp = store.__state.topics[0];
nestedSection.props.renderTopic(topicProp, 0);
// The sub-topic action lives on a depth-0 folder; drive it through props.
const depth0 = find(nestedTree, (n) => n.props !== undefined
  && n.props.topic !== undefined && n.props.depth === 0);
check('a depth-0 folder is rendered', depth0 !== null);
depth0.props.onAddSubtopic(depth0.props.topic);

check('a sub-topic was created', store.__state.topics.length === 2);
const child = store.__state.topics[1];
check('the sub-topic points at its parent', child.parentId === topicProp.id);
check('the sub-topic inherits the workspace', child.workspaceId === WS_A);

const deepTree = render();
const depth1 = find(deepTree, (n) => n.props !== undefined
  && n.props.topic !== undefined && n.props.depth === 1);
check('the sub-topic renders at depth 1', depth1 !== null);

// Commit the pending rename boxes so folder rows expose their action buttons
// (actions are hidden while a row is being renamed).
for (const input of findAll(deepTree, (n) => n.props !== undefined && n.props.className === 'dst-input')) {
  input.props.onBlur();
}
const settled = render();
check('both folders are rendered', topicHeads(settled).length === 2);
check('the depth cap hides the add-subtopic action at depth 1',
  findAll(settled, (n) => n.props !== undefined && n.props.title === 'action.newSubtopic.hint').length === 1);

// --- deleting a topic removes its subtree -------------------------------
store.__actions.deleteTopic(topicProp.id);
check('deleting a parent removed the subtree', store.__state.topics.length === 0);
check('deleting a topic unassigned its sessions', Object.keys(store.__state.assignments).length === 0);
check('the sessions themselves still exist', Object.keys(sessions).length === 8);

const afterDelete = render();
check('sessions returned to the loose bucket', texts(afterDelete).includes('topic.loose'));

// --- opening a session still routes through the official RPC -------------
const openRow = rowFor(afterDelete, '无关的甲');
openRow.props.onClick();
check('clicking a row calls open()', opened.includes('s-a3'));

// --- RESTORED: the official session actions ------------------------------
// This browser SHADOWS the official one, so it inherits the duty to keep every
// official row action working. They were dropped once; these pin them down.
const actionTree = render();
const a1 = find(actionTree, (n) => n.props !== undefined && n.props['data-session-id'] === 's-a1');
check('session row exposes a context-menu handler', a1 !== null && typeof a1.props.onContextMenu === 'function');

const menuEvent = { preventDefault() {}, clientX: 10, clientY: 20 };
const openMenu = () => {
  const row = find(render(), (n) => n.props !== undefined && n.props['data-session-id'] === 's-a1');
  row.props.onContextMenu(menuEvent);
  const tree = render();
  const node = find(tree, (n) => n.props !== undefined && n.props.menu !== undefined);
  return node === null ? [] : node.props.menu.items;
};

const items = openMenu();
const labels = items.filter((i) => i.label !== undefined).map((i) => i.label);
check('right-click opens a menu', items.length > 0);
check('the menu offers rename', labels.indexOf('session.rename') !== -1);
check('the menu offers fork', labels.indexOf('session.fork') !== -1);
check('the menu offers archive', labels.indexOf('session.archive') !== -1);
check('an unfiled session is not offered "remove from topic"', labels.indexOf('session.unfile') === -1);

// Rename must reach an inline editor and commit through the host RPC.
items.find((i) => i.label === 'session.rename').run();
const editing = render();
const renameBox = findAll(editing, (n) => n.props !== undefined && n.props.className === 'dst-input')[0];
check('rename opens an inline editor', renameBox !== undefined);
renameBox.props.onChange({ target: { value: '改过的名字' } });
const retyped = render();
findAll(retyped, (n) => n.props !== undefined && n.props.className === 'dst-input')[0].props.onBlur();
check('rename commits through the host RPC',
  rpc.renameSession.length === 1
  && rpc.renameSession[0][0] === 's-a1'
  && rpc.renameSession[0][1] === '改过的名字');

openMenu().find((i) => i.label === 'session.fork').run();
check('fork routes to the host RPC', rpc.forkSession.indexOf('s-a1') !== -1);

openMenu().find((i) => i.label === 'session.archive').run();
check('archive routes to the host RPC', rpc.archiveSession.indexOf('s-a1') !== -1);

// --- the menu must SURVIVE a press inside it, and act on click -----------
// A capture-phase "press outside dismisses" listener also sees presses INSIDE
// the menu. Dismissing there unmounts the item before its `click` can land, so
// every item silently becomes decoration. Pinned because it shipped once.
openMenu();
const menuEl = find(render(), (n) => n.props !== undefined
  && typeof n.props.className === 'string' && n.props.className === 'dst-menu');
check('the menu element is rendered', menuEl !== undefined);

const archiveItem = find(menuEl, (n) => n.props !== undefined
  && n.props.className === 'dst-menu-item' && n.children[0] === 'session.archive');
check('the archive item is reachable in the menu', archiveItem !== undefined);

const pressInMenu = { target: archiveItem, preventDefault() {}, stopPropagation() {} };
fireDocument('mousedown', pressInMenu);
check('pressing INSIDE the menu keeps it open',
  find(render(), (n) => n.props !== undefined && n.props.menu !== undefined) !== null);

const archivesBefore = rpc.archiveSession.length;
archiveItem.props.onClick();
check('clicking a menu item actually runs its action',
  rpc.archiveSession.length === archivesBefore + 1);

fireDocument('mousedown', { target: { outside: true }, preventDefault() {}, stopPropagation() {} });
check('pressing OUTSIDE dismisses the menu',
  find(render(), (n) => n.props !== undefined && n.props.menu !== undefined) === null);

// --- workspace menu ------------------------------------------------------
const wsHead = find(render(), (n) => n.props !== undefined && n.props['data-workspace-id'] === WS_A);
check('workspace header exposes a context menu', wsHead !== null && typeof wsHead.props.onContextMenu === 'function');
wsHead.props.onContextMenu(menuEvent);
const wsMenu = find(render(), (n) => n.props !== undefined && n.props.menu !== undefined);
const wsLabels = wsMenu.props.menu.items.filter((i) => i.label !== undefined).map((i) => i.label);
check('workspace menu offers rename', wsLabels.indexOf('workspace.rename') !== -1);
check('workspace menu offers delete', wsLabels.indexOf('workspace.delete') !== -1);
check('workspace menu offers a new topic', wsLabels.indexOf('action.newTopic') !== -1);

wsMenu.props.menu.items.find((i) => i.label === 'workspace.delete').run();
check('delete workspace routes to the host RPC', rpc.deleteWorkspace.indexOf(WS_A) !== -1);

// --- RESTORED: drag a session back OUT of its topic ----------------------
// Mis-filing has to be undoable by dragging; that was an explicit requirement.
store.__actions.createTopicWithSessions(WS_A, null, ['s-a1', 's-a2']);
check('setup: two sessions are filed', Object.keys(store.__state.assignments).length === 2);

const looseHeads = (tree) => findAll(tree, (n) => n.props !== undefined
  && typeof n.props.className === 'string' && n.props.className.indexOf('dst-loose-head') !== -1);

const unfiledTree = render();
const headsA = looseHeads(unfiledTree);
check('each workspace renders its own "no topic" bucket', headsA.length === 2);
check('the "no topic" bucket is a drop target', typeof headsA[0].props.onDrop === 'function');

headsA[0].props.onDrop(dropEvent('s-a1'));
check('dropping on "no topic" removes the session from its topic',
  store.__state.assignments['s-a1'] === undefined);
check('the other member stayed filed', store.__state.assignments['s-a2'] !== undefined);

const headsB = looseHeads(render());
const beforeCross = store.__state.assignments['s-a2'];
headsB[1].props.onDrop(dropEvent('s-a2'));
check('a cross-workspace unfiling drop is refused', store.__state.assignments['s-a2'] === beforeCross);

// Leave a known state for the sections below.
store.__actions.deleteTopic(store.__state.topics[0].id);
check('cleanup left no assignments', Object.keys(store.__state.assignments).length === 0);

// --- retain() also sweeps dead expansion keys ---------------------------
store.__actions.setExpanded('st-dead-topic', true);
store.__actions.setExpanded('ws:ws-gone', true);
const liveTopic = store.__actions.createTopic(WS_A, null, '保留');
void liveTopic;
const liveId = store.__state.topics[store.__state.topics.length - 1].id;
store.__actions.setExpanded(liveId, false);
// Force the retain pass to run by changing the live-id signature.
store.__actions.retain(
  Object.keys(sessions),
  store.__state.topics.map((topic) => topic.id),
  [WS_A, WS_B],
);
check('a dead topic expansion key is swept', store.__state.expanded['st-dead-topic'] === undefined);
check('a dead workspace expansion key is swept', store.__state.expanded['ws:ws-gone'] === undefined);
check('a live expansion key is kept', store.__state.expanded[liveId] === false);
store.__actions.deleteTopic(liveId);

// --- REGRESSION: refreshing must NOT wipe the user's folders ------------
// The retained-id pass prunes ids it believes are dead. During the boot window
// the host lists are still empty, so a naive prune reads "not loaded yet" as
// "deleted" and destroys EVERY folder on EVERY refresh. That shipped once and
// cost real work.
store.__state.topics = [{ id: 't-keep', workspaceId: WS_A, parentId: null, name: '别删我' }];
store.__state.assignments = { 's-a1': 't-keep' };
store.__state.expanded = { 't-keep': false };

renderBeforeDataArrives();
check('a boot-window render keeps the topics', store.__state.topics.length === 1);
check('a boot-window render keeps the topic name',
  store.__state.topics.length === 1 && store.__state.topics[0].name === '别删我');
check('a boot-window render keeps the assignments', store.__state.assignments['s-a1'] === 't-keep');
check('a boot-window render keeps the expansion state', store.__state.expanded['t-keep'] === false);

// Once the host data IS there, pruning works normally again.
render();
check('a ready render keeps a live topic', store.__state.topics.length === 1);
store.__actions.retain(['s-a1'], ['t-keep'], [WS_A]);
check('a ready retain keeps a live topic', store.__state.topics.length === 1);
check('a ready retain keeps a live assignment', store.__state.assignments['s-a1'] === 't-keep');

// A topic whose workspace really is gone still gets swept.
store.__state.topics = [
  { id: 't-keep', workspaceId: WS_A, parentId: null, name: '别删我' },
  { id: 't-orphan', workspaceId: 'ws-deleted', parentId: null, name: '孤儿' },
];
store.__actions.retain(['s-a1'], ['t-keep', 't-orphan'], [WS_A]);
check('retain still sweeps a topic whose workspace is gone', store.__state.topics.length === 1);
check('retain kept the right topic', store.__state.topics[0].id === 't-keep');

// Clean up.
store.__state.topics = [];
store.__state.assignments = {};
store.__state.expanded = {};

// --- the rolling backup, and recovery after a loss ----------------------
// The whole point: the grouping is hand-built and cannot be regenerated, so a
// second copy must exist and be discoverable after it goes missing.
store.__actions.createTopic(WS_A, null, '备份用话题');
render();
check('a non-empty grouping is backed up', storage.has('dsh.session.topics.v2.bak'));
check('the backup records the topic count',
  JSON.parse(storage.get('dsh.session.topics.v2.bak')).topics.length === 1);

// Simulate exactly the loss that motivated the mechanism.
store.__state.topics = [];
store.__state.assignments = {};
store.__state.expanded = {};

// A FRESH mount (what a page reload does) sees an empty map plus a backup.
hookStore.delete('TopicsBrowser|');
const recovered = render();
const recoverBar = find(recovered, (n) => n.props !== undefined
  && typeof n.props.className === 'string' && n.props.className === 'dst-recover');
check('an empty map with a backup offers recovery', recoverBar !== null);

const restoreBtn = findAll(recovered, (n) => n.props !== undefined
  && n.props.className === 'dst-btn' && n.children[0] === 'recover.action')[0];
check('the recovery bar has a restore action', restoreBtn !== undefined);
restoreBtn.props.onClick();
check('restoring brought the topics back', store.__state.topics.length === 1);
check('the restored topic kept its name', store.__state.topics[0].name === '备份用话题');

// With the map non-empty again, the recovery bar disappears.
const afterRestore = render();
check('the recovery bar is gone once data is back',
  find(afterRestore, (n) => n.props !== undefined
    && typeof n.props.className === 'string' && n.props.className === 'dst-recover') === null);

// Clean up.
store.__state.topics = [];
store.__state.assignments = {};
store.__state.expanded = {};

// --- REGRESSION: the shell scroll contract -------------------------------
const rootRule = (injectedCss.match(/\.dst-root\{[^}]*\}/) || [''])[0];
const listRule = (injectedCss.match(/\.dst-list\{[^}]*\}/) || [''])[0];
check('root is styled as a flex column', rootRule.includes('display:flex') && rootRule.includes('flex-direction:column'));
check('root can shrink inside the region (flex:1 + min-height:0)',
  rootRule.includes('flex:1') && rootRule.includes('min-height:0'));
check('the list owns the scroller', listRule.includes('overflow-y:auto'));
check('the list can shrink so overflow works', listRule.includes('flex:1') && listRule.includes('min-height:0'));

// --- REGRESSION: row sizing matches the official browser -----------------
check('session titles are 14px like the official browser',
  injectedCss.indexOf('font-size:14px;line-height:20px') !== -1);

console.log('');
if (fail.length > 0) {
  console.log('RESULT: ' + fail.length + ' check(s) FAILED');
  for (const label of fail) console.log('  - ' + label);
  process.exit(1);
}
console.log('RESULT: all checks passed');
