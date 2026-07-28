# 2026-07-26 UX/UI 修复实施报告

对应审查报告:`2026-07-26-ux-review.md`(U-01~U-09)。本报告记录全部修复的实施状态、验证证据与遗留边界。复验证据截图见 `assets/ux-2026-07-26/r2-*.png`(共 16 张,含真实运行链路实拍)。

**结论:U-01~U-09 全部完成;审查阶段悬置的 5 项视觉验证全部补齐;3 个 P3 微瑕一并清偿。全量门禁 `pnpm quality` 通过。**

---

## 一、逐项实施状态

### U-01 状态口径矛盾 + 假进度条 — 完成

- **服务端**(`src/cli/app.ts`):`buildRunPhaseSnapshot` 新增 `waiting_approval` 分支(标题"等待你的确认",不再显示与等待语义矛盾的执行文案);`buildCompletedPhaseSnapshot` 新增 review 分支(`review_completed`/`review_incomplete`,标题带发现问题数,不再把审查完成呈现为"未通过")。
- **客户端**(`apps/ui/app.html`):`statusLabel` 补 `review_completed: '审查完成'`、`review_incomplete: '审查未完成'`,历史列表不再裸露英文枚举;假百分比进度条改为 `setProgressState(mode)` 三态(active=不定态扫动动画、paused=黄色、idle=实底),全部 10 处宽度赋值点迁移;`role="progressbar"` 去掉虚假 `aria-valuenow`,并带 `prefers-reduced-motion` 降级。
- **实拍验证**:`r2-20-running.png`(运行中蓝色扫动)、`r2-21-exact-action.png`(等待确认时进度条变黄、标题"等待你的确认")、`r2-07-history-groups.png`(历史列表"审查完成"中文标签)。

### U-02 待确认任务可迷失 — 完成

- `updatePendingIndicators`:导航按钮动态显示 `当前任务（N 待确认）`;空态页新增待确认提示条与"查看待确认任务"按钮(点击直达对应 run);`startRun` 提交被 400 拒绝时不再清空 `currentRunId`(在途/等待中的运行不会因一次被拒的提交而从界面失踪),并恢复轮询。
- **实拍验证**:`r2-02-approval-waiting.png`(徽标+提示条)、`r2-08-empty-with-pending.png`(空态直达按钮)。运行时注入动作确认后徽标实时变为"2 待确认"(run 级 + 动作级同时计数),批准后回落"1 待确认"。

### U-03 补丁 diff 不可读 — 完成

- 根因是 `app.html` 存在两个 `:root` 块(死的暗色主题层被亮色层覆盖,但 `.patch-review` 继承了暗底假设的文字色)。合并为单一 `:root`,删除全部死选择器;`.patch-review` 显式 `color:#c9d1d9`,新增 `renderPatchText` 行级分类器(`+`→`.diff-add #7ee787`、`-`→`.diff-del #ffa198`、`@@/diff/index`→`.diff-meta #8b949e`)。
- **实拍验证**:`r2-10-passed-details-full.png`(彩色 diff,深底浅字,增删行分色)。

### U-04 审查报告页空壳 — 完成

- `apps/ui/index.html` 新增 `#review-panel` 与 `renderReviewPanel`(按严重级分组渲染 findings:文件/行号/建议);`reviewOnly` 运行隐藏无意义的安全/补丁面板;状态卡最后一格改为"发现问题"数;`workspaceLabel` 修正 `direct: '直接模式'`(原 `in_place` 键与实际值不匹配的 D 项微瑕);验收徽章接 `localizeJudgeSummary`。工作台侧 `applyReviewLayout(reviewOnly)` 同步隐藏引导/补丁区。
- **实拍验证**:`r2-14-report-review.png`(报告页渲染出完整审查报告)、`r2-11-review-result.png`(工作台审查结果布局)。

### U-05 吸顶导航遮挡锚点/点击 — 完成

- `html{scroll-padding-top:72px}`(两档断点 64/58);配置预览首行不再被压。审查阶段实证过的"自动化点击被吸顶导航拦截"路径在复验中未再复现。
- **实拍验证**:`r2-12-edit-rerun.png` 顶部完整可见。

### U-06 编辑再跑无反馈 — 完成

- `editRunTask` 现在 `switchView('new')` 后显示 `#taskFormNotice`("已载入「<任务>」的任务配置。")并把焦点移到目标输入框。
- **实拍验证**:`r2-12-edit-rerun.png` + 运行时 eval 证据 `{"hidden":false,"text":"已载入「fix-cache-key」...","focused":"goal"}`。

### U-07 按钮无可访问名 — 完成

- `renderRunItem` 抽取 `itemLabel`,列表内全部操作按钮(查看/编辑再跑/固定/归档/继续/重试/校验证据/批准/拒绝/确认并继续)带 `aria-label="<动作> ${itemLabel}"`;修复一处 label-in-name 违例(可见文本"确认并继续"的按钮 aria 原为"批准（仅一次）")。
- **实拍验证**:可访问性树读出"查看 release-hotfix"等完整名;键盘走查 `r2-23-keyboard-focus.png` 焦点环清晰、禁用按钮被正确跳过、焦点序=视觉序。

### U-08 结果统计卡布局错位 — 完成

- `.result-card .label/.value` 改 `display:block` 垂直堆叠;`.lane-grid` 补三列布局。
- **实拍验证**:`r2-10-passed-details-full.png`(统计卡上下堆叠、三列泳道)。

### U-09 时间线/文案机器味 — 完成

- `eventDetail` 按事件类型输出人话(审查结论/验收/补丁就绪/结束原因/补充说明原文/耗时/工作区/风险类别);三处乱码退化的 `?` 分隔符改 `·`;`localizeJudgeSummary`/`localizeAdviceLine`("必需 N/M 通过");历史条目"agent · 第 1 轮"。
- **实拍验证**:`r2-10-passed-details-full.png` 时间线全中文人话。

---

## 二、一并清偿的 P3 微瑕(session-log D 项)

| 项 | 状态 |
|---|---|
| `fetchProgress` queued 分支死三元 | 已随 U-01 清理(现为扁平 `setStatus('排队中','running')`) |
| 脏仓库提示半/全角混排 | 已统一为全角(`repoPreflight.ts`、`run.ts`) |
| 报告页 `workspaceLabel` `in_place` 键错配 | 已随 U-04 修正为 `direct` |

## 三、随行部署项

- **`VERDIKT_STATE_DIR` 文档**:`USAGE_GUIDE.md` 新增"运行记录保存在哪里"一节(默认相对启动目录、迁移方法)。
- **覆盖率棘轮上调**:`vitest.config.ts` 阈值 70/70/70/75 → **72/72/72(branches)/80(functions)**,按实测(lines 76.76 / branches 75.91 / functions 87.24)下取整,只升不降。
- **`.verdikt/` 测试残留清理**:删除 12 个历史测试写入的目录(`mock-run-001`、`approval-required` 等),保留全部真实 `run-2026*` 历史与 `queue.json`/`locks`/`implementation`/`reviews`。
- **隐私清理**:删除含本机用户名路径的旧截图 `13-report-passed-1440.png`,以干净的 `r2-13-report-passed.png` 替代并更新审查报告索引。
- **biome ignore 补 `coverage`**:本地生成过 `coverage/` 后 lint 会误检覆盖率 JSON 产物导致门禁失败(`.gitignore` 原本就有该目录,biome 名单漏配);`biome.json` 已补齐。

## 四、运行时复验(真实端到端链路)

复用 e2e 假 executor 基建(`claude.cmd` 垫片:执行侧写入 pid 文件后长睡,审查侧即时返回),以真实 supervisor 全链驱动,零真实 agent 费用:

1. **提交任务 → 运行中**:表单提交、隔离副本创建、executor 真实拉起(pid 文件出现),UI 显示不定态扫动条(`r2-20`)。
2. **危险动作确认**:向运行目录注入 `action-approvals.json` pending → 下一次轮询状态即变"等待你的确认",进度条转黄,面板完整显示原因/风险类别/具体命令/工具/位置与三个决策按钮(`r2-21`)。风险类别映射覆盖全部 8 个真实枚举;截图中 `data_migration` 原文透出是注入了非法类别所致,属设计好的兜底回退,非缺陷。
3. **批准一次**:点击"仅允许这一次"弹出原生确认("确认仅允许这一次操作并继续吗？"),接受后 `action-approvals.json` 实测:pending 清空、`grants=[('once',1)]`、history 记录 approved/once;UI 回到运行态(`r2-21b`)。
4. **停止任务**:点击"停止任务"→"任务已停止",恢复原因、诚实的"未知"花费、继续/丢弃动线齐备(`r2-22`);**假 executor 进程(PID 65292)实测已被杀死**——T-01 的 Windows 进程树终止在 UI 取消路径上验真。
5. **完整通过链路**(计划外收获):首次运行因排查间隙跑满假 executor 的 10 分钟睡眠后自然走完 judge→verifier→passed,拿到一张非种子数据的真实"任务通过"截图(`r2-25-live-passed.png`)。
6. **键盘走查**(`r2-23`):Tab 序=DOM 序=视觉序,焦点环可见,禁用按钮被跳过——审查阶段 18 号截图的"证据矛盾"裁决为**无缺陷**。
7. **200% 缩放**(`r2-24`):布局正常回流,无重叠、无水平溢出。
8. **benchmark 页**(`r2-19`):完整指标契约渲染验证。

## 五、验证门禁

- `pnpm quality` 全链 exit 0(lint→build→package:check→test→security:scan→stress:ci→vscode:compile)。
- 两个 HTML 页面的内联脚本以 `new Function(scriptBody)` 语法自检通过;新增 vm 级 UI 测试(review 面板渲染、单一 `:root`、diff 配色、`scroll-padding-top`、待确认指示、aria-label 模板、扫动条等守卫)。
- 覆盖率高于新棘轮阈值。

## 六、事故披露(重要)

复验初期一次环境失误产生了 **$1.50 真实 API 花费**:以 git-bash 原生 Windows 路径拼接 `PATH`(`C:` 中的冒号破坏了 PATH 解析),假 `claude` 垫片未被解析到,live 任务拉起了**真实 Claude CLI**,运行约 43 秒($1.4979,provider_error 中止)后被立即取消。影响面仅限临时沙箱仓库(无任何真实项目写入),但真实花费已发生。修正:改用 `$(cygpath -u ...)` 拼接后 `where claude` 实测垫片优先,后续两次 live 运行费用为 $0。

## 七、保持延期(有意不做,理由见架构报告)

- commandPolicy 正则误报精化(无误报样本,不盲目放宽安全面);actionStore 跨进程锁;`injectDefaultDataDir` 锚点重构;VS Code 扩展深审。
- **全部改动仍未提交**——工作树含会话前既有改动,提交时机与拆分方式留给用户决策。
