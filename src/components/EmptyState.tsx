import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import './EmptyState.css'

/**
 * The house style for "there is nothing here yet": a machined glyph plate, a
 * short line of ink, one muted sentence, and at most one call to action.
 */
export function EmptyState({
  icon,
  eyebrow,
  title,
  body,
  action,
  hint,
  size = 'md'
}: {
  icon: IconName
  eyebrow?: string
  title: string
  body?: ReactNode
  action?: ReactNode
  hint?: ReactNode
  size?: 'sm' | 'md'
}): ReactNode {
  return (
    <div className="empty" data-size={size}>
      <div className="empty__plate">
        <Icon name={icon} size={size === 'sm' ? 16 : 20} />
      </div>
      {eyebrow ? <div className="eyebrow empty__eyebrow">{eyebrow}</div> : null}
      <h2 className="empty__title">{title}</h2>
      {body ? <p className="empty__body">{body}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
      {hint ? <div className="empty__hint mono">{hint}</div> : null}
    </div>
  )
}
