window.__ModuleLoader__.load({
  id: 'dsh-context-alert',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 主题令牌（--dsw-alias-*）。只引用令牌，不写死颜色，明暗主题自动跟随。 */
    const T = (name) => `var(--dsw-alias-${name})`;

    /**
     * 客户端只需要百分比，而 `contextPressure` 的 wire view 已经把
     * projectedTokens 算好了（宿主侧 usage-projection 的 view）。
     * 所以这里直接读数，不重算 surface 差值 —— 也就不存在与 watch.js 漂移的问题。
     */
    function pctOf(pressure) {
      if (pressure === null || typeof pressure !== 'object') return null;
      const win = pressure.contextWindow;
      if (typeof win !== 'number' || !isFinite(win) || win <= 0) return null;
      let used = null;
      if (typeof pressure.projectedTokens === 'number' && isFinite(pressure.projectedTokens)) used = pressure.projectedTokens;
      else if (typeof pressure.pressureTokens === 'number' && isFinite(pressure.pressureTokens)) used = pressure.pressureTokens;
      if (used === null) return null;
      return Math.min(100, Math.round((used / win) * 1000) / 10);
    }

    // 宿主不可达时的兜底阈值。真实值从 /api/context-alert/settings 取，
    // 取到之前用这套渲染，避免首帧闪一下错误阈值。
    const FALLBACK = { enabled: true, warnPct: 65, criticalPct: 82, minWindow: 8000, bannerAlways: true, mode: 'toast', criticalMode: 'both' };
    let configCache = null;
    let inflight = null;

    function loadConfig() {
      if (configCache !== null) return Promise.resolve(configCache);
      if (inflight !== null) return inflight;
      inflight = fetch('/api/context-alert/settings')
        .then((r) => r.json())
        .then((d) => { configCache = d && d.config ? d.config : null; inflight = null; return configCache; })
        .catch(() => { inflight = null; return null; });
      return inflight;
    }

    function invalidateConfig() { configCache = null; }

    // 压缩次数只有宿主读得到（要扫会话日志），所以横幅的"第几次"从宿主的状态接口取。
    // 短 TTL 缓存：横幅在每次百分比变化时会重渲染，不缓存会把接口打爆。
    let stateCache = null;
    let stateInflight = null;
    const STATE_TTL = 5000;

    function loadState() {
      const now = Date.now();
      if (stateCache !== null && now - stateCache.at < STATE_TTL) return Promise.resolve(stateCache.rows);
      if (stateInflight !== null) return stateInflight;
      stateInflight = fetch('/api/context-alert/state')
        .then((r) => r.json())
        .then((d) => {
          const rows = d && Array.isArray(d.sessions) ? d.sessions : [];
          stateCache = { at: Date.now(), rows };
          stateInflight = null;
          return rows;
        })
        .catch(() => { stateInflight = null; return null; });
      return stateInflight;
    }

    function invalidateState() { stateCache = null; }

    /** 在当前会话的那一行里找压缩信息。找不到就返回 null（横幅退化成不带序数的说法）。 */
    function compactionRow(rows, props) {
      if (!Array.isArray(rows) || rows.length === 0) return null;
      let sid = null;
      try {
        // sessionId 来自 slot 注册的 inject(sessionId)，这是 dock 拿会话身份的正路。
        if (props && typeof props.sessionId === 'string' && props.sessionId !== '') sid = props.sessionId;
        // 兜底：万一某个版本把 session 也塞进 props 了。
        else if (props && props.session && typeof props.session.id === 'string') sid = props.session.id;
      } catch (e) { sid = null; }
      if (sid === null) return null;
      return rows.find((r) => r && r.id === sid) || null;
    }

    function fmtNum(n) {
      return typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-US') : null;
    }

    const styles = {
      banner: {
        display: 'flex', alignItems: 'flex-start', gap: '10px',
        margin: '0 0 8px 0', padding: '9px 12px',
        background: T('bg-layer-2'),
        borderRadius: '10px', fontSize: '12.5px', lineHeight: '1.55',
        fontFamily: T('font-family'),
      },
      dot: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none', marginTop: '6px' },
      body: { flex: '1', minWidth: 0 },
      head: { color: T('label-primary'), fontWeight: 600, marginBottom: '2px' },
      detail: { color: T('label-tertiary'), fontSize: '11.5px' },
      pct: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: '10px', margin: '10px 0', fontSize: '13px' },
      label: { color: T('label-secondary'), width: '150px', flex: 'none', fontSize: '12.5px' },
      input: {
        flex: '1', maxWidth: '200px', background: T('bg-module-platform'),
        border: '1px solid ' + T('border-l2'), color: T('label-primary'),
        borderRadius: '8px', padding: '7px 10px', fontSize: '13px', outline: 'none',
        fontFamily: T('font-family'),
      },
      switchRow: { display: 'flex', alignItems: 'center', gap: '10px', margin: '8px 0', fontSize: '13px' },
      switchLabel: { color: T('label-primary'), cursor: 'pointer', fontSize: '12.5px' },
      btn: {
        background: T('button-info-fill'), border: 'none', color: '#fff',
        borderRadius: '8px', padding: '8px 22px', fontSize: '13px', cursor: 'pointer',
        marginTop: '14px', fontWeight: 500,
      },
      btnGhost: {
        background: 'transparent', border: '1px solid ' + T('border-l2'), color: T('label-primary'),
        borderRadius: '8px', padding: '8px 18px', fontSize: '13px', cursor: 'pointer',
        marginTop: '14px', marginLeft: '10px',
      },
      msg: { color: T('label-secondary'), fontSize: '12px', marginTop: '8px', marginLeft: '10px' },
      hint: { color: T('label-tertiary'), fontSize: '11.5px', marginTop: '6px', lineHeight: '1.6' },
    };

    /**
     * 聊天区顶部（输入框上方）的压力横幅。
     *
     * 挂在 conversation.input.dock 上：这是宿主已经分配好空间的停靠区
     * （内置的待办停靠、排队停靠都在这里），随输入框一起出现，
     * 且该 slot 的组件能拿到 useProjection —— 内置的 QueueDock/TodoDock 就是这么取数的。
     *
     * 组件绝不能抛异常：slot 里的组件一崩，整个 slot 条目会被清空
     * （控制台报 "slot entry crashed"）。所以取数一律包在 try 里。
     */
    function ContextAlertBanner(props) {
      const [cfg, setCfg] = React.useState(configCache);
      React.useEffect(() => {
        let alive = true;
        loadConfig().then((c) => { if (alive && c !== null) setCfg(c); });
        return () => { alive = false; };
      }, []);

      let pressure = null;
      try {
        pressure = props && typeof props.useProjection === 'function' ? props.useProjection('contextPressure') : null;
      } catch (e) {
        pressure = null;
      }

      let pct = null;
      try { pct = pctOf(pressure); } catch (e) { pct = null; }

      // 所有 hook 必须在任何 return 之前调用，否则渲染顺序会变。
      const sid = props && typeof props.sessionId === 'string' ? props.sessionId : null;
      const [rows, setRows] = React.useState(stateCache === null ? null : stateCache.rows);
      React.useEffect(() => {
        let alive = true;
        loadState().then((r) => { if (alive && r !== null) setRows(r); });
        return () => { alive = false; };
      }, [pct, sid]);

      const c = Object.assign({}, FALLBACK, cfg || {});
      if (!c.enabled) return null;

      const win = pressure && typeof pressure.contextWindow === 'number' ? pressure.contextWindow : null;
      if (win !== null && win < c.minWindow) return null;

      // 常驻模式：只要拿得到窗口读数就显示（平时一行小字）。
      // 关掉 bannerAlways 则退回旧行为——只在越过 warnPct 时出现。
      const always = c.bannerAlways !== false;
      if (pct === null) return null;
      if (!always && pct < c.warnPct) return null;

      const warn = pct >= c.warnPct;
      const critical = pct >= c.criticalPct;
      const accent = critical ? T('state-error-primary') : warn ? T('state-warn-primary') : T('label-tertiary');
      const used = pressure && typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens
        : pressure && typeof pressure.pressureTokens === 'number' ? pressure.pressureTokens : null;

      const row = compactionRow(rows, props);
      const nth = row && typeof row.ordinalText === 'string' ? row.ordinalText : null;
      const count = row && typeof row.compactionCount === 'number' ? row.compactionCount : null;
      const known = !!(row && row.compactionKnown === true);
      const loss = row && typeof row.lossPct === 'number' ? row.lossPct : null;
      const shadowed = row ? fmtNum(row.shadowedTotal) : null;
      const usage = used !== null && win !== null ? fmtNum(used) + ' / ' + fmtNum(win) + ' tokens' : null;

      // ── 平时：一行小字，只回答官方环回答不了的两个问题 ────────────────
      // 「压过几次」「丢了多少」。占用率与 token 用量**故意不在这里重复**：
      // 官方 `ContextMeter`（dsh-client-ui-conversation）的环就渲染在输入栏
      // 的 dock 里，紧挨在本横幅下方；同一区域上下并排显示同一个百分比，
      // 只会让人怀疑哪个才是准的。分工见 README §1.1。
      if (!warn) {
        const bits = [];
        if (known && count !== null) {
          bits.push(count === 0 ? '尚未发生上下文压缩' : `已压缩 ${count} 次`);
        } else {
          bits.push('压缩次数未知');
        }
        if (loss !== null) bits.push(`信息丢失率 ${loss}%`);
        return h('div', { style: Object.assign({}, styles.banner, { border: '1px solid ' + T('border-l2') }) },
          h('span', { style: Object.assign({}, styles.dot, { background: accent }) }),
          h('div', { style: styles.body },
            h('div', { style: Object.assign({}, styles.detail, { marginTop: '0' }) }, bits.join('　·　'))));
      }

      // ── 越过阈值：展开成醒目的多行，把"第几次压缩"顶到标题 ──────────
      // 这里才把百分比拿出来放在标题旁边 —— 它已经是"该换会话了"这个判断的
      // 一部分，而不再是"顺便报个数"。
      const head = critical
        ? (nth === null ? '上下文快满了，建议现在开新会话' : `本对话的${nth}自动压缩随时会触发`)
        : (nth === null ? '这个会话开始变重了' : `即将开始本对话的${nth}自动压缩`);

      // 详情行：优先说"累计压了多少、丢了多少"，再说最近一次。
      const lastTokens = row ? fmtNum(row.lastShadowedTokens) : null;
      const lastTurn = row && typeof row.lastTurn === 'number' ? row.lastTurn : null;
      let historyLine;
      if (known && count !== null && count > 0) {
        const parts = [`已压缩 ${count} 次`];
        if (shadowed !== null && row.shadowedTotal > 0) parts.push(`累计遮蔽 ${shadowed} tokens`);
        if (loss !== null) parts.push(`丢失率 ${loss}%`);
        historyLine = parts.join('　·　');
        if (lastTokens !== null) {
          historyLine += `　最近一次${lastTurn === null ? '' : `（第 ${lastTurn} 回合）`}遮蔽 ${lastTokens} tokens，只留下摘要。`;
        }
      } else if (known && count === 0) {
        historyLine = '本对话还没有压缩过，信息都还在。';
      } else {
        historyLine = '压缩会把最旧的对话换成一条摘要消息，原始细节之后找不回来。';
      }

      return h('div', { style: Object.assign({}, styles.banner, { border: '1px solid ' + accent }) },
        h('span', { style: Object.assign({}, styles.dot, { background: accent }) }),
        h('div', { style: styles.body },
          h('div', { style: styles.head },
            head + '　',
            h('span', { style: Object.assign({}, styles.pct, { color: accent }) }, pct + '%')),
          h('div', { style: styles.detail }, historyLine),
          usage !== null
            ? h('div', { style: styles.detail }, usage)
            : null));
    }

    const MODES = [
      ['toast', '桌面通知'],
      ['speak', '语音播报'],
      ['sound', '提示音'],
      ['both', '语音 + 桌面'],
    ];

    /** 设置面板（设置 → 插件 → 上下文提醒）。 */
    function ContextAlertSettings() {
      const [cfg, setCfg] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [msg, setMsg] = React.useState('');

      React.useEffect(() => {
        let alive = true;
        fetch('/api/context-alert/settings')
          .then((r) => r.json())
          .then((d) => { if (alive && d && d.config) setCfg(d.config); })
          .catch((e) => { if (alive) setMsg('读取失败：' + e.message); });
        return () => { alive = false; };
      }, []);

      const save = () => {
        setSaving(true); setMsg('');
        fetch('/api/context-alert/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cfg),
        })
          .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
          .then(({ ok, d }) => {
            if (ok && d.config) { setCfg(d.config); invalidateConfig(); invalidateState(); setMsg('已保存，立即生效'); }
            else setMsg('保存失败：' + ((d && d.error) || '未知错误'));
          })
          .catch((e) => setMsg('保存失败：' + e.message))
          .then(() => setSaving(false));
      };

      const test = () => {
        setMsg('正在发送测试提醒…');
        fetch('/api/context-alert/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level: 'warn' }),
        })
          .then((r) => r.json())
          .then((d) => setMsg(d && d.ok ? '测试提醒已发出' : ('测试失败：' + ((d && d.error) || '未知错误'))))
          .catch((e) => setMsg('测试失败：' + e.message))
          .then(() => invalidateState());
      };

      if (cfg === null) {
        return h('div', { style: { color: T('label-tertiary'), fontSize: '13px', padding: '12px 0' } }, '加载中…');
      }

      const set = (k, v) => setCfg((prev) => Object.assign({}, prev, { [k]: v }));
      const num = (k) => (e) => set(k, Number(e.target.value));

      return h('div', null,
        h('div', { style: styles.switchRow },
          h('input', { type: 'checkbox', id: 'ca-enabled', checked: !!cfg.enabled, onChange: (e) => set('enabled', e.target.checked) }),
          h('label', { htmlFor: 'ca-enabled', style: styles.switchLabel }, '启用上下文压力提醒')),
        h('div', { style: styles.switchRow },
          h('input', { type: 'checkbox', id: 'ca-banner-always', checked: cfg.bannerAlways !== false, onChange: (e) => set('bannerAlways', e.target.checked) }),
          h('label', { htmlFor: 'ca-banner-always', style: styles.switchLabel }, '横幅常驻（平时也用一行显示压缩次数与信息丢失率）')),

        h('div', { style: styles.row },
          h('span', { style: styles.label }, '提醒阈值 warn（%）'),
          h('input', { type: 'number', min: 1, max: 99, style: styles.input, value: cfg.warnPct, onChange: num('warnPct') })),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '紧急阈值 critical（%）'),
          h('input', { type: 'number', min: 1, max: 99, style: styles.input, value: cfg.criticalPct, onChange: num('criticalPct') })),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '重新上膛阈值（%）'),
          h('input', { type: 'number', min: 1, max: 99, style: styles.input, value: cfg.rearmPct, onChange: num('rearmPct') })),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '同级冷却（分钟）'),
          h('input', {
            type: 'number', min: 0, max: 600, style: styles.input,
            value: Math.round((cfg.cooldownMs || 0) / 60000),
            onChange: (e) => set('cooldownMs', (Number(e.target.value) || 0) * 60000),
          })),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '每会话最多提醒（次）'),
          h('input', { type: 'number', min: 1, max: 20, style: styles.input, value: cfg.maxAlertsPerSession, onChange: num('maxAlertsPerSession') })),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '压缩线比例（%）'),
          h('input', { type: 'number', min: 1, max: 100, style: styles.input, value: cfg.compactPct, onChange: num('compactPct') })),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '压缩余量 headroom'),
          h('input', { type: 'number', min: 0, max: 1000000, step: 1024, style: styles.input, value: cfg.headroomTokens, onChange: num('headroomTokens') })),

        h('div', { style: styles.row },
          h('span', { style: styles.label }, '普通提醒方式'),
          h('select', { style: styles.input, value: cfg.mode || 'toast', onChange: (e) => set('mode', e.target.value) },
            MODES.map(([v, t]) => h('option', { key: v, value: v }, t)))),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '紧急提醒方式'),
          h('select', { style: styles.input, value: cfg.criticalMode || 'both', onChange: (e) => set('criticalMode', e.target.value) },
            MODES.map(([v, t]) => h('option', { key: v, value: v }, t)))),

        h('button', { style: styles.btn, disabled: saving, onClick: save }, saving ? '保存中…' : '保存设置'),
        h('button', { style: styles.btnGhost, onClick: test }, '试一次提醒'),
        h('span', { style: styles.msg }, msg),

        h('div', { style: styles.hint },
          '占用率与 token 用量由输入框下方的官方 ContextMeter 显示，本横幅不重复。',
          '  横幅只补官方环不回答的：压过几次、丢了多少、要不要换会话。',
          '阈值判据来自官方 contextPressure 投影（含采样后新增的 surface，不低估）。',
          '提醒只在回合结束时发出，避免打断进行中的工作。',
          '同一会话有冷却与次数上限；只有你自己发过消息的会话才会提醒（子代理不打扰）。',
          '文案里的"第几次压缩"是数会话日志里的 compaction/start 得出的，不是估计。',
          '"信息丢失率" = 累计被遮蔽的 token ÷（累计被遮蔽 + 当前上下文）。',
          '  分母含摘要本身，所以这个比例偏小，是保守估计——真实丢失只会更多。',
          '压缩线比例与余量请与 dsh-compaction-basic 的 thresholdRatio / headroomTokens 保持一致：',
          '真实触发点是 floor(min(W×比例, W−输出预留−余量))，所以那个比例只是上界，实际可能更早。'),
        h('div', { style: styles.hint },
          '命令：/ctxalert status | on | off | test | warn=65 critical=82'));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 聊天区顶部横幅
        //
        // 关键：dock 组件的 props 里**没有** session。
        // 内置 TodoDock 的签名就是 `({ useProjection, t })`；按会话的 props
        // 要通过注册项的 `inject(sessionId)` 注入（QueueDock 与 ui-goal 的
        // goal dock 都这么做，且都是注册在同一个 slot 上）。
        // 少了这个 inject，横幅就永远认不出自己属于哪个会话，
        // 也就永远拿不到"第几次压缩"。
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'context-alert',
          order: 10,
          inject: (sessionId) => ({ sessionId }),
        }, ContextAlertBanner));

        // 设置分区
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'context-alert',
          order: 110,
          label: '上下文提醒',
        }, ContextAlertSettings));
      },

      /**
       * 仅供测试的缝：压缩历史要靠宿主的接口取，而单测里没有宿主。
       * 不是公开 API，别在别处用。
       */
      __test__: {
        setStateCache(v) { stateCache = v; stateInflight = null; },
        setConfigCache(v) { configCache = v; inflight = null; },
        clear() { stateCache = null; stateInflight = null; configCache = null; inflight = null; },
      },
    };
  },
});
