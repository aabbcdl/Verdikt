# 2026-07-26 Session 总记录与遗留清单

本次会话在同一工作区内连续完成五个阶段。本文件是总索引 + 全部遗留尾巴的唯一汇总处。

## 一、本次会话做了什么

### 阶段 1 — 全仓库架构审查
- 交付:`docs/reviews/2026-07-26-architecture-review.md`(Engineering Execution Plan,T-01~T-10)
- 方法:核心模块逐文件精读;基线验证(tsc 通过、vitest 68 文件/486 用例全过);关键缺陷运行时复现(>1MB diff 触发 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`);测试覆盖专项审计(三个关键论断逐条亲自复核:空转锁断言、`expect(true).toBe(true)` 占位测试、测试状态泄漏进项目 `.verdikt/`)
- 结论:READY WITH MANAGED RISKS;5 个 P1 + 5 个 P2

### 阶段 2 — 按批准计划实施修复(T-01~T-10 全部完成)
- 交付:`docs/reviews/2026-07-26-implementation-report.md`(含逐任务状态、Before/After、验证结果、修改文件清单)
- 要点:最终补丁流式化(T-02,含 >1MB 真实 git 回归用例)、Windows 进程树终止层 `src/claude/processTree.ts`(T-01,e2e 实测孙进程被杀)、补充说明消费接通(T-03)、运行生命周期收敛 `src/trace/lifecycle.ts` + 重启自动续跑修复(T-04)、脏仓库入口拦截 `src/cli/repoPreflight.ts` + `--allow-dirty`(T-05)、events O(n²) 追加与 queue.json 写放大治理(T-06,基准 2000 次追加 2.4×)、锁 pid 存活判定 + rename 原子接管(T-07)、验证体系(e2e 取消场景、CI ubuntu+windows 矩阵、coverage 接入,T-08)、预算护栏告警与 verifier 跳过(T-09)、乱码与死代码清理 + 守卫测试(T-10)
- 实施中额外发现并修复:预检误把父仓库脏状态归咎子目录任务(改为仅仓库根检查);`app-approval.test.ts` 一处以 `process.cwd()`(真实项目)当 repoPath 的越界夹具(改为密闭 git 夹具)

### 阶段 3 — UX/UI 审查(真实渲染取证)
- 交付:`docs/reviews/2026-07-26-ux-review.md`(U-01~U-09)+ 证据截图 `docs/reviews/assets/ux-2026-07-26/`
- 方法:构建后以沙箱状态目录真实启动产品(零 agent 调用、零费用),浏览器自动化实拍 14 个状态 × 3 档视口 + 可访问性树 + 真实交互(含一次自动化点击被吸顶导航拦截的实证)
- 结论:READY WITH MANAGED RISKS;5 个 P1(状态口径矛盾、待确认任务可迷失、补丁 diff 不可读、审查报告页空壳、吸顶导航遮挡点击)+ 4 个 P2

### 阶段 4 — UX 修复全量实施(U-01~U-09 + P3 微瑕 + 部署项)
- 交付:`docs/reviews/2026-07-26-ux-implementation-report.md`(逐项 Before/After、验证方式、事故披露)
- 要点:状态口径统一(waiting_approval/review 分支、中文枚举)、不定态进度条三态(active/paused/idle,带 reduced-motion)、待确认徽标与直达、单一 `:root` + 彩色 diff、审查报告页 `renderReviewPanel`、`scroll-padding-top`、编辑再跑反馈+焦点、全按钮 aria-label、结果卡堆叠、时间线人话化;三个 P3 微瑕(死三元、半全角混排、`in_place` 键错配)一并清偿;`VERDIKT_STATE_DIR` 写入 USAGE_GUIDE;覆盖率棘轮上调至 72/72/72/80
- 终态验证:`pnpm quality` 全链 exit 0;**72 测试文件 / 520 用例全绿**;coverage lines 76.76 / branches 75.91 / functions 87.24,高于新棘轮阈值

### 阶段 5 — 运行时复验(真实端到端)与收尾
- 复用 e2e 假 executor 垫片以真实 supervisor 驱动全链:提交→运行中(扫动条)→注入危险动作确认(黄条+决策面板)→"仅允许这一次"(原生确认弹窗→`grants=[('once',1)]` 落盘)→停止任务→**executor 进程(PID)实测被杀**(T-01 在 UI 取消路径验真);另收获一张非种子数据的真实通过截图
- 键盘走查(Tab 序=DOM 序=视觉序、焦点环可见、禁用按钮跳过——18 号"证据矛盾"裁决为无缺陷)、200% 缩放无溢出、benchmark 页渲染验证
- 收尾:项目 `.verdikt/` 12 个测试残留目录已删(保留全部真实 run-2026* 历史);全部临时沙箱/截图目录已删;含用户名路径的旧截图已删并更新引用;biome ignore 补 `coverage`(修复 lint 误检覆盖率产物)

### ⚠ 事故记录($1.50 真实花费)
复验初期以 git-bash 原生 Windows 路径拼接 `PATH`(`C:` 冒号破坏 PATH 解析),假 `claude` 垫片未被解析,live 任务拉起**真实 Claude CLI** 约 43 秒($1.4979,provider_error 中止)后被立即取消。影响面仅限临时沙箱仓库,无任何真实项目写入,但真实花费已发生。修正:`$(cygpath -u ...)` 拼接 + `where claude` 实测垫片优先;后续 live 运行费用 $0。教训:跨环境 PATH 注入必须先验证解析结果再触发计费操作。

---

## 二、遗留尾巴(唯一汇总)

### A. 需要用户决策 / 操作
- [ ] **全部改动尚未提交**。工作树包含:本会话之前就存在的大量未提交改动(会话开始时即如此)+ T-01~T-10 实施改动 + U-01~U-09 实施改动 + `docs/reviews/` 五份文档与截图资产。建议:审阅 `git diff` 后分批提交(如 `fix: T-01~T-10 stabilization`、`fix: UX U-01~U-09`、`docs: reviews 2026-07-26`)。未提交是因为会话中没有收到提交指令。
- [ ] **首次推送后观察 CI Windows leg**(`.github/workflows/ci.yml` 新增 windows-latest 矩阵;本机 win32 全量通过,但 GitHub runner 环境未验证)。
- [ ] **浏览器页签**:UX 取证初期曾附着到你正在使用的浏览器(其中一个页签可能仍停在 `http://127.0.0.1:3899/`,服务已停,可手动关闭);后续均用隔离会话并已关闭。
- [ ] **`.playwright-cli/` 未跟踪目录**:会话开始前即存在于工作树,本会话未使用也未清理,是否删除/入 ignore 由你定夺。

### B. 已完成(原遗留,已勾销)
- [x] UX 修复 U-01~U-09 全部实施并复验(阶段 4/5)
- [x] UX 视觉验证 5 项补齐(真实运行中、精确动作审批、键盘、200%、benchmark 页)
- [x] 项目 `.verdikt/` 测试残留清理(12 个目录;真实 run-2026* 历史全保留)
- [x] 临时目录清理(`verdikt-ux-state(2)`、`verdikt-ux-shots(2)`、`verdikt-ux-live`、种子脚本、遗留 `verdikt-app-validation-test-*`)
- [x] 含用户名路径截图删除 + 引用更新(assets 隐私清理完成)
- [x] `VERDIKT_STATE_DIR` 行为写入 `USAGE_GUIDE.md`
- [x] 覆盖率棘轮上调:70/70/70/75 → 72/72/72/80(实测 76.76/75.91/87.24)
- [x] P3 微瑕三项(fetchProgress 死三元、脏仓库文案半全角、`workspaceLabel` `in_place` 键)

### C. 架构审查 Deferred 项(有意保持延期,低优先)
- [ ] commandPolicy 正则误报精化(`--prod`、`release` 泛匹配;无误报样本,不盲目放宽安全面)
- [ ] actionStore 跨进程读改写小窗口(单写者现状下无实害)
- [ ] `injectDefaultDataDir` 字符串锚点脆弱性
- [ ] VS Code 扩展 / benchmark / stress / improvement 深审

### D. 已知限制(有意决策,已在代码/报告中记录,无需行动)
- provider_error 的可恢复运行 = 每次应用重启自动重试一次;provider 长期故障时会产生每次重启一条的失败记录(T-04 设计决策)。
- 锁接管在"三进程同时竞争同一过期锁"的微秒级窗口仍可能出现一个过期持有者心跳失效(双进程情形已闭合;`src/workspace/lock.ts` 注释说明)。
- POSIX 杀进程保持对直接子进程的信号语义(保护 Ctrl+C 前台组行为)——与原计划的偏差,已记录于实施报告。
- 预算上限在 usage 为 unknown 时仍无法数值强制,现已显式告警(T-09 设计边界)。
- 批准/停止等关键操作有原生 confirm 二次确认(设计摩擦,复验中确认存在)。

---

## 三、复现与环境说明

- UX 取证复现:构建后 `VERDIKT_STATE_DIR=<沙箱目录> node dist/index.js app --no-open --port=<port>`;沙箱数据 schema 见 `2026-07-26-ux-review.md` 附录 A 说明。切勿把沙箱指向真实 `.verdikt`(避免恢复逻辑触发真实 agent 调用);**在 git-bash 注入假 CLI 时 PATH 必须用 `$(cygpath -u ...)` 且先 `where claude` 验证解析,再触发任何会拉起 agent 的操作**(见事故记录)。
- 本会话对仓库的全部写入 = 阶段 2/4 代码、测试、配置改动 + `docs/reviews/` 五份文档与 assets 截图;三次审查阶段本身未修改任何产品文件。
