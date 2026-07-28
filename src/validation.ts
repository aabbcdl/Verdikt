import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { TaskSpec } from "./types.js";

export interface ValidationError {
  field: string;
  message: string;
  fix: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

const REQUIRED_STRING_FIELDS = ["id", "goal", "repoPath"] as const;
const PLANNING_MODES = new Set(["off", "auto", "required"]);
const HOOK_EVENTS = new Set([
  "before_run",
  "after_plan",
  "after_executor",
  "after_judges",
  "before_apply",
  "after_run",
]);
const HOOK_FAILURE_MODES = new Set(["warn", "block"]);
const MAX_HOOKS = 20;

const RISK_CATEGORIES = new Set([
  "deployment",
  "database",
  "production",
  "secrets",
  "external_write",
  "destructive",
  "outside_repo",
  "manual",
]);

export function validateTaskSpec(task: TaskSpec, taskFilePath: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  for (const field of REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyString(task[field])) {
      errors.push({
        field,
        message: `Missing required field: ${field}`,
        fix: `Add "${field}": "..." to ${taskFilePath}`,
      });
    }
  }

  if (isNonEmptyString(task.id) && !/^[a-zA-Z0-9_-]+$/.test(task.id)) {
    warnings.push({
      field: "id",
      message: `Task id "${task.id}" contains special characters`,
      fix: "Use only alphanumeric, hyphens, and underscores (e.g., fix-auth-bug)",
    });
  }

  validateTaskMode(task, errors);
  validateRunSource(task, errors);
  validateRepoPaths(task, errors);
  validateGoal(task, warnings, errors);
  validateStages(task, errors, warnings);
  validateAcceptance(task.acceptance, "acceptance", task.repoPath, true, errors, warnings);
  validateLimits(task, errors, warnings);
  validateExecution(task, errors);
  validateIntegrity(task, errors);
  validateSemantic(task, errors);
  validateRiskPolicy(task, errors);
  validatePlanning(task, errors, warnings);
  validateHooks(task, errors);

  return { valid: errors.length === 0, errors, warnings };
}

function validateTaskMode(task: TaskSpec, errors: ValidationError[]): void {
  if (task.taskMode === undefined) return;
  if (task.taskMode !== "implement" && task.taskMode !== "review") {
    errors.push({
      field: "taskMode",
      message: "taskMode must be implement or review",
      fix: 'Use "taskMode": "implement" or "taskMode": "review"',
    });
  }
}

function validateRunSource(task: TaskSpec, errors: ValidationError[]): void {
  if (task.runSource === undefined) return;
  if (!["user", "demo", "benchmark", "test", "unknown"].includes(task.runSource)) {
    errors.push({
      field: "runSource",
      message: "runSource must identify a supported run origin",
      fix: 'Use "user", "demo", "benchmark", "test", or "unknown"',
    });
  }
}

function validateStages(
  task: TaskSpec,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  if (task.stages === undefined) return;
  if (!Array.isArray(task.stages)) {
    errors.push({
      field: "stages",
      message: "stages must be an array",
      fix: 'Use "stages": [{ "id": "stage-1", "title": "First step", "goal": "..." }]',
    });
    return;
  }
  if (task.stages.length === 0) {
    warnings.push({
      field: "stages",
      message: "stages is empty and will be ignored",
      fix: "Remove stages or add at least one stage",
    });
    return;
  }

  const seen = new Set<string>();
  for (let i = 0; i < task.stages.length; i++) {
    const stage = task.stages[i];
    if (!isRecord(stage)) {
      errors.push({
        field: `stages[${i}]`,
        message: "Stage must be an object",
        fix: 'Use { "id": "stage-1", "title": "First step", "goal": "..." }',
      });
      continue;
    }

    if (!isNonEmptyString(stage.id)) {
      errors.push({
        field: `stages[${i}].id`,
        message: "Stage missing required field: id",
        fix: 'Add a stable id like "diagnose" or "implement"',
      });
    } else if (seen.has(stage.id)) {
      errors.push({
        field: `stages[${i}].id`,
        message: `Duplicate stage id: ${stage.id}`,
        fix: "Use a unique id for each stage",
      });
    } else {
      seen.add(stage.id);
    }

    if (!isNonEmptyString(stage.title)) {
      errors.push({
        field: `stages[${i}].title`,
        message: "Stage missing required field: title",
        fix: 'Add a short title like "Implement fix"',
      });
    }

    if (!isNonEmptyString(stage.goal)) {
      errors.push({
        field: `stages[${i}].goal`,
        message: "Stage missing required field: goal",
        fix: "Describe what this stage must accomplish",
      });
    }

    if (stage.maxIterations !== undefined && !isPositiveInteger(stage.maxIterations)) {
      errors.push({
        field: `stages[${i}].maxIterations`,
        message: "Stage maxIterations must be a positive whole number",
        fix: "Use a value like 2 or remove the stage limit",
      });
    }
    if (stage.maxBudgetUsd !== undefined && !isPositiveNumber(stage.maxBudgetUsd)) {
      errors.push({
        field: `stages[${i}].maxBudgetUsd`,
        message: "Stage maxBudgetUsd must be a positive number",
        fix: "Use a value like 2.5 or remove the stage budget",
      });
    }
    if (stage.requireApproval !== undefined && typeof stage.requireApproval !== "boolean") {
      errors.push({
        field: `stages[${i}].requireApproval`,
        message: "Stage requireApproval must be true or false",
        fix: 'Use "requireApproval": true or remove the field',
      });
    }
    validateRiskCategories(stage.riskCategories, `stages[${i}].riskCategories`, errors);
    if (stage.acceptance !== undefined) {
      validateAcceptance(
        stage.acceptance,
        `stages[${i}].acceptance`,
        task.repoPath,
        false,
        errors,
        warnings,
      );
    }
  }
}

function validateRepoPaths(task: TaskSpec, errors: ValidationError[]): void {
  if (task.repoPaths !== undefined) {
    errors.push({
      field: "repoPaths",
      message: "repoPaths is not supported in the current execution mode",
      fix: "Use one absolute repoPath and run each repository as a separate task",
    });
  }
  if (isNonEmptyString(task.repoPath)) validateRepoPath("repoPath", task.repoPath, errors);
}
function validateRepoPath(field: string, repoPath: string, errors: ValidationError[]): void {
  const resolvedPath = resolve(repoPath);
  try {
    if (!existsSync(resolvedPath)) {
      errors.push({
        field,
        message: `Repository path does not exist: ${resolvedPath}`,
        fix:
          field === "repoPath"
            ? "Check the repoPath in your task file - it must be an existing directory"
            : "Check the path - it must be an existing directory",
      });
    } else if (!statSync(resolvedPath).isDirectory()) {
      errors.push({
        field,
        message:
          field === "repoPath"
            ? `repoPath is not a directory: ${resolvedPath}`
            : `Not a directory: ${resolvedPath}`,
        fix:
          field === "repoPath"
            ? "repoPath must point to a directory, not a file"
            : "Each repoPath must point to a directory",
      });
    } else if (!existsSync(resolve(resolvedPath, ".git"))) {
      errors.push({
        field,
        message: `Not a git repository: ${resolvedPath}`,
        fix: `Run "git init" in ${resolvedPath} first - Verdikt needs git for worktree isolation`,
      });
    }
  } catch {
    errors.push({
      field,
      message: `Repository path is not accessible: ${resolvedPath}`,
      fix: "Check that the path exists and Verdikt can read it",
    });
  }
}

function validateGoal(
  task: TaskSpec,
  warnings: ValidationError[],
  errors: ValidationError[],
): void {
  if (!isNonEmptyString(task.goal)) return;

  if (task.goal.length < 20) {
    warnings.push({
      field: "goal",
      message: "Goal is very short - executor may lack direction",
      fix: "Describe what to fix or implement and any constraints (aim for 1-3 sentences)",
    });
  }
  if (task.goal === "Describe what the executor should accomplish") {
    errors.push({
      field: "goal",
      message: "Goal is still the template placeholder",
      fix: "Replace with a real description of what to accomplish",
    });
  }
}

function validateAcceptance(
  acceptanceValue: unknown,
  field: string,
  repoPath: string | undefined,
  required: boolean,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  if (acceptanceValue === undefined || acceptanceValue === null) {
    if (required) {
      errors.push({
        field,
        message: "No acceptance criteria defined",
        fix: 'Add "acceptance": { "steps": [{ "id": "test", "command": "npm", "args": ["test"] }] }',
      });
    }
    return;
  }

  if (!isRecord(acceptanceValue)) {
    errors.push({
      field,
      message: "Acceptance must be an object",
      fix: 'Use "acceptance": { "steps": [{ "id": "test", "command": "npm", "args": ["test"] }] }',
    });
    return;
  }

  const acceptance = acceptanceValue;
  const hasCommand = isNonEmptyString(acceptance.testCommand);
  const hasSteps = Array.isArray(acceptance.steps) && acceptance.steps.length > 0;
  const hasCustom = acceptance.custom !== undefined;

  if (acceptance.testCommand !== undefined && !isNonEmptyString(acceptance.testCommand)) {
    errors.push({
      field: `${field}.testCommand`,
      message: "testCommand must be a non-empty string",
      fix: 'Use "testCommand": "npm test" or remove it',
    });
  } else {
    validateLegacyCommand(`${field}.testCommand`, acceptance.testCommand, errors);
  }
  if (acceptance.buildCommand !== undefined && !isNonEmptyString(acceptance.buildCommand)) {
    errors.push({
      field: `${field}.buildCommand`,
      message: "buildCommand must be a non-empty string",
      fix: 'Use "buildCommand": "npm run build" or remove it',
    });
  } else {
    validateLegacyCommand(`${field}.buildCommand`, acceptance.buildCommand, errors);
  }
  if (acceptance.lintCommand !== undefined && !isNonEmptyString(acceptance.lintCommand)) {
    errors.push({
      field: `${field}.lintCommand`,
      message: "lintCommand must be a non-empty string",
      fix: 'Use "lintCommand": "npm run lint" or remove it',
    });
  } else {
    validateLegacyCommand(`${field}.lintCommand`, acceptance.lintCommand, errors);
  }
  if (!isOptionalPositiveNumber(acceptance.timeoutMs)) {
    errors.push({
      field: `${field}.timeoutMs`,
      message: "Acceptance timeout must be a positive number",
      fix: "Use a timeout like 120000",
    });
  }
  if (acceptance.steps !== undefined && !Array.isArray(acceptance.steps)) {
    errors.push({
      field: `${field}.steps`,
      message: "Acceptance steps must be an array",
      fix: 'Use "steps": [{ "id": "test", "command": "npm", "args": ["test"] }]',
    });
  }

  if (!hasCommand && !hasSteps && !hasCustom) {
    errors.push({
      field,
      message: "Acceptance must have testCommand, steps[], or custom",
      fix: 'Add "acceptance": { "steps": [{ "id": "test", "command": "npm", "args": ["test"] }] }',
    });
  }

  if (hasCustom) {
    validateCustomJudge(acceptance.custom, `${field}.custom`, errors, repoPath);
  }

  if (hasSteps && hasCommand) {
    warnings.push({
      field,
      message: "Both testCommand and steps defined - steps will be used, testCommand is ignored",
      fix: 'Remove "testCommand" if using steps - having both is confusing',
    });
  }

  if (hasSteps) {
    validateSteps(acceptance.steps as unknown[], `${field}.steps`, errors, repoPath);
  }
}

function validateLegacyCommand(field: string, command: unknown, errors: ValidationError[]): void {
  if (!isNonEmptyString(command)) return;
  if (/[\0\r\n]/.test(command)) {
    errors.push({
      field,
      message: "Legacy shell commands must be a single line",
      fix: 'Use "acceptance.steps" for multiple commands, for example steps for test, build, and lint.',
    });
  }
}

function validateCustomJudge(
  custom: unknown,
  field: string,
  errors: ValidationError[],
  repoPath?: string,
): void {
  if (!isRecord(custom)) {
    errors.push({
      field,
      message: "Custom judge must be an object",
      fix: 'Use "custom": { "script": "./path/to/judge.js" }',
    });
    return;
  }

  if (!isNonEmptyString(custom.script)) {
    errors.push({
      field,
      message: "Custom judge missing required field: script",
      fix: 'Add "script": "./path/to/judge.js"',
    });
  } else if (isAbsolute(custom.script)) {
    errors.push({
      field: `${field}.script`,
      message: "Custom judge script must be relative to the repository root",
      fix: 'Use "script": "scripts/judge.js" instead of an absolute path',
    });
  } else if (
    isNonEmptyString(repoPath) &&
    !isPathInside(resolve(repoPath), resolve(repoPath, custom.script))
  ) {
    errors.push({
      field: `${field}.script`,
      message: "Custom judge script must stay inside the repository",
      fix: 'Use a repository-local script like "scripts/judge.js"',
    });
  }
  if (!isOptionalPositiveNumber(custom.timeoutMs)) {
    errors.push({
      field: `${field}.timeoutMs`,
      message: "Custom judge timeout must be a positive number",
      fix: "Use a timeout like 30000",
    });
  }
  if (custom.env !== undefined && !isStringRecord(custom.env)) {
    errors.push({
      field: `${field}.env`,
      message: "Custom judge env values must be strings",
      fix: 'Use "env": { "NAME": "value" }',
    });
  }
}

function validateSteps(
  steps: unknown[],
  field: string,
  errors: ValidationError[],
  repoPath?: string,
): void {
  const validSteps = steps.filter(isRecord);
  const hasRequiredStep = validSteps.some((step) => step.required !== false);
  if (!hasRequiredStep) {
    errors.push({
      field,
      message: "At least one acceptance step must be required",
      fix: 'Remove "required": false from a step that must pass for the task to be done',
    });
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!isRecord(step)) {
      errors.push({
        field: `${field}[${i}]`,
        message: "Step must be an object",
        fix: 'Use { "id": "test", "command": "npm", "args": ["test"] }',
      });
      continue;
    }

    if (!isNonEmptyString(step.id)) {
      errors.push({
        field: `${field}[${i}].id`,
        message: "Step missing required field: id",
        fix: 'Each step needs "id": "a-unique-name"',
      });
    }
    if (!isNonEmptyString(step.command)) {
      errors.push({
        field: `${field}[${i}].command`,
        message: `Step "${String(step.id ?? "?")}" missing required field: command`,
        fix: 'Each step needs "command": "the-executable"',
      });
    }
    if (step.args !== undefined && !isStringArray(step.args)) {
      errors.push({
        field: `${field}[${i}].args`,
        message: "Step args must be an array of strings",
        fix: 'Use "args": ["run", "test"]',
      });
    }
    if (step.cwd !== undefined && !isNonEmptyString(step.cwd)) {
      errors.push({
        field: `${field}[${i}].cwd`,
        message: "Step cwd must be a non-empty string",
        fix: 'Use "cwd": "packages/app" or omit it',
      });
    } else if (isNonEmptyString(step.cwd)) {
      if (isAbsolute(step.cwd)) {
        errors.push({
          field: `${field}[${i}].cwd`,
          message: "Step cwd must be relative to the repository root",
          fix: 'Use "cwd": "packages/app" instead of an absolute path',
        });
      } else if (
        isNonEmptyString(repoPath) &&
        !isPathInside(resolve(repoPath), resolve(repoPath, step.cwd))
      ) {
        errors.push({
          field: `${field}[${i}].cwd`,
          message: "Step cwd must stay inside the repository",
          fix: 'Use a subdirectory like "packages/app" or omit cwd',
        });
      }
    }
    if (step.required !== undefined && typeof step.required !== "boolean") {
      errors.push({
        field: `${field}[${i}].required`,
        message: "Step required must be true or false",
        fix: 'Use "required": false only for optional checks',
      });
    }
    if (!isOptionalPositiveNumber(step.timeoutMs)) {
      errors.push({
        field: `${field}[${i}].timeoutMs`,
        message: "Step timeout must be a positive number",
        fix: "Use a timeout like 120000",
      });
    }
  }
}

function validateExecution(task: TaskSpec, errors: ValidationError[]): void {
  if (task.execution === undefined) return;
  if (!isRecord(task.execution)) {
    errors.push({
      field: "execution",
      message: "execution must be an object",
      fix: 'Use "execution": { "idleTimeoutMs": 300000 }',
    });
    return;
  }

  for (const field of ["idleTimeoutMs", "softTimeoutMs", "hardTimeoutMs"] as const) {
    const value = task.execution[field];
    if (value !== undefined && !isPositiveNumber(value)) {
      errors.push({
        field: `execution.${field}`,
        message: `${field} must be a positive number`,
        fix: "Use a positive duration in milliseconds",
      });
    }
  }

  const { idleTimeoutMs, softTimeoutMs, hardTimeoutMs } = task.execution;
  if (
    isPositiveNumber(idleTimeoutMs) &&
    isPositiveNumber(softTimeoutMs) &&
    softTimeoutMs >= idleTimeoutMs
  ) {
    errors.push({
      field: "execution.softTimeoutMs",
      message: "softTimeoutMs must be shorter than idleTimeoutMs",
      fix: "Report a stall before the no-output timeout stops the agent",
    });
  }
  if (
    isPositiveNumber(idleTimeoutMs) &&
    isPositiveNumber(hardTimeoutMs) &&
    hardTimeoutMs < idleTimeoutMs
  ) {
    errors.push({
      field: "execution.hardTimeoutMs",
      message: "hardTimeoutMs must be at least idleTimeoutMs",
      fix: "Set the absolute limit above the no-output limit",
    });
  }
}

function validateIntegrity(task: TaskSpec, errors: ValidationError[]): void {
  const integrity = task.integrity;
  if (integrity === undefined) return;
  if (!isRecord(integrity)) {
    errors.push({
      field: "integrity",
      message: "integrity must be an object",
      fix: "Remove it or use an integrity policy object",
    });
    return;
  }
  for (const field of [
    "enabled",
    "allowTestChanges",
    "allowConfigChanges",
    "allowPackageScriptChanges",
  ] as const) {
    const value = integrity[field];
    if (value !== undefined && typeof value !== "boolean") {
      errors.push({
        field: `integrity.${field}`,
        message: `${field} must be true or false`,
        fix: `Use "${field}": true or false`,
      });
    }
  }
  for (const field of ["protectedGlobs", "suspiciousGlobs"] as const) {
    const value = integrity[field];
    if (value !== undefined && !isStringArray(value)) {
      errors.push({
        field: `integrity.${field}`,
        message: `${field} must be an array of strings`,
        fix: `Use "${field}": ["path/**"]`,
      });
    }
  }
}

function validateSemantic(task: TaskSpec, errors: ValidationError[]): void {
  const semantic = task.semantic;
  if (semantic === undefined) return;
  if (!isRecord(semantic)) {
    errors.push({
      field: "semantic",
      message: "semantic must be an object",
      fix: "Use a semantic risk policy object",
    });
    return;
  }
  if (
    semantic.maxRisk !== undefined &&
    !["none", "low", "medium", "high"].includes(semantic.maxRisk)
  ) {
    errors.push({
      field: "semantic.maxRisk",
      message: `Unknown semantic risk level: ${String(semantic.maxRisk)}`,
      fix: 'Use "none", "low", "medium", or "high"',
    });
  }
}

function validateRiskPolicy(task: TaskSpec, errors: ValidationError[]): void {
  if (task.riskPolicy === undefined) return;
  if (!isRecord(task.riskPolicy)) {
    errors.push({
      field: "riskPolicy",
      message: "riskPolicy must be an object",
      fix: 'Use "riskPolicy": { "mode": "confirm" }',
    });
    return;
  }
  if (
    task.riskPolicy.mode !== undefined &&
    !["confirm", "deny", "allow"].includes(String(task.riskPolicy.mode))
  ) {
    errors.push({
      field: "riskPolicy.mode",
      message: "riskPolicy mode must be confirm, deny, or allow",
      fix: 'Use "mode": "confirm" for interactive approval',
    });
  }
  validateRiskCategories(
    task.riskPolicy.approvedCategories,
    "riskPolicy.approvedCategories",
    errors,
  );
  validateRiskCategories(
    task.riskPolicy.declaredCategories,
    "riskPolicy.declaredCategories",
    errors,
  );
}

function validateRiskCategories(value: unknown, field: string, errors: ValidationError[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({
      field,
      message: "Risk categories must be an array",
      fix: 'Use an array such as ["deployment", "production"]',
    });
    return;
  }
  value.forEach((category, index) => {
    if (typeof category !== "string" || !RISK_CATEGORIES.has(category)) {
      errors.push({
        field: `${field}[${index}]`,
        message: `Unknown risk category: ${String(category)}`,
        fix: `Use one of: ${[...RISK_CATEGORIES].join(", ")}`,
      });
    }
  });
}

function validatePlanning(
  task: TaskSpec,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  if (task.planning === undefined) return;
  if (!isRecord(task.planning)) {
    errors.push({
      field: "planning",
      message: "planning must be an object",
      fix: 'Use "planning": { "mode": "auto", "requireApproval": false }',
    });
    return;
  }

  const mode = task.planning.mode;
  if (mode !== undefined && (typeof mode !== "string" || !PLANNING_MODES.has(mode))) {
    errors.push({
      field: "planning.mode",
      message: `Unknown planning mode: ${String(mode)}`,
      fix: `Use one of: ${[...PLANNING_MODES].join(", ")}`,
    });
  }
  if (
    task.planning.requireApproval !== undefined &&
    typeof task.planning.requireApproval !== "boolean"
  ) {
    errors.push({
      field: "planning.requireApproval",
      message: "planning.requireApproval must be true or false",
      fix: 'Use "requireApproval": true or false',
    });
  }
  if (mode === "off" && task.planning.requireApproval === true) {
    warnings.push({
      field: "planning.requireApproval",
      message: "Plan approval has no effect while planning.mode is off",
      fix: 'Use planning mode "auto" or "required", or remove requireApproval',
    });
  }
}

function validateHooks(task: TaskSpec, errors: ValidationError[]): void {
  if (task.hooks === undefined) return;
  if (!Array.isArray(task.hooks)) {
    errors.push({
      field: "hooks",
      message: "hooks must be an array",
      fix: 'Use "hooks": [{ "event": "before_run", "script": "scripts/check.js" }]',
    });
    return;
  }
  if (task.hooks.length > MAX_HOOKS) {
    errors.push({
      field: "hooks",
      message: `hooks cannot contain more than ${MAX_HOOKS} entries`,
      fix: "Combine related checks or remove duplicate hooks",
    });
  }

  task.hooks.slice(0, MAX_HOOKS).forEach((hook, index) => {
    const field = `hooks[${index}]`;
    if (!isRecord(hook)) {
      errors.push({
        field,
        message: "Each hook must be an object",
        fix: 'Use { "event": "before_run", "script": "scripts/check.js" }',
      });
      return;
    }
    if (typeof hook.event !== "string" || !HOOK_EVENTS.has(hook.event)) {
      errors.push({
        field: `${field}.event`,
        message: `Unknown lifecycle hook event: ${String(hook.event)}`,
        fix: `Use one of: ${[...HOOK_EVENTS].join(", ")}`,
      });
    }
    if (typeof hook.script !== "string" || hook.script.trim() === "") {
      errors.push({
        field: `${field}.script`,
        message: "Hook script is required",
        fix: 'Use a repository-relative JavaScript file such as "scripts/check.js"',
      });
    } else {
      const script = hook.script.trim();
      const resolvedScript = resolve(task.repoPath, script);
      if (isAbsolute(script) || !isPathInside(resolve(task.repoPath), resolvedScript)) {
        errors.push({
          field: `${field}.script`,
          message: "Hook script must stay inside the repository",
          fix: "Use a relative path without .. segments",
        });
      } else if (!/\.(?:js|cjs|mjs)$/i.test(script)) {
        errors.push({
          field: `${field}.script`,
          message: "Hook script must be a .js, .cjs, or .mjs file",
          fix: "Use a JavaScript lifecycle check file",
        });
      } else if (!existsSync(resolvedScript) || !statSync(resolvedScript).isFile()) {
        errors.push({
          field: `${field}.script`,
          message: `Hook script does not exist: ${script}`,
          fix: "Create the script inside the repository or correct the relative path",
        });
      }
    }
    if (
      hook.timeoutMs !== undefined &&
      (!Number.isInteger(hook.timeoutMs) || hook.timeoutMs < 100 || hook.timeoutMs > 300_000)
    ) {
      errors.push({
        field: `${field}.timeoutMs`,
        message: "Hook timeoutMs must be a whole number between 100 and 300000",
        fix: "Use a timeout such as 15000",
      });
    }
    if (
      hook.failureMode !== undefined &&
      (typeof hook.failureMode !== "string" || !HOOK_FAILURE_MODES.has(hook.failureMode))
    ) {
      errors.push({
        field: `${field}.failureMode`,
        message: `Unknown hook failure mode: ${String(hook.failureMode)}`,
        fix: 'Use "warn" or "block"',
      });
    }
  });
}

function validateLimits(
  task: TaskSpec,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  if (task.maxIterations !== undefined) {
    if (typeof task.maxIterations !== "number" || !Number.isFinite(task.maxIterations)) {
      errors.push({
        field: "maxIterations",
        message: "maxIterations must be a number",
        fix: "Use a whole number like 5",
      });
    } else if (task.maxIterations < 1 || task.maxIterations > 20) {
      warnings.push({
        field: "maxIterations",
        message: `maxIterations=${task.maxIterations} is unusual (typical: 3-7)`,
        fix: "Set between 3-7 for best results - more iterations = more cost",
      });
    }
  }

  if (task.maxBudgetUsd !== undefined) {
    if (typeof task.maxBudgetUsd !== "number" || !Number.isFinite(task.maxBudgetUsd)) {
      errors.push({
        field: "maxBudgetUsd",
        message: "maxBudgetUsd must be a number",
        fix: "Use a number like 5",
      });
    } else if (task.maxBudgetUsd < 0.5) {
      warnings.push({
        field: "maxBudgetUsd",
        message: `maxBudgetUsd=$${task.maxBudgetUsd} is very low - run may abort early`,
        fix: "Set at least $1.00 for a single iteration to complete",
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isOptionalPositiveNumber(value: unknown): boolean {
  return value === undefined || isPositiveNumber(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isPositiveNumber(value) && Number.isInteger(value);
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(basePath), resolve(targetPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
