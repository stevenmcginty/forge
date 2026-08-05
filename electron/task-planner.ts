import { MAX_TASK_CARDS, MAX_TASK_TEXT } from '@shared/ipc'

/**
 * The ```tasks fence parser.
 *
 * The delegation tray used to plan by handing a goal to `claude -p` for a
 * headless turn; that brain is gone now that planning happens live in a
 * terminal pane (see electron/planner-watcher.ts). What's left here is the
 * one piece both the old brain and the new watcher needed: turning a model's
 * reply — plan prose plus a JSON task list, however it's fenced — into
 * cards the renderer can deal out.
 */

/** More briefs than a hand can hold stops being a plan and starts being noise. */
const PLAN_MAX_TASKS = 8

/** A parsed plan: the prose (when the model sent one) plus the task briefs. */
type ParsedPlan = { plan: string | null; tasks: string[] }

function cleanTasks(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const tasks = value
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().slice(0, MAX_TASK_TEXT))
    .filter((t) => t.length > 0)
    .slice(0, Math.min(PLAN_MAX_TASKS, MAX_TASK_CARDS))
  return tasks.length > 0 ? tasks : null
}

/**
 * Pull the {plan, tasks} object out of a model reply that was told to send
 * exactly that — and that will, some days, wrap it in fences anyway. A bare
 * array of tasks (the old contract, and a stubborn model's favourite) still
 * parses; it just arrives without prose.
 */
export function parsePlan(stdout: string): ParsedPlan | null {
  const text = stdout.trim()

  const objStart = text.indexOf('{')
  const objEnd = text.lastIndexOf('}')
  if (objStart !== -1 && objEnd > objStart) {
    try {
      const parsed: unknown = JSON.parse(text.slice(objStart, objEnd + 1))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const { plan, tasks } = parsed as { plan?: unknown; tasks?: unknown }
        const cleaned = cleanTasks(tasks)
        if (cleaned) {
          return {
            plan: typeof plan === 'string' && plan.trim() ? plan.trim().slice(0, MAX_TASK_TEXT) : null,
            tasks: cleaned
          }
        }
      }
    } catch {
      // Fall through: the reply may still contain a usable bare array.
    }
  }

  const arrStart = text.indexOf('[')
  const arrEnd = text.lastIndexOf(']')
  if (arrStart === -1 || arrEnd <= arrStart) return null
  try {
    const cleaned = cleanTasks(JSON.parse(text.slice(arrStart, arrEnd + 1)))
    return cleaned ? { plan: null, tasks: cleaned } : null
  } catch {
    return null
  }
}
