# Verdikt Design Standards

## Interface Character

Verdikt is operational software. It should feel like a calm local control room, not a marketing page or decorative dashboard. Density is acceptable when it helps scanning. Decoration is not.

## Layout

- Keep the primary screen split between task setup and live supervision.
- The live area must always expose executor, judge, and verifier state.
- Repeated historical items should be compact, searchable, and filterable.
- Avoid nested cards. Use panels only for major work areas and repeated run items.

## Components

- Buttons should describe clear commands: start, stop, view, edit, retry, apply, discard, pin, archive.
- Risk and status labels must use consistent colors:
  - green for passed or safe,
  - yellow for warning or medium risk,
  - red for failed or high risk,
  - blue for active/running.
- Long paths, goals, and agent output must wrap safely.

## Copy

- Use direct Chinese labels in the app.
- Explain consequences before destructive or irreversible actions.
- Avoid vague success language. Prefer concrete states like "waiting for patch review", "judge failed", or "verifier requested another round".

## Power User Bias

- Optimize for repeated daily use.
- Prefer persistent workbench controls over one-off dialogs.
- Keep keyboard and dense desktop workflows in mind for future iterations.
