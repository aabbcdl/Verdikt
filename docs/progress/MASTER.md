# Verdikt Production Hardening — Master Plan

## Problem Statement

Verdikt 通过了功能验证（M1-M5），代码质量已稳定化（lint/ci/拆分/测试），
但 5 个关键问题阻止直接上线：

1. **Claude 子进程无硬性墙钟超时** — idle timeout 在持续微量输出时永远不触发
2. **Resume/compare/analyze/dashboard 未经真实验证** — 测试覆盖接近零
3. **并发防护为零** — 两个 run 对同一 repo 操作时互相踩踏
4. **核心模块零测试** — driver、judges、worktree 无任何测试
5. **CLI 参数手工解析 + 生命周期分叉** — indexOf 解析，resume 和正常 run 共享函数

## Phases

| Phase | Title | Status |
|-------|-------|--------|
| 0 | Spec & Plan | ✅ current |
| 1 | Claude Driver: Hard Timeout | ⬜ |
| 2 | Concurrency Lock | ⬜ |
| 3 | Core Module Tests | ⬜ |
| 4 | CLI Structured Args | ⬜ |
| 5 | Supervisor Lifecycle Split | ⬜ |
| 6 | Integration Tests (resume/compare/analyze/dashboard) | ⬜ |
| 7 | Final Verification | ⬜ |

## Acceptance Criteria

- [ ] Claude 子进程有绝对墙钟超时（默认 10 分钟），超时即 SIGKILL
- [ ] 同一 repoPath 同时只能有一个 run，第二个被拒绝并提示
- [ ] driver.ts、runJudges.ts、worktree.ts 有单元测试覆盖主要路径
- [ ] CLI 参数解析有 schema 验证，非法参数有明确错误提示
- [ ] resume 有独立的 supervisor 入口，不与正常 run 共享参数构造逻辑
- [ ] resume、compare、analyze、dashboard 有至少 happy-path 测试
- [ ] pnpm test 全部通过，pnpm build 通过，pnpm biome check 通过
