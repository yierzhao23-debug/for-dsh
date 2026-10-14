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
    const FALLBACK = { enabled: true, warnPct: 65, criticalPct: 82, minWindow: 8000, mode: 'toast', criticalMode: 'both' };
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

      const c = Object.assign({}, FALLBACK, cfg || {});
      if (!c.enabled) return null;

      let pct = null;
      try { pct = pctOf(pressure); } catch (e) { pct = null; }
      if (pct === null || pct < c.warnPct) return null;

      const win = pressure && typeof pressure.contextWindow === 'number' ? pressure.contextWindow : null;
      if (win !== null && win < c.minWindow) return null;

      const critical = pct >= c.criticalPct;
      const accent = critical ? T('state-error-primary') : T('state-warn-primary');
      const used = pressure && typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens
        : pressure && typeof pressure.pressureTokens === 'number' ? pressure.pressureTokens : null;

      const head = critical
        ? '上下文快满了，建议现在开新会话'
        : '这个会话开始变重了';
      const detail = critical
        ? '已经贴到自动压缩线附近 —— 再聊下去旧内容会被压成摘要，细节就找不回来了。'
        : '如果接下来还要做多步的长任务，开个新会话更划算。';

      return h('div', { style: Object.assign({}, styles.banner, { border: '1px solid ' + accent }) },
        h('span', { style: Object.assign({}, styles.dot, { background: accent }) }),
        h('div', { style: styles.body },
          h('div', { style: styles.head },
            head + '　',
            h('span', { style: Object.assign({}, styles.pct, { color: accent }) }, pct + '%')),
          h('div', { style: styles.detail }, detail),
          used !== null && win !== null
            ? h('div', { style: styles.detail }, used.toLocaleString('en-US') + ' / ' + win.toLocaleString('en-US') + ' tokens')
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
            if (ok && d.config) { setCfg(d.config); invalidateConfig(); setMsg('已保存，立即生效'); }
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
          .catch((e) => setMsg('测试失败：' + e.message));
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
          '阈值判据来自官方 contextPressure 投影（含采样后新增的 surface，不低估）。',
          '提醒只在回合结束时发出，避免打断进行中的工作。',
          '同一会话有冷却与次数上限；只有你自己发过消息的会话才会提醒（子代理不打扰）。'),
        h('div', { style: styles.hint },
          '命令：/ctxalert status | on | off | test | warn=65 critical=82'));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 聊天区顶部横幅
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'context-alert',
          order: 10,
        }, ContextAlertBanner));

        // 设置分区
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'context-alert',
          order: 110,
          label: '上下文提醒',
        }, ContextAlertSettings));
      },
    };
  },
});
