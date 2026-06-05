# Verdikt

**Autonomous Iterative Coder** — 安全、可恢复、可审计的自治编码执行系统。

Verdikt 让 Claude Code 在隔离环境中反复"执行 → 客观裁决 → 反馈纠偏 → 再执行"，直到通过验收或安全停机。不信任 agent 自述，只信任退出码。

## 核心特性

- **双角色闭环**：Executor 改代码，Verifier 挑错，Judge 用退出码裁决
- **安全隔离**：git worktree 每轮隔离，失败不污染原仓库
- **显式交付**：默认不自动改原 repo，用户 `verdikt apply` 才生效
- **防作弊**：integrity guard 检测 skip/only/删断言/改测试脚本
- **语义风险扫描**：12 条规则检测硬编码、全局状态、memoization 等可疑 patch
- **结构化 judge**：支持 test + typecheck + lint 分步执行
- **完整留痕**：每轮 patch、judge 结果、verifier 反馈、成本、耗时全部记录
- **Benchmark 系统**：批量任务评估，14 个聚合指标，recovery 分析
- **可观测 UI**：Run Detail + Benchmark Overview 暗色主题页面

## 快速开始

```bash
# 安装依赖
pnpm install

# 检查环境
node dist/index.js doctor

# 创建任务模板
node dist/index.js init my-task ./path/to/target/repo

# 编辑任务（设置 goal、acceptance criteria 等）
vim my-task.task.json

# 运行自治循环
node dist/index.js run --task my-task.task.json

# 查看结果
node dist/index.js list
node dist/index.js view <run-id>
```

## CLI 命令

| 命令 | 说明 |
|------|------|
| `verdikt run --task <file>` | 运行自治循环 |
| `verdikt benchmark --suite <file>` | 运行 benchmark suite |
| `verdikt list` | 浏览历史 runs 和 benchmarks |
| `verdikt view <id>` | 查看 run 或 benchmark 详情 UI |
| `verdikt init [id] [repo]` | 创建 task spec 模板 |
| `verdikt apply <run-id>` | 显式 apply patch 到原 repo |
| `verdikt discard <run-id>` | 丢弃 worktree |
| `verdikt doctor` | 环境健康检查 |

### 运行选项

```bash
verdikt run --task <file>              # 默认：worktree + integrity 全开
verdikt run --task <file> --auto-apply  # passed 后自动 apply
verdikt run --task <file> --no-worktree # 跳过 worktree（开发用）
verdikt run --task <file> --no-integrity # 跳过 integrity 检查
```

## Task Spec 格式

```json
{
  "id": "fix-auth-bug",
  "goal": "Fix the authentication middleware so that expired tokens return 401 instead of 500",
  "repoPath": "./my-project",
  "acceptance": {
    "testCommand": "npm test",
    "steps": [
      { "id": "test", "command": "npm", "args": ["test"] },
      { "id": "typecheck", "command": "npx", "args": ["tsc", "--noEmit"] }
    ]
  },
  "maxIterations": 5,
  "maxBudgetUsd": 10,
  "integrity": {
    "allowTestChanges": false,
    "allowConfigChanges": false
  },
  "semantic": {
    "maxRisk": "low"
  }
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|------|:----:|------|
| `id` | ✓ | 任务唯一标识 |
| `goal` | ✓ | 自然语言描述的执行目标 |
| `repoPath` | ✓ | 目标仓库路径 |
| `acceptance.testCommand` | ✓ | 必须退出 0 的测试命令 |
| `acceptance.steps` | | 结构化 judge steps（优先于 testCommand） |
| `maxIterations` | | 最大轮次（默认 5） |
| `maxBudgetUsd` | | 预算硬上限 |
| `integrity` | | 测试完整性策略 |
| `semantic` | | 语义风险门控 |

## 架构

```
用户（task + acceptance）
  → SupervisorLoop（确定性编排）
    → Executor（Claude Code，改代码）
    → Judge（test/build exit code，客观裁决）
    → Verifier（Claude Code，挑剔 QA）
    → StopCondition（passed / no_progress / max_iterations / budget_exceeded）
    → 循环或交付
```

**核心原则：judge 永远是对的。** Executor 的自述和 Verifier 的解读都不能覆盖客观测试结果。

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `ANTHROPIC_BASE_URL` | — | API endpoint（如 Mimo 代理） |
| `ANTHROPIC_API_KEY` | — | API key |
| `VERDIKT_MODEL` | `sonnet` | 模型名 |
| `VERDIKT_MAX_ITERATIONS` | `5` | 默认最大轮次 |
| `VERDIKT_TIMEOUT_MS` | `300000` | 单次 Claude 调用 idle 超时 |
| `VERDIKT_STATE_DIR` | `.verdikt` | 运行产物目录 |

## Run 产物

每次 run 在 `.verdikt/<runId>/` 下产生：

```
summary.json        # 完整摘要：状态、workspace、patch、integrity、semantic risk
iterations.jsonl    # 每轮一行 JSON：judge、verifier、patch、cost
evidence/
  iteration-0.patch # 每轮 diff
  iteration-1.patch
  final.patch       # 最终 patch（passed 时生成）
task.json           # 任务 spec 备份
```

## Benchmark

```bash
# 运行 benchmark suite
node dist/index.js benchmark --suite benchmarks/m5-repo-doctor.json

# 查看结果
node dist/index.js view benchmark-xxx
```

Benchmark 产出：

```
.verdikt/benchmark-xxx/
  benchmark.json    # 聚合指标 + 逐任务结果
  benchmark.md      # 人类可读报告
  tasks/
    task-1/         # 每个任务的独立 evidence
    task-2/
```

### 核心指标

| 指标 | 说明 |
|------|------|
| `expectedOutcomeRate` | 实际结果符合预期的比例 |
| `successRate` | 最终 passed 比例 |
| `firstTryPassRate` | 一轮通过率 |
| `recoverableFailureSampleCount` | 首轮失败的可恢复样本数 |
| `recoverableFailureRecoveryRate` | 首轮失败后恢复成功率 |
| `infrastructureErrorRate` | 基础设施错误率 |

## 开发

```bash
pnpm test          # 运行测试（49 个）
pnpm build         # TypeScript 编译
pnpm lint          # Biome lint
pnpm lint:fix      # 自动修复
```

## CI Integration

Verdikt works in CI pipelines. Use `--json` for machine-readable output:

```bash
verdikt run --task fix-auth.task.json --json
```

Output:
```json
{
  "taskId": "fix-auth",
  "goal": "Fix authentication timeout bug",
  "passed": true,
  "stopReason": "passed",
  "iterations": 2,
  "totalCostUsd": 0.45,
  "totalDurationMs": 32000,
  "runId": "run-20260603-abc123"
}
```

Exit codes: `0` = passed, `1` = task failed, `2` = infrastructure error (budget exceeded, etc.)

### GitHub Actions

```yaml
name: Autonomous Fix
on:
  issue_comment:
    types: [created]

jobs:
  verdikt:
    if: contains(github.event.comment.body, '/fix')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install -g verdikt
      - name: Run Verdikt
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          verdikt run --task .verdikt/task.json --json > result.json
          echo "## Verdikt Result" >> $GITHUB_STEP_SUMMARY
          cat result.json >> $GITHUB_STEP_SUMMARY
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: verdikt-result
          path: result.json
```

## 项目状态

| 里程碑 | 状态 | 说明 |
|--------|:----:|------|
| M1 | ✅ | 自治闭环验证（4 demo + mock 多轮） |
| M2 | ✅ | 安全底座（worktree、integrity、discard、explicit apply） |
| M3 | ✅ | 可观测 + 可评估（UI、benchmark runner、指标体系） |
| M4 | ✅ | 可信度（semantic scanner、structured judge、recovery metrics） |
| M5 | ✅ | 真实项目验证（RepoDoctor 3000 LOC，首个 patch-backed recovery） |
| M6 | 🔄 | 产品化（Benchmark UI、CLI 完善、用户体验） |

## License

Private — not yet published.
