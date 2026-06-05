import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
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

const REQUIRED_FIELDS = ["id", "goal", "repoPath"] as const;

export function validateTaskSpec(task: TaskSpec, taskFilePath: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  // Required fields
  for (const field of REQUIRED_FIELDS) {
    if (!task[field as keyof TaskSpec]) {
      errors.push({
        field,
        message: `Missing required field: ${field}`,
        fix: `Add "${field}": "..." to ${taskFilePath}`,
      });
    }
  }

  // id format
  if (task.id && !/^[a-zA-Z0-9_-]+$/.test(task.id)) {
    warnings.push({
      field: "id",
      message: `Task id "${task.id}" contains special characters`,
      fix: "Use only alphanumeric, hyphens, and underscores (e.g., fix-auth-bug)",
    });
  }

  // repoPath / repoPaths existence
  if (task.repoPaths && task.repoPaths.length > 0) {
    // Multi-repo mode
    for (let i = 0; i < task.repoPaths.length; i++) {
      const rp = task.repoPaths[i];
      const resolvedPath = resolve(rp);
      if (!existsSync(resolvedPath)) {
        errors.push({
          field: `repoPaths[${i}]`,
          message: `Repository path does not exist: ${resolvedPath}`,
          fix: "Check the path — it must be an existing directory",
        });
      } else if (!statSync(resolvedPath).isDirectory()) {
        errors.push({
          field: `repoPaths[${i}]`,
          message: `Not a directory: ${resolvedPath}`,
          fix: "Each repoPath must point to a directory",
        });
      } else {
        const gitDir = resolve(resolvedPath, ".git");
        if (!existsSync(gitDir)) {
          errors.push({
            field: `repoPaths[${i}]`,
            message: `Not a git repository: ${resolvedPath}`,
            fix: `Run "git init" in ${resolvedPath} first`,
          });
        }
      }
    }
  } else if (task.repoPath) {
    const resolvedPath = resolve(task.repoPath);
    if (!existsSync(resolvedPath)) {
      errors.push({
        field: "repoPath",
        message: `Repository path does not exist: ${resolvedPath}`,
        fix: "Check the repoPath in your task file — it must be an existing directory",
      });
    } else if (!statSync(resolvedPath).isDirectory()) {
      errors.push({
        field: "repoPath",
        message: `repoPath is not a directory: ${resolvedPath}`,
        fix: "repoPath must point to a directory, not a file",
      });
    } else {
      // Check if it's a git repo
      const gitDir = resolve(resolvedPath, ".git");
      if (!existsSync(gitDir)) {
        errors.push({
          field: "repoPath",
          message: `Not a git repository: ${resolvedPath}`,
          fix: `Run "git init" in ${resolvedPath} first — Verdikt needs git for worktree isolation`,
        });
      }
    }
  }

  // goal quality
  if (task.goal) {
    if (task.goal.length < 20) {
      warnings.push({
        field: "goal",
        message: "Goal is very short — executor may lack direction",
        fix: "Describe what to fix/implement and any constraints (aim for 1-3 sentences)",
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

  // acceptance
  if (!task.acceptance) {
    errors.push({
      field: "acceptance",
      message: "No acceptance criteria defined",
      fix: 'Add "acceptance": { "steps": [{ "id": "test", "command": "npm", "args": ["test"] }] }',
    });
  } else {
    const hasCommand = !!task.acceptance.testCommand;
    const hasSteps = Array.isArray(task.acceptance.steps) && task.acceptance.steps.length > 0;
    const hasCustom = !!task.acceptance.custom;
    if (!hasCommand && !hasSteps && !hasCustom) {
      errors.push({
        field: "acceptance",
        message: "Acceptance must have testCommand, steps[], or custom",
        fix: 'Add "acceptance": { "steps": [{ "id": "test", "command": "npm", "args": ["test"] }] }',
      });
    }
    if (hasCustom && task.acceptance.custom) {
      const custom = task.acceptance.custom;
      if (!custom.script) {
        errors.push({
          field: "acceptance.custom",
          message: "Custom judge missing required field: script",
          fix: 'Add "script": "./path/to/judge.js"',
        });
      }
    }
    if (hasSteps && hasCommand) {
      warnings.push({
        field: "acceptance",
        message: "Both testCommand and steps defined — steps will be used, testCommand is ignored",
        fix: 'Remove "testCommand" if using steps — having both is confusing',
      });
    }
    // Validate steps
    if (hasSteps && task.acceptance.steps) {
      for (const step of task.acceptance.steps) {
        if (!step.id) {
          errors.push({
            field: "acceptance.steps",
            message: "Step missing required field: id",
            fix: 'Each step needs "id": "a-unique-name"',
          });
        }
        if (!step.command) {
          errors.push({
            field: "acceptance.steps",
            message: `Step "${step.id ?? "?"}" missing required field: command`,
            fix: 'Each step needs "command": "the-executable"',
          });
        }
      }
    }
  }

  // maxIterations
  if (task.maxIterations !== undefined) {
    if (task.maxIterations < 1 || task.maxIterations > 20) {
      warnings.push({
        field: "maxIterations",
        message: `maxIterations=${task.maxIterations} is unusual (typical: 3-7)`,
        fix: "Set between 3-7 for best results — more iterations = more cost",
      });
    }
  }

  // maxBudgetUsd
  if (task.maxBudgetUsd !== undefined && task.maxBudgetUsd < 0.5) {
    warnings.push({
      field: "maxBudgetUsd",
      message: `maxBudgetUsd=$${task.maxBudgetUsd} is very low — run may abort early`,
      fix: "Set at least $1.00 for a single iteration to complete",
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}
