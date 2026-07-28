# Verdikt 架构修复 — Engineering Implementation Report

- 实施日期:2026-07-26
- 依据计划:`docs/reviews/2026-07-26-architecture-review.md`(T-01 ~ T-10)
- 结论:**READY TO MERGE**(全部 10 项任务完成;lint / tsc / 517 测试 / coverage 阈值 / pnpm quality 全链通过)

## Executive Summary

按已批准的执行计划完成了全部 10 项任务:4 个已验证的 P1(大补丁收尾崩溃、Windows 孤儿进程、补充说明断链、重启不自动续跑)、脏仓库晚失败,以及 5 个 P2(I/O 放大、锁竞态、验证体系、预算护栏、乱码)。测试从 68 文件/486 用例增至 72 文件/517 用例(+31),新增覆盖率门槛(实测行覆盖 76.6%,阈值 70%),CI 增加 Windows 矩阵。实施过程中发现并修复了计划外的两个真实问题:预检会把父仓库的脏状态错误归咎于子目录任务;一个测试夹具直接把 `process.cwd()`(真实项目)当作 repoPath。

## 基线(改动前捕获)

- `tsc --noEmit`:通过;`vitest run`:68 文件 / 486 用例全过(32s)
- `pnpm lint`:14 个既有错误(全部为 CRLF 格式,与行为无关)——先以仓库自带 `lint:fix` 归零,使后续 lint 信号可归因
- 运行时复现:约 1.7MB diff 经 `execFile` 默认缓冲 → `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`(T-02 的 R 级证据)

## Task Results

| ID | 状态 | 变更摘要 |
|---|---|---|
| T-02 | COMPLETED | `getFinalPatch` 删除,新增流式 `writeFinalPatch`(复用 `streamDiffToFile`);`applyFinalPatch` 改为落盘后按文件大小判空;`git()` 辅助加 16MB maxBuffer 防御。新增真实 git 集成测试 `worktree.integration.test.ts`(含 >1MB 回归用例,直接复现原崩溃形态并通过)。 |
| T-01 | COMPLETED | 新增 `src/claude/processTree.ts`:win32 用 `taskkill /pid /T /F` 终止整棵进程树(先杀树、不预杀包装进程),POSIX 维持对直接子进程的信号语义(**与计划的偏差**:不采用 `detached`+进程组,避免改变 Ctrl+C 前台组行为,Rule 9 行为保护)。driver、runJudges(结构化/legacy/custom 三模式)、hooks 全部接入;driver stdin 挂 `error` 监听防 EPIPE 崩溃;非流式 200k 截断的安全降级补注释。真实进程树击杀单测 + e2e 取消场景在本机 Windows 验证孙进程确实死亡。 |
| T-03 | COMPLETED | supervisor 迭代起点消费 `consumeQueuedNotes`:合并进本轮 instruction(标注"用户补充说明")、先于 executor 持久化到 state、发出 `note_consumed` 事件;恢复"executor 已完成"的轮次不重复消费。两条 supervisor 集成用例覆盖注入与恢复幂等。 |
| T-04 | COMPLETED | 新增 `src/trace/lifecycle.ts` 单一判定(state.json 有效即可恢复;cancelled/error 仅手动,interrupted/provider_error 自动);`recoverPersistedRunQueue` 重写(含"已批准排队项不得翻回等待"与"用户已排队视为显式意图"两个边界);`recorder.isRunResumable` 语义修正(summary 不再取消资格);app `/api/run` GET 改用 lifecycle;`inferRunSource` 测试夹具启发式删除;`truncateRecordedIterations` 原子化(新增 `writeTextAtomic`)。restart 续跑测试改为**忠实落盘**(mock 同写 summary+state),证明修复本身。runStore 列表判定保持宽松(便于暴露坏状态运行)并注释指向 lifecycle 为准——最小化偏差,已注明。 |
| T-05 | COMPLETED | `TaskSpec.allowDirtyRepo` 字段;新增 `src/cli/repoPreflight.ts`(porcelain 固定列宽解析;**仅当 repoPath 是仓库根时执行**——实施中发现子目录会继承父仓库脏状态并误拦,已修复并新增用例);/api/run、/api/retry、CLI(单任务+批处理,`--allow-dirty`)接入;apply 端 revalidation 错误在 allowDirtyRepo 场景给出"手动应用补丁"指引;README/USAGE_GUIDE/CLI 帮助同步。 |
| T-06 | COMPLETED | events 追加序号缓存化(消除每条追加的全文件重读);`createPersistCoalescer` 合并 queue.json 写(在飞 1 + 尾随 1);持久化 `lastLog` 截断 8KB(内存 200KB 不变);close() 改为以 persist 完成为准。基准(N=2000):新路径 3114ms vs 旧路径模拟 7514ms ≈ 2.4×(旧路径随事件数二次增长,差距随运行时长扩大)。 |
| T-07 | COMPLETED | `isStale` 增加 ownerPid 存活检查(EPERM 视为存活),崩溃后锁立即可接管;过期接管改 rename 原子认领 + "误领新锁即归还"防护,闭合双进程双持有竞态;两处 `checkLock(".verdikt", …)` 空转断言修正为 TEST_STATE_DIR;lock.test 两个自认无效的 stale 用例重写为真实路径用例,新增 owner-dead 与接管互斥用例。已知限制:三进程同时竞争同一过期锁的微秒级归还窗口(注释说明,本地单用户工具可接受)。 |
| T-08 | COMPLETED | `expect(true).toBe(true)` 占位测试删除并由真实 git 集成用例替代;`handleResume` 成功路径首次被真实调用测试(两个误导性标题用例更名为其实际所测);e2e 新增"中途取消→无孤儿进程→锁已释→state 可恢复→真实 resume 跑通"场景(本机 Windows 通过);CI 矩阵 ubuntu+windows(Windows 腿跑 lint+build+test,Linux 腿跑全量 quality+coverage);接入 `@vitest/coverage-v8@^3`(与 vitest 3 配套),阈值按实测基线下取整(lines/statements/branches 70、functions 75,实测 76.6/76.6/76.03/87.24);修正 app-approval 测试指向真实项目 checkout 的夹具(改为密闭临时 git 仓库)。既有 `.verdikt/` 历史残留**未删除**(属用户本地数据,gitignored;新增测试均密闭)。 |
| T-09 | COMPLETED | 设有 maxBudgetUsd 且 usage 非 complete 时,每次运行发出一次"预算上限无法严格执行"告警(落入 events 时间线);judge 未通过且已超预算时跳过本轮 verifier 直接停止(judge 通过时仍走 verifier,保留"通过优先于预算"的既有语义)。两条用例分别覆盖跳过与告警。 |
| T-10 | COMPLETED | `buildResumableAdvice` 乱码重写为规范中文;supervisor 7 处退化 "?" 恢复为 ▸/⚠;重复 `updatePhase("planning","completed")` 删除;integrity.ts 空转的 weakened-assertions 循环删除且头注释同步;`docs.test.ts` 新增乱码守卫(扫描 src+apps/ui 的 U+FFFD 与字符串内 4 连问号)。 |

执行顺序与计划路线图一致(Phase 1: T-02→T-01→T-03;穿插 T-09/T-10 因同文件顺路,已记录);无任务被判 INVALIDATED 或 BLOCKED。

## Before / After(关键链路)

- **通过收尾**:`getFinalPatch`(1MB 进程内缓冲,>1MB 必崩)→ `writeFinalPatch` 流式直写 `evidence/final.patch`;补丁格式、路径契约不变。
- **超时/取消(win32)**:只杀 cmd.exe 包装进程、claude 孤儿继续计费写盘、重试再起并发 agent → `taskkill /T /F` 全树终止;e2e 实测孙进程死亡、锁释放、worktree 保留、resume 跑通。
- **补充说明**:写入即沉没 → 下一轮 executor prompt 实际包含说明、历史/事件/UI 文案全链贯通。
- **重启恢复**:优雅关闭的 interrupted 运行被标 completed(承诺失效)→ 自动重新入队续跑;cancelled 明确仅手动;硬崩溃路径行为不变。
- **脏仓库**:跑完才拒 → 提交即拒(0 花费),子目录不背父仓库的锅,`allowDirtyRepo/--allow-dirty` 显式逃生,apply 端提示手动应用。
- **保留不变**:apply 三重防护、judge-ground-truth 语义、HTTP 安全模型、provider_error 不自动重试、事件/状态文件格式(除持久化 lastLog 截断)。

## Verification Results

| 层 | 结果 |
|---|---|
| 依赖解析 | ✓ pnpm install(新增 @vitest/coverage-v8@^3.2.7,与 vitest 3.2.6 配套;lockfile 更新) |
| Lint(biome) | ✓ 200 文件 0 错误(基线 14 个既有 CRLF 错误已一并归零) |
| 类型检查(tsc --noEmit) | ✓ |
| 构建 | ✓(quality 链内 `pnpm build`) |
| 单元/集成测试 | ✓ 72 文件 / 517 用例全过(基线 486,+31) |
| e2e | ✓ 快乐路径 + 新增取消/恢复场景(真实 git、真实子进程、本机 win32) |
| 覆盖率 | ✓ lines 76.6% / statements 76.6% / branches 76.03% / functions 87.24%,阈值 70/70/70/75 通过 |
| 全链门禁 `pnpm quality` | ✓ exit 0(含 package:check、security:scan、stress:ci、vscode:compile) |
| 失败路径演练 | ✓ 取消中断(e2e)、超时树杀(单测)、恢复矩阵(lifecycle 9 例)、锁过期/owner 死亡/接管互斥、预算跳过、脏仓库拒绝/放行 |
| 未能验证 | GitHub Actions Windows runner 上的 CI 腿(本机 Windows 全量通过作为代理证据);真实 claude CLI 行为(与基线一致,CI 本就不含) |

## Measurement Results

- T-02:>1MB 真实 git 用例通过(原形态 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 已在基线复现)。
- T-01:真实进程树用例(父+孙)win32 通过;e2e 取消场景验证无孤儿。
- T-06:基准 N=2000 追加:3114ms(新)vs 7514ms(旧路径模拟),2.4×;coalescer 用例断言突发 5 次请求合并为 2 次写。
- T-08:覆盖率首次可度量并入 CI;无任何既有测试被删除或削弱——两处曾"钉住错误旧语义"的断言按计划改为断言新语义(recorder.test:344、runStore.test:193),均在计划批准范围内。

## Modified Files(按模块)

- **workspace**:worktree.ts(流式最终补丁)、lock.ts(pid+原子接管)、integrity.ts(死代码删除);worktree.test.ts、lock.test.ts、新 worktree.integration.test.ts
- **claude**:新 processTree.ts(+test);driver.ts(树杀/stdin 防护/注释);driver.test.ts
- **judges/hooks**:runJudges.ts、runner.ts(接入树杀);runJudges.test.ts
- **loop**:supervisor.ts(T-02/03/09/10);supervisor.test.ts(+6 用例、忠实 mock、锁断言修正)
- **trace**:新 lifecycle.ts(+test);recorder.ts(isRunResumable/原子截断);atomicJson.ts(writeTextAtomic);events.ts(序号缓存);recorder.test.ts
- **cli**:新 repoPreflight.ts(+test);app.ts(预检×2、lifecycle、coalescer、lastLog);run.ts(--allow-dirty+批处理预检);apply.ts(手动应用提示);runStore.ts(乱码修复、启发式删除);persistentQueue.ts(恢复重写+coalescer);resume.test.ts、app-validation.test.ts、app-approval.test.ts、persistentQueue.test.ts、runStore.test.ts
- **顶层**:types.ts(allowDirtyRepo)、index.ts(帮助文本)、docs.test.ts(乱码守卫)、vitest.config.ts(coverage)、package.json/pnpm-lock.yaml(coverage 依赖+脚本)、.github/workflows/ci.yml(双平台矩阵)、README.md、USAGE_GUIDE.md、e2e/smoke.test.ts
- **文档**:docs/reviews/2026-07-26-architecture-review.md、本报告
- 另:14 个文件的既有 CRLF 格式错误经 `pnpm lint:fix` 归零(仅行尾,无行为变化)

## Remaining Risks / Follow-ups

1. Windows CI 腿首次在 GitHub runner 上运行时需观察(本机 win32 全量通过,但 runner 环境差异未验证)。
2. provider_error 运行的自动续跑 = 每次应用重启重试一次(计划决策);若 provider 长期故障会产生每次重启一次的失败记录。
3. 锁接管在"三进程同时竞争同一过期锁"的微秒级窗口仍可能出现一个过期持有者的心跳失效(两进程情形已闭合;代码注释说明)。
4. `.verdikt/` 内的历史测试残留未清理(用户本地数据);建议用户自行确认后删除 mock-run-001、interrupted-run-001 等目录。
5. 覆盖率阈值为按现状下取整的地板;建议随修复节奏逐步上调,并禁止下调换绿。
6. 审查报告中的 Deferred 项(commandPolicy 误报精化、actionStore 跨进程窗口、VS Code 扩展深审等)保持延期,未纳入本次。

## Merge Readiness

**READY TO MERGE** — 所有批准任务完成并通过全部验证层;无 INVALIDATED / BLOCKED 项;偏差(POSIX 杀进程语义、runStore 列表宽松度)均为缩小风险的最小安全解释并已记录。
