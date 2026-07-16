// Tavern Chronicler 面板 — 连接 st-claude-bridge 的 /admin WebSocket。
// 能力：实时修改桥配置（免环境变量、免重启，schema 由桥下发、表单自动生成）、
// 桥日志流式查看（连上先回放环形缓冲）、用量统计快照。
(() => {
    const LS_URL = 'tavernChronicler.bridgeUrl';
    const DEFAULT_URL = 'ws://127.0.0.1:9377/admin';
    const MAX_LOG_LINES = 500;
    const RECONNECT_MS = 4000;

    let ws = null;
    let schema = null;
    let reconnectTimer = null;

    const $id = (s) => document.getElementById(s);
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    // ---------- 面板骨架 ----------
    function buildPanel() {
        const root = el('div', 'tcb-settings');
        root.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Tavern Chronicler</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="tcb-conn">
                    <span id="tcb-dot" class="tcb-dot" title="未连接"></span>
                    <input id="tcb-url" class="text_pole" type="text" placeholder="${DEFAULT_URL}">
                    <input id="tcb-connect" class="menu_button" type="button" value="连接">
                </div>
                <div id="tcb-info" class="tcb-info">尚未连接到桥。桥需运行 2026-07-15 之后的版本（含 /admin 管理通道）。</div>
                <div id="tcb-usage" class="tcb-info"></div>
                <div id="tcb-camp" class="tcb-camp" style="display:none">
                    <div class="tcb-group-title">战役工具</div>
                    <div class="tcb-camp-row">
                        <input id="tcb-import" class="menu_button tcb-mini" type="button" value="导入当前对话"
                               title="把 ST 当前打开对话的全部楼层归档进桥的战役档案（已有匹配战役则补全合并），之后可选择让记忆 agent 分批补课构建档案">
                        <span id="tcb-camp-status" class="tcb-camp-status"></span>
                    </div>
                </div>
                <div id="tcb-groups"></div>
                <div id="tcb-reset-row" class="tcb-reset-row" style="display:none">
                    <input id="tcb-reset" class="menu_button tcb-mini" type="button" value="恢复默认设置">
                </div>
                <div class="tcb-log-head">
                    <b>桥日志</b>
                    <label class="checkbox_label"><input id="tcb-autoscroll" type="checkbox" checked><span>自动滚动</span></label>
                    <input id="tcb-stats" class="menu_button tcb-mini" type="button" value="用量">
                    <input id="tcb-clear" class="menu_button tcb-mini" type="button" value="清空">
                </div>
                <div id="tcb-log" class="tcb-log"></div>
            </div>
        </div>`;
        return root;
    }

    // ---------- 连接管理 ----------
    function setDot(state, title) {
        const dot = $id('tcb-dot');
        dot.className = 'tcb-dot' + (state ? ' ' + state : '');
        dot.title = title;
    }

    function connect() {
        clearTimeout(reconnectTimer);
        if (ws) { ws.onclose = null; ws.close(); ws = null; }
        const url = ($id('tcb-url').value || DEFAULT_URL).trim();
        localStorage.setItem(LS_URL, url);
        setDot('', '连接中…');
        try { ws = new WebSocket(url); } catch (e) {
            setDot('err', '地址无效');
            appendLocal('地址无效: ' + e.message, 'tcb-err');
            return;
        }
        ws.onopen = () => setDot('on', '已连接');
        ws.onmessage = (ev) => { try { handleMessage(JSON.parse(ev.data)); } catch { /* 忽略坏包 */ } };
        ws.onclose = () => {
            setDot('err', '连接断开');
            $id('tcb-info').textContent = '连接断开，' + (RECONNECT_MS / 1000) + ' 秒后自动重连…（桥没开或版本过旧？）';
            reconnectTimer = setTimeout(connect, RECONNECT_MS);
        };
    }

    function send(obj) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    }

    // ---------- 消息处理 ----------
    function toast(kind, text, title) {
        if (window.toastr && window.toastr[kind]) window.toastr[kind](text, title);
        else alert((title ? title + ': ' : '') + text);
        appendLocal(`${title ? title + '：' : ''}${text}`, kind === 'error' ? 'tcb-err' : 'tcb-sep');
    }

    function renderUsage(u) {
        if (!u) return;
        const part = (k, label) => (u[k] && u[k].calls
            ? `${label} ${u[k].hit == null ? '—' : u[k].hit + '%'}（${u[k].calls} 次）` : null);
        const parts = [part('chat', '回复'), part('memory', '记忆'), part('recall', '回溯')].filter(Boolean);
        $id('tcb-usage').textContent = parts.length ? `缓存平均命中率（自桥启动）· ${parts.join(' · ')}` : '';
    }

    function handleMessage(m) {
        if (m.type === 'hello') {
            schema = m.schema;
            renderGroups(m.config);
            const i = m.info || {};
            $id('tcb-info').textContent =
                `桥 PID ${i.pid} · 端口 ${i.port}（重启生效项）· 战役 ${i.campaigns} 个 · 档案根: ${i.memoryRoot}`;
            renderUsage(m.usage);
            $id('tcb-reset-row').style.display = '';
            $id('tcb-camp').style.display = '';
            $id('tcb-log').replaceChildren();
            for (const entry of m.logs || []) appendLog(entry);
            appendLocal('—— 已连接，以上为回放日志 ——', 'tcb-sep');
        } else if (m.type === 'usage') {
            renderUsage(m.usage);
        } else if (m.type === 'importResult') {
            if (!m.ok) return toast('error', m.error, '导入失败');
            toast('success', `${m.merged ? '并入现有战役' : '新建战役'} ${m.campaignId}，现共 ${m.turns} 轮`, '导入成功');
            const remaining = m.catchupRemaining ?? 0;
            if (remaining > 0 && confirm(
                `导入完成。是否立即在后台"补课"——让记忆 agent 分批通读这 ${remaining} 轮旧对话、构建战役档案（编年史/状态账本等）？\n\n`
                + '补课在后台分批执行，期间可以照常游戏；中断后再次导入并触发补课即可续跑。')) {
                send({ type: 'catchup', campaignId: m.campaignId });
                $id('tcb-camp-status').textContent = '补课已启动…';
            }
        } else if (m.type === 'catchup') {
            const el = $id('tcb-camp-status');
            if (m.status === 'running') el.textContent = `补课中：已覆盖 ${m.done}/${m.total} 轮`;
            else if (m.status === 'done') { el.textContent = ''; toast('success', `档案已覆盖 ${m.total} 轮`, '补课完成'); }
            else if (m.status === 'error') { el.textContent = ''; toast('error', `${m.error}（已完成 ${m.done ?? '?'} 轮，可再次触发续跑）`, '补课中断'); }
        } else if (m.type === 'config') {
            updateInputs(m.config);
        } else if (m.type === 'setResult') {
            if (!m.ok) {
                const msg = `${m.key}: ${m.error}`;
                if (window.toastr) window.toastr.error(msg, '桥拒绝了该配置');
                appendLocal('配置被拒绝 ' + msg, 'tcb-err');
            }
        } else if (m.type === 'log') {
            appendLog(m);
        } else if (m.type === 'stats') {
            const t = m.stats.totals;
            const fmt = (b) => `调用 ${b.calls} · in ${b.input} · out ${b.output} · cache r${b.cacheRead}/w${b.cacheWrite}`;
            appendLocal(`用量（本次运行 ${Math.floor(m.stats.uptimeSec / 60)} 分钟）`, 'tcb-sep');
            for (const k of ['chat', 'memory', 'recall', 'all']) appendLocal(`  ${k}: ${fmt(t[k])}`, 'tcb-sep');
        }
    }

    // ---------- 配置表单（按桥下发的 schema 生成） ----------
    function renderGroups(config) {
        const wrap = $id('tcb-groups');
        wrap.replaceChildren();
        const groups = new Map();
        for (const [key, s] of Object.entries(schema)) {
            if (!groups.has(s.group)) {
                const g = el('div', 'tcb-group');
                g.append(el('div', 'tcb-group-title', s.group));
                groups.set(s.group, g);
                wrap.append(g);
            }
            groups.get(s.group).append(buildRow(key, s, config[key]));
        }
    }

    function buildRow(key, s, value) {
        const row = el('div', 'tcb-row');
        const label = el('label', null, s.label);
        label.title = key + (s.desc ? '\n' + s.desc : '');
        let input;
        // enum 的 values 是硬性可选集；str 的 options 是建议集（服务端仍接受任意字符串），
        // 两者面板上都渲染成下拉框。当前值不在集合内时补一个选项，避免显示空白。
        const choices = s.type === 'enum' ? s.values : s.options;
        if (choices) {
            input = el('select', 'text_pole');
            const cur = value ?? '';
            const list = choices.includes(cur) ? choices : [...choices, cur];
            for (const v of list) {
                const opt = el('option', null, v === '' ? (s.emptyLabel || '（默认）') : v);
                opt.value = v;
                input.append(opt);
            }
        } else if (s.type === 'int') {
            input = el('input', 'text_pole');
            input.type = 'number';
            if (s.min != null) input.min = s.min;
        } else if (s.multiline) {
            input = el('textarea', 'text_pole');
            input.rows = 3;
        } else {
            input = el('input', 'text_pole');
            input.type = s.secret ? 'password' : 'text';
            if (s.secret) input.placeholder = '（未设置）';
        }
        input.id = 'tcb-f-' + key;
        input.value = value ?? '';
        input.addEventListener('change', () => {
            const v = s.type === 'int' ? Number(input.value) : input.value;
            send({ type: 'set', key, value: v });
            input.classList.add('tcb-sent');
            setTimeout(() => input.classList.remove('tcb-sent'), 800);
        });
        row.append(label, input);
        return row;
    }

    function updateInputs(config) {
        if (!schema) return;
        for (const key of Object.keys(schema)) {
            const input = $id('tcb-f-' + key);
            if (!input || document.activeElement === input) continue;
            const val = config[key] ?? '';
            if (input.tagName === 'SELECT' && ![...input.options].some(o => o.value === val)) {
                const opt = el('option', null, val === '' ? (schema[key].emptyLabel || '（默认）') : val);
                opt.value = val;
                input.append(opt);
            }
            input.value = val;
        }
    }

    // ---------- 旧对话导入 ----------
    // 从 ST 前端上下文取当前对话的完整楼层（客户端内存里是全量，不受上下文截断影响），
    // 经 /admin 通道交给桥归档。角色扮演消息映射：is_user → user，其余 → assistant；
    // is_system（注释/隐藏楼层）跳过。
    function importCurrentChat() {
        if (!ws || ws.readyState !== 1) return toast('error', '未连接到桥', '导入失败');
        let ctx = null;
        try { ctx = window.SillyTavern && SillyTavern.getContext(); } catch { /* 下面统一报错 */ }
        const chat = ctx && ctx.chat;
        if (!Array.isArray(chat) || !chat.length) return toast('error', '当前没有打开的对话', '导入失败');
        const turns = chat
            .filter(msg => msg && !msg.is_system && typeof msg.mes === 'string' && msg.mes.trim())
            .map(msg => ({ role: msg.is_user ? 'user' : 'assistant', content: msg.mes }));
        if (turns.length < 3) return toast('error', '当前对话有效消息不足 3 条', '导入失败');
        const title = String(ctx.name2 || turns.find(t => t.role === 'user')?.content || '').slice(0, 60);
        if (!confirm(`将把当前对话的 ${turns.length} 条消息导入桥的战役档案（已有匹配战役则补全合并，不影响其他战役）。继续？`)) return;
        toast('info', `正在导入 ${turns.length} 条消息…`, '导入');
        send({ type: 'import', title, turns });
    }

    // ---------- 日志视图 ----------
    function logClass(entry) {
        if (entry.level === 'error') return 'tcb-err';
        if (entry.level === 'warn') return 'tcb-warn';
        const m = entry.text.match(/^\[(\w+)\]/);
        return m ? 'tcb-tag-' + m[1] : '';
    }

    function appendLine(node) {
        const box = $id('tcb-log');
        box.append(node);
        while (box.childElementCount > MAX_LOG_LINES) box.firstElementChild.remove();
        if ($id('tcb-autoscroll').checked) box.scrollTop = box.scrollHeight;
    }

    function appendLog(entry) {
        const line = el('div', 'tcb-line ' + logClass(entry));
        const ts = new Date(entry.ts);
        const hh = (n) => String(n).padStart(2, '0');
        line.append(
            el('span', 'tcb-time', `${hh(ts.getHours())}:${hh(ts.getMinutes())}:${hh(ts.getSeconds())}`),
            document.createTextNode(entry.text),
        );
        appendLine(line);
    }

    function appendLocal(text, cls) {
        appendLine(el('div', 'tcb-line ' + (cls || ''), text));
    }

    // ---------- 装配 ----------
    jQuery(() => {
        const host = document.getElementById('extensions_settings2')
            || document.getElementById('extensions_settings');
        if (!host) return;
        host.append(buildPanel());
        $id('tcb-url').value = localStorage.getItem(LS_URL) || DEFAULT_URL;
        $id('tcb-connect').addEventListener('click', connect);
        $id('tcb-clear').addEventListener('click', () => $id('tcb-log').replaceChildren());
        $id('tcb-stats').addEventListener('click', () => send({ type: 'stats' }));
        $id('tcb-import').addEventListener('click', importCurrentChat);
        $id('tcb-reset').addEventListener('click', () => {
            if (!confirm('将清空面板改过的全部配置（含 API 密钥），回落到桥启动时的环境变量或内置默认，并即时生效。确定恢复默认设置？')) return;
            send({ type: 'reset' });
        });
        connect();
    });
})();
