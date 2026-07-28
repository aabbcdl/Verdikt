# Verdikt 架构审查 — Engineering Execution Plan

- 审查日期:2026-07-26
- 审查范围:全仓库(工作区当前状态,基于提交 1443a60 之后的未提交改动)
- 审查方法:全部核心模块逐文件精读(C)+ 测试套件真实执行(T:68 文件 / 486 用例全通过,tsc --noEmit 通过)+ 关键缺陷运行时复现(R:maxBuffer)+ 测试覆盖专项审计(关键论断逐条亲自复核)
- 交付物:本执行计划;实施报告见 `2026-07-26-implementation-report.md`

---

## Executive Summary

Verdikt 的整体架构是健康的:模块边界清晰、编排逻辑确定性、apply 前的三重防护(集成工作区复验、仓库快照比对、失败回滚)是同类工具中少见的高水准设计,486 个测试全部通过、tsc 严格模式零错误。但审查发现的最大风险是**"绿色测试套件掩盖的真实缺口"**:多处关键断言是空转的(锁释放断言查错目录、`getFinalPatch` 测试是 `expect(true).toBe(true)`)、关键 mock 与真实实现的落盘行为不一致,导致三个已交付承诺在真实环境中失效——通过的运行在大补丁下崩溃(已运行时复现)、"下一轮补充说明"从未生效、优雅重启后不自动续跑。

前三优先级:(1) T-02 大补丁导致通过的运行在收尾崩溃(C3,已复现);(2) T-01 Windows 上超时/取消只杀 cmd.exe 包装进程,泄漏仍在计费和写文件的 claude 进程,且重试会再起一个并发 agent 写同一工作区;(3) T-03/T-04 两个已在 README/USAGE_GUIDE 明确承诺的功能(补充说明、重启自动续跑)实现断链。

总体工作量约 2–3 个工程周:Phase 1(约 3–4 天)修复四个已验证的 P1;Phase 2(约 1 周)收敛生命周期判定、锁与预算护栏;Phase 3(持续)重建验证体系可信度。无需推翻任何现有架构决策。

---

## Evidence Coverage

| 模块 / 区域 | 已核查证据 | 置信度 | 覆盖缺口 |
|---|---|---|---|
| loop/(supervisor, stopCondition, stagePlan) | C(全文精读)+ T(测试通过) | 高 | stagePlan.ts 仅按调用点核查 |
| claude/driver.ts + platform.ts | C(全文)+ T | 高 | 未对真实 claude CLI 做运行时验证(CI 同样没有) |
| workspace/(worktree, lock, integrity, warm, repoIdentity) | C(全文)+ R(maxBuffer 复现)+ T | 高 | semantic-scanner.ts 仅按调用点核查 |
| trace/(recorder, events, atomicJson, notes, checkpoints) | C(全文,checkpoints 按调用点) | 高 | — |
| cli/app.ts + localServer + runStore + persistentQueue | C(全文)+ T | 高 | — |
| cli/apply, resume, run, approval, note, checkpointActions | C(全文) | 高 | view/list/compare/dashboard/doctor 仅浏览 |
| approval/, risk/, hooks/, evidence/ | C(全文) | 高 | — |
| apps/ui/app.html | C(渲染路径抽样:39 处 escapeHtml,重点 innerHTML 全查) | 中 | benchmark.html / dashboard.html / index.html 未读 |
| apps/vscode | C(表面扫描)+ T(safety 测试存在) | 低 | 全文未读,列为缺口 |
| benchmark/, stress/, improvement/, security/scan | C(浏览) | 低 | 全文未读,列为缺口 |
| 测试套件真实性 | T(vitest 68 文件/486 用例全过,32s)+ 专项审计(关键论断已亲自复核) | 高 | 无覆盖率工具,无法量化 |
| 构建/CI | B(tsc --noEmit 通过;ci.yml、biome.json、tsconfig 已读) | 高 | 审查阶段未执行 pnpm quality 全链 |

说明:三个辅助审查代理(静默失败扫描、TS 并发审查、HTTP 安全审查)因推理网关 503 中途终止,其职责范围已由主审逐文件读通补齐;测试覆盖审计代理正常完成,其三个关键论断(空转锁断言、占位测试、测试状态泄漏到项目 `.verdikt/`)均经主审亲自复核属实。

---

## Architecture Health Matrix

| 维度 | 状态 | 置信度 | 主要证据 | 判断 |
|---|---|---|---|---|
| 分层与模块边界 | STRONG | 高 | C:roles/judges/loop/workspace/trace 单向依赖,编排零 LLM 决策 | 保持 |
| 状态管理(运行生命周期) | AT RISK | 高 | C:"可恢复"判定在 4 处独立实现且语义矛盾(T-04) | 需收敛为单一来源 |
| 数据一致性(落盘) | ACCEPTABLE | 高 | C:writeJsonAtomic(temp+rename+Windows 重试)全面使用;truncate 路径非原子为小瑕疵 | 保持,小修 |
| 契约完整性 | AT RISK | 高 | C+T:notes 契约断链(T-03);测试 mock 与真实落盘行为不一致(T-04/T-08) | 需修复 |
| 失败与恢复 | AT RISK | 高 | C+R:Windows 孤儿进程(T-01)、大补丁收尾崩溃(T-02)、崩溃后锁滞留(T-07) | 需修复 |
| 测试与验证 | AT RISK | 高 | T:486 用例全绿,但存在已证实的空转断言、占位测试、单 OS CI、零覆盖率工具(T-08) | 绿色≠可信 |
| 可观测性 | ACCEPTABLE | 高 | C:events.jsonl 时间线完整;但追加为 O(n²)(T-06);花费诚实标注 unknown/partial 是亮点 | 性能修复后良好 |
| 安全与数据完整性 | STRONG | 高 | C:127.0.0.1 绑定+Host 白名单+Origin 校验+会话令牌(timingSafeEqual)+路径护栏+前端 escapeHtml 纪律;apply 三重防护;完整性反作弊基线 | 保持 |
| 依赖健康 | STRONG | 高 | B:零运行时依赖,仅 5 个 devDependencies,lockfile 锁定,node>=20 | 罕见的干净 |
| 演进就绪 | ACCEPTABLE | 中 | 上述 P1 清偿后,当前结构足以支撑产品化迭代 | — |

---

## Risk Matrix

| ID | 优先级 | 问题 | 根因 | 证据 | 置信度 | 影响 |
|---|---|---|---|---|---|---|
| T-02 | P1 | 累计 diff >1MB 时,已通过的运行在收尾抛 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`,状态变为 error | `getFinalPatch` 用带默认 1MB maxBuffer 的 `execFile` 收集完整补丁,与迭代 diff 的流式设计不一致 | C, R | C3 VERIFIED | 通过的成果无法交付,用户白花钱 |
| T-01 | P1 | Windows 上超时/取消只终止 cmd.exe/powershell 包装进程,claude 与验收子进程成为孤儿;超时重试再起并发 agent 写同一工作区 | 全库无进程树终止机制;`child.kill` 在 win32 只杀直接子进程 | C | C2(链路完整) | 持续计费的失控 agent、工作区并发写坏、文件句柄阻塞清理 |
| T-03 | P1 | "下一轮补充说明"写入后永不生效 | `consumeQueuedNotes` 仅有 import(supervisor.ts:36),循环内无调用点;`note_consumed` 事件已定义、UI 文案已备但从未发出 | C, T | C3 VERIFIED | README/USAGE_GUIDE/capabilities 明确承诺的功能静默失效 |
| T-04 | P1 | 优雅关闭后重启,中断的运行被标记 completed,不自动续跑(README 承诺自动继续);硬崩溃反而会续跑 | "可恢复"判定在 recorder/runStore/app/persistentQueue 四处独立实现;`recoverPersistedRunQueue` 以 summary.json 存在为终态,而真实 supervisor 在中断时同时写 summary+state | C | C2(三环节逐一验证) | 文档承诺失效;语义倒挂(正常关闭体验差于崩溃) |
| T-05 | P1 | 脏仓库可提交任务并跑完全程,apply 时才以 revalidation_required 拒绝 | 清洁前置条件只在终点(apply.ts)强制,提交入口无任何检查;worktree 基于 HEAD,不含未提交改动 | C | C3 VERIFIED | 花完预算才发现成果不可应用 |
| T-06 | P2 | 每条事件追加都全量重读解析 events.jsonl(O(n²));每条日志触发整个 queue.json(含至多 200KB×N 的日志)全量重写 | 追加序号仅为返回值服务却驱动全文件读;persist 无合并 | C | C2 | CLI 流式长运行明显变慢,磁盘写放大 |
| T-07 | P2 | 过期锁接管存在 TOCTOU(双方都 unlink 后其一可删掉对方新建的锁,双持有);进程崩溃后锁滞留至多 60 分钟阻塞新运行 | `acquireLock` 读-删-建非原子;`isStale` 记录了 ownerPid 却不检查存活 | C, T(相关测试证实为空转) | C2 | 并发保护这一安全机制本身有洞 |
| T-08 | P2 | 测试套件多处空转/占位断言;save→load 契约两侧全 mock 从未闭环;测试状态泄漏进项目 `.verdikt/`;CI 仅 ubuntu 单矩阵而开发在 Windows;零覆盖率工具 | 验证体系缺少"测试的测试"与平台矩阵 | T, C, B | C3(逐项亲自复核) | 回归防护名存实亡的局部区域 |
| T-09 | P2 | usage 未知时 `totalCost` 恒为 0,`maxBudgetUsd` 硬上限静默失效且无任何提示;预算仅在整轮结束后检查 | decideStop 依赖 costUsd,unknown 状态未触发降级告警 | C | C2 | 用户以为有花费护栏,实际没有 |
| T-10 | P2 | `buildResumableAdvice` 用户可见文案全部为 "?????" 乱码;supervisor 多处日志符号退化为 "?" | 编码事故写入源码;无乱码守卫 | C | C3 VERIFIED | 违背 DESIGN.md 中文文案标准,直接损害产品可信感 |

---

## Execution Tasks(摘要)

完整任务定义(Evidence/Problem/Root Cause/Target State/Execution Plan/Validation/Done Definition)以审查会话产出为准,此处保留执行要点:

- **T-02** 最终补丁改走 `streamDiffToFile` 流式落盘(`writeFinalPatch`),`git()` 辅助加 16MB maxBuffer 防御;新增 >1MB 真实 git 用例。
- **T-01** 新建 `src/claude/processTree.ts` 统一进程树终止(win32:`taskkill /pid /T /F`);driver / runJudges(两种模式)/ hooks 全部接入;driver stdin 挂 error 监听。POSIX 维持直杀语义(避免 detached 改变 Ctrl+C 前台组行为)。
- **T-03** supervisor 迭代起点消费 `consumeQueuedNotes`,合并进 instruction 并先于 executor 持久化;发出 `note_consumed` 事件;恢复中途轮次不重复消费。
- **T-04** 新建 `src/trace/lifecycle.ts` 单一生命周期判定;`recoverPersistedRunQueue` 对 interrupted/provider_error 的可恢复运行自动重排队,cancelled 仅手动;`isRunResumable` 改为委托;移除 `inferRunSource` 测试夹具启发式;`truncateRecordedIterations` 原子化。
- **T-05** 任务入口(/api/run、/api/retry、CLI worktree 模式)前置仓库清洁检查,默认拒绝脏仓库,提供 `allowDirtyRepo` / `--allow-dirty` 逃生口并同步 apply 端提示与文档。
- **T-06** events 追加序号缓存化(消除全文件重读);queue.json 持久化合并写(coalesce);持久化 lastLog 截断至 8KB。
- **T-07** 锁:ownerPid 存活参与过期判定;过期接管改 rename 原子认领;重写两个假的 stale 测试;修正 supervisor.test 两处指向错误目录的空转断言。
- **T-08** 替换 `getFinalPatch` 占位测试(真实 git 集成用例);resume 成功路径测试;app-validation 重启用例改为忠实落盘;e2e 新增"中途取消→无孤儿进程→锁已释→真实恢复跑通"场景;CI 增加 windows 矩阵;接入 @vitest/coverage-v8。
- **T-09** usage unknown/partial 且设有 maxBudgetUsd 时发出"预算无法严格执行"警示(每次运行一次);judge 未通过且已超预算时跳过本轮 verifier 直接停止(judge 通过时仍走 verifier,保持"通过优先"语义)。
- **T-10** 修复 runStore.buildResumableAdvice 乱码为规范中文;supervisor "?" 日志符号恢复;删除 integrity.ts 空转的 weakened-assertions 循环并同步头注释;删除重复 updatePhase;新增乱码守卫测试。

---

## Preserve / Deferred

| 项 | 决定 | 理由 |
|---|---|---|
| apply 三重防护(集成工作区复验 → 快照一致性 → 应用后验收失败自动回滚) | **Preserve** | 有意的架构决策,配套测试真实且优秀 |
| "judge 是唯一事实来源;verifier 输出不可解析一律判未完成" | **Preserve** | 防 LLM 假通过的核心设计 |
| provider_error 一律不自动重试(driver 层) | **Preserve** | 避免无意义付费重试的明确决策 |
| HTTP 安全模型(loopback+Host 白名单+Origin+会话令牌+路径护栏+escapeHtml 纪律) | **Preserve** | 逐项代码验证为已实现 |
| writeJsonAtomic / 证据清单 / ci.test.ts 反 skip 元门禁 | **Preserve** | 正确且有测试 |
| commandPolicy 正则误报(`--prod`、`release` 泛匹配) | **Deferred** | fail-closed,等真实误报样本再精化 |
| actionStore 跨进程读改写小窗口 | **Deferred** | 原子 rename 防损坏,影响证据不足 |
| stateDir 默认相对 CWD | **Deferred** | 文档说明即可 |
| `injectDefaultDataDir` 字符串锚点脆弱性 | **Deferred** | 有 ui-pages 测试看护 |
| VS Code 扩展、benchmark/stress/improvement 深审、其余 UI 页面 | **Deferred** | 本轮覆盖缺口,建议下轮补审 |

---

## Roadmap

- **Phase 1 — 止血已验证缺陷**:T-02 → T-03 → T-10 → T-05 → T-01(全部独立可并行)
- **Phase 2 — 收敛状态与护栏**:T-04 → T-07 → T-09 → T-06
- **Phase 3 — 验证地基(持续)**:T-08(e2e 取消场景依赖 T-01;Windows CI 矩阵;coverage)

## Architecture Readiness Assessment

**READY WITH MANAGED RISKS** — 骨架正确且相互咬合;风险集中在"承诺已写、纵向切片未闭合或平台语义未覆盖"型缝隙,且部分被不忠实的测试掩盖。按路线图清偿后,现有架构足以支撑 README 所述产品化目标,无需推倒性重构。
